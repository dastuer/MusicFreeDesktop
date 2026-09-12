import fs from "fs";
import path from "path";
import { app, session } from "electron";
import coverCache, { isCoverFileName } from "./coverCache";
import downloadService from "./downloadService";
import configStore from "./configStore";
import mediaCache from "./mediaCache";

/**
 * 应用缓存统计与清理。
 *
 * 只统计「删掉不影响用户数据」的东西，歌单、本地音乐列表、设置这些都存在
 * data/store.json 里，属于用户数据，绝不在缓存清理范围内。
 *
 * 四类：
 *   cover   封面缩略图（data/covers），删了会在下次扫描 / 播放时自动重建
 *   http    Chromium 的 HTTP 磁盘缓存，删了只是下次加载慢一点
 *   temp    下载中断残留的 .part 文件
 *   storage localStorage / IndexedDB 等浏览数据 —— 播放列表就存在这里，
 *           清掉会重置界面状态，所以标为 risky，清理前必须二次确认
 */

export type CacheKey = "media" | "cover" | "http" | "temp" | "storage";

export interface CacheCategory {
    key: CacheKey;
    label: string;
    desc: string;
    size: number;
    /** 文件数；HTTP 缓存由 Chromium 内部管理，拿不到文件数，为 null */
    count: number | null;
    risky: boolean;
    /** 点「清除」实际能释放多少。封面缓存只删无人引用的残留，通常远小于 size */
    clearable: number;
}

export interface CacheInfo {
    total: number;
    categories: CacheCategory[];
}

const CATEGORY_META: Record<CacheKey, { label: string; desc: string; risky: boolean }> = {
    media: {
        label: "播放缓存",
        desc: "播过的在线音乐，命中后直接从磁盘播放，不再请求音源",
        risky: false,
    },
    cover: {
        label: "封面缓存",
        desc: "本地音乐与音源封面的缩略图。清除只删除无人引用的残留，正在显示的封面不会受影响",
        risky: false,
    },
    http: {
        label: "网络缓存",
        desc: "播放与插件请求产生的 HTTP 缓存，清除后首次加载会稍慢",
        risky: false,
    },
    temp: {
        label: "下载临时文件",
        desc: "下载中断残留的 .part 文件，可安全清除",
        risky: false,
    },
    storage: {
        label: "本地存储",
        desc: "播放列表、搜索记录与界面偏好（localStorage / IndexedDB），清除后需重启应用生效",
        risky: true,
    },
};

/**
 * 从一段 JSON 文本里抓出所有 `mfs://cover/<file>` 短链的文件名。
 * 用来判断哪些封面「正在被引用」——被引用的一个都不能删。
 */
function collectRefs(text: string, out = new Set<string>()): Set<string> {
    const re = /mfs:\/\/cover\/([A-Za-z0-9._-]+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
        out.add(match[1]);
    }
    return out;
}

const ORDER: CacheKey[] = ["media", "cover", "http", "temp", "storage"];

/**
 * 限量并发。目录里可能有上千个文件，
 * 直接 Promise.all 会把文件句柄一次性打满（EMFILE）。
 */
async function mapLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const out = new Array<R>(items.length);
    let cursor = 0;
    const worker = async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            out[index] = await fn(items[index]);
        }
    };
    if (!items.length) {
        return out;
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return out;
}

/** 递归统计目录体积与文件数。读不到就当 0，不因为一个无权限目录让整次统计失败 */
async function dirStats(dir: string, limit = 32): Promise<{ size: number; count: number }> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        return { size: 0, count: 0 };
    }
    const parts = await mapLimit(entries, limit, async (entry): Promise<{ size: number; count: number }> => {
        if (entry.isDirectory()) {
            return dirStats(path.join(dir, entry.name), limit);
        }
        if (entry.isSymbolicLink()) {
            return { size: 0, count: 0 };
        }
        try {
            return { size: (await fs.promises.lstat(path.join(dir, entry.name))).size, count: 1 };
        } catch {
            return { size: 0, count: 0 };
        }
    });
    return parts.reduce((acc, cur) => ({ size: acc.size + cur.size, count: acc.count + cur.count }), {
        size: 0,
        count: 0,
    });
}

/** 删除文件列表，返回成功删除的数量。单个失败不影响其余文件 */
async function unlinkAll(files: string[], limit = 16): Promise<number> {
    const results = await mapLimit(files, limit, async (file): Promise<number> => {
        try {
            await fs.promises.unlink(file);
            return 1;
        } catch {
            return 0;
        }
    });
    return results.reduce((a, b) => a + b, 0);
}

async function listDir(dir: string): Promise<string[]> {
    try {
        return await fs.promises.readdir(dir);
    } catch {
        return [];
    }
}

/** 下载目录里没人认领的 .part 文件（进行中/排队中的任务要保留） */
async function orphanParts(): Promise<{ files: string[]; size: number }> {
    const dir = downloadService.getDownloadDir();
    const active = new Set(downloadService.getActiveTaskIds());
    const names = (await listDir(dir)).filter(
        (name) => name.endsWith(".part") && !active.has(name.slice(0, -".part".length)),
    );
    const sizes = await mapLimit(names, 16, async (name) => {
        try {
            return (await fs.promises.lstat(path.join(dir, name))).size;
        } catch {
            return 0;
        }
    });
    return {
        files: names.map((name) => path.join(dir, name)),
        size: sizes.reduce((a, b) => a + b, 0),
    };
}

/**
 * HTTP 磁盘缓存大小。
 * 走 session.getCacheSize() 而不是扫 userData/Cache 目录：
 * 后者是 Chromium 的内部结构（block file + index），正被占用时删不干净，
 * 用官方 API 才能清干净、也能让统计口径和清理口径一致。
 */
async function httpCacheSize(): Promise<number> {
    try {
        const size = await session.defaultSession.getCacheSize();
        return typeof size === "number" ? size : 0;
    } catch {
        return 0;
    }
}

class CacheManager {
    /**
     * 主进程侧能看到的封面引用（本地音乐列表、播放历史、歌单、下载任务）。
     * 渲染进程的播放列表存在 localStorage 里，主进程看不到，由调用方补进来。
     */
    private storeRefs(): Set<string> {
        try {
            return collectRefs(JSON.stringify(configStore.getAll()));
        } catch {
            // store 大到 stringify 不了时退化：至少保住本地音乐列表里的封面
            try {
                return collectRefs(JSON.stringify(configStore.get("localMusic.list", [])));
            } catch {
                return new Set<string>();
            }
        }
    }

    /** 缓存总览：每类的体积、文件数与「实际可清理」体积 */
    async getInfo(): Promise<CacheInfo> {
        const covers = await dirStats(coverCache.getDir());
        const parts = await orphanParts();
        const http = await httpCacheSize();
        const storage = await this.storageStats();
        const media = await mediaCache.stats();
        // 正在使用的封面不能被清理，单独算出来给界面显示，
        // 否则用户点了「清除」发现体积没变，会以为坏了
        const clearableCover = await this.clearableCovers();

        const sizeOf: Record<CacheKey, number> = {
            media: media.size,
            cover: covers.size,
            http,
            temp: parts.size,
            storage: storage.size,
        };
        const countOf: Record<CacheKey, number | null> = {
            media: media.complete,
            cover: covers.count,
            http: null,
            temp: parts.files.length,
            storage: null,
        };
        const clearableOf: Record<CacheKey, number> = {
            media: media.size,
            cover: clearableCover,
            http,
            temp: parts.size,
            storage: storage.size,
        };

        return {
            total: ORDER.reduce((sum, key) => sum + sizeOf[key], 0),
            categories: ORDER.map((key) => ({
                key,
                label: CATEGORY_META[key].label,
                desc: CATEGORY_META[key].desc,
                size: sizeOf[key],
                count: countOf[key],
                risky: CATEGORY_META[key].risky,
                clearable: clearableOf[key],
            })),
        };
    }

    /** 无人引用的封面文件占多大 */
    private async clearableCovers(): Promise<number> {
        const names = await listDir(coverCache.getDir());
        if (!names.length) {
            return 0;
        }
        const refs = this.storeRefs();
        const sizes = await mapLimit(names, 32, async (name): Promise<number> => {
            if (refs.has(name) || !isCoverFileName(name)) {
                return 0;
            }
            try {
                return (await fs.promises.lstat(path.join(coverCache.getDir(), name))).size;
            } catch {
                return 0;
            }
        });
        return sizes.reduce((a, b) => a + b, 0);
    }

    /** 浏览数据目录体积（Local Storage / Session Storage / IndexedDB / WebStorage） */
    private async storageStats(): Promise<{ size: number }> {
        const userData = app.getPath("userData");
        const dirs = ["Local Storage", "Session Storage", "IndexedDB", "WebStorage"];
        const parts = await mapLimit(dirs, 4, (dir) => dirStats(path.join(userData, dir)));
        return { size: parts.reduce((sum, cur) => sum + cur.size, 0) };
    }

    /**
     * 清理指定类别，返回每类实际释放的字节数。
     * 用「清理前重新统计」而不是复用界面上显示的数字：用户可能隔了很久才点，
     * 期间缓存早就变了，按旧数字汇报会骗人。
     */
    async clear(keys: CacheKey[], extraRefs: string[] = []): Promise<Record<string, number>> {
        const freed: Record<string, number> = {};
        const wanted = new Set(keys);

        if (wanted.has("media")) {
            freed.media = await mediaCache.clear();
        }

        if (wanted.has("cover")) {
            const refs = this.storeRefs();
            for (const name of extraRefs) {
                refs.add(name);
            }
            freed.cover = (await coverCache.pruneUnreferenced(refs)).freed;
        }

        if (wanted.has("http")) {
            const before = await httpCacheSize();
            try {
                await session.defaultSession.clearCache();
                await session.defaultSession.clearHostResolverCache();
                // V8 code cache，Electron 11+ 才有
                await (session.defaultSession as any).clearCodeCaches?.({ urls: [] });
            } catch {
                // 清不掉就算了，下次启动 Chromium 自己会淘汰
            }
            freed.http = Math.max(0, before - (await httpCacheSize()));
        }

        if (wanted.has("temp")) {
            const { files, size } = await orphanParts();
            const deleted = await unlinkAll(files);
            freed.temp = files.length ? Math.round((size * deleted) / files.length) : 0;
        }

        if (wanted.has("storage")) {
            const before = await this.storageStats();
            try {
                // 注意 Electron 这里是 indexdb（不是 indexeddb），且不支持清 sessionstorage
                await session.defaultSession.clearStorageData({
                    storages: [
                        "localstorage",
                        "indexdb",
                        "websql",
                        "serviceworkers",
                        "cachestorage",
                        "shadercache",
                    ],
                });
            } catch {
                // ignore
            }
            freed.storage = Math.max(0, before.size - (await this.storageStats()).size);
        }

        return freed;
    }

    /** 封面缓存目录路径，供「在访达中查看」使用；不存在时返回空串 */
    getCoverDir(): string {
        const dir = coverCache.getDir();
        return dir && fs.existsSync(dir) ? dir : "";
    }
}

export default new CacheManager();
