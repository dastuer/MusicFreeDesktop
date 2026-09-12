import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * 播放缓存：把播过的在线音乐落到 data/mediaCache，下次直接从磁盘读。
 *
 * 之前 `mfs://media` 是纯转发代理，一个字节都不写盘，而且 axios 在主进程 Node 侧，
 * 连 Chromium 的 HTTP 缓存都吃不到。结果是同一首歌每次播放都完整重新下载一遍，
 * 拖进度条再发一次 Range 请求再下一遍——音源一慢就卡。
 *
 * 三个关键决定：
 *
 * 1. **缓存键用「平台 + 歌曲 id + 音质」，不用 URL**。音源每次解析出来的直链可能带
 *    签名/时效参数，按 URL 做键等于永远命中不了。
 * 2. **只缓存「从头开始」的请求**。拖动进度条时客户端要的是 bytes=N-，
 *    为这 2 MB 去下整首歌不划算；没缓存时直接透传，有缓存时走磁盘。
 * 3. **半成品保留 + 续传**。切歌留下的 .part 记着已收字节，下次从断点继续
 *    （前提是上游支持 Range）；上游不认 Range 就从头重写。
 */

export interface MediaCacheMeta {
    key: string;
    platform: string;
    id: string;
    quality: string;
    /** 整首歌的字节数（上游给的 content-length） */
    total: number;
    /** 已落盘字节数 */
    received: number;
    contentType: string;
    createdAt: number;
    updatedAt: number;
}

export const DEFAULT_MEDIA_CACHE_LIMIT = 2 * 1024 * 1024 * 1024;

const COMPLETE_EXT = ".bin";
const PART_EXT = ".part";
const META_EXT = ".json";

function hashOf(platform: string, id: string, quality: string) {
    return crypto
        .createHash("md5")
        .update(`${platform}|${id}|${quality}`)
        .digest("hex");
}

class MediaCache {
    private dir = "";
    private limit = DEFAULT_MEDIA_CACHE_LIMIT;
    /** 正在写入的键，防止同一首歌被两个请求同时写坏 */
    private busy = new Set<string>();

    setup(dataDir: string) {
        this.dir = path.join(dataDir, "mediaCache");
    }

    getDir() {
        return this.dir;
    }

    getLimit() {
        return this.limit;
    }

    /** 上限字节数，0 表示关闭缓存 */
    setLimit(bytes: number) {
        this.limit = Math.max(0, Math.floor(bytes));
    }

    isEnabled() {
        return !!this.dir && this.limit > 0;
    }

    async ensureDir() {
        try {
            await fs.promises.mkdir(this.dir, { recursive: true });
        } catch {
            // 建不出目录就退化成不缓存
        }
    }

    hash(platform: string, id: string, quality: string) {
        return hashOf(platform, id, quality);
    }

    completePath(hash: string) {
        return path.join(this.dir, hash + COMPLETE_EXT);
    }

    partPath(hash: string) {
        return path.join(this.dir, hash + PART_EXT);
    }

    metaPath(hash: string) {
        return path.join(this.dir, hash + META_EXT);
    }

    readMeta(hash: string): MediaCacheMeta | null {
        try {
            const raw = fs.readFileSync(this.metaPath(hash), "utf-8");
            const meta = JSON.parse(raw) as MediaCacheMeta;
            return meta && typeof meta.received === "number" ? meta : null;
        } catch {
            return null;
        }
    }

    writeMeta(hash: string, meta: MediaCacheMeta) {
        try {
            meta.updatedAt = Date.now();
            fs.writeFileSync(this.metaPath(hash), JSON.stringify(meta), "utf-8");
        } catch {
            // 元数据写失败不影响播放
        }
    }

    /** 整首已缓存且文件还在 —— 可以完全离线播放 */
    hasComplete(hash: string): boolean {
        const meta = this.readMeta(hash);
        if (!meta || meta.total <= 0 || meta.received < meta.total) {
            return false;
        }
        return fs.existsSync(this.completePath(hash));
    }

    /** 已落盘、可以续传的字节数；0 表示得从头开始 */
    resumableBytes(hash: string): number {
        const meta = this.readMeta(hash);
        if (!meta || meta.received <= 0) {
            return 0;
        }
        if (meta.total > 0 && meta.received >= meta.total) {
            return 0;
        }
        try {
            const stat = fs.statSync(this.partPath(hash));
            // 元数据说有 5 MB 但文件只有 2 MB——以文件实际大小为准，否则续传会错位
            return Math.min(stat.size, meta.received);
        } catch {
            return 0;
        }
    }

    touch(hash: string) {
        const meta = this.readMeta(hash);
        if (meta) {
            this.writeMeta(hash, meta);
        }
    }

    /** 标记「正在写」，返回 false 表示已有请求在写，本次不要落盘 */
    acquire(hash: string): boolean {
        if (this.busy.has(hash)) {
            return false;
        }
        this.busy.add(hash);
        return true;
    }

    release(hash: string) {
        this.busy.delete(hash);
    }

    /**
     * 一帧写完后更新状态。收满就转正（.part -> .bin），没收满就记下断点下次续。
     */
    async finalize(hash: string, received: number, total: number) {
        try {
            const meta = this.readMeta(hash) ?? {
                key: hash,
                platform: "",
                id: "",
                quality: "",
                total: 0,
                received: 0,
                contentType: "",
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            meta.received = received;
            meta.total = total > 0 ? total : received;
            if (received > 0 && received >= meta.total) {
                try {
                    await fs.promises.rename(this.partPath(hash), this.completePath(hash));
                } catch {
                    // 改名失败就当没缓存，下次重来
                }
            }
            this.writeMeta(hash, meta);
        } finally {
            this.release(hash);
        }
        await this.evict();
    }

    /** 缓存统计：磁盘实际占用、完整首数、半成品数 */
    async stats(): Promise<{ size: number; complete: number; partial: number }> {
        let entries: string[];
        try {
            entries = await fs.promises.readdir(this.dir);
        } catch {
            return { size: 0, complete: 0, partial: 0 };
        }
        let size = 0;
        let complete = 0;
        let partial = 0;
        for (const name of entries) {
            if (name.endsWith(COMPLETE_EXT)) {
                complete += 1;
            } else if (name.endsWith(PART_EXT)) {
                partial += 1;
            }
            try {
                size += (await fs.promises.lstat(path.join(this.dir, name))).size;
            } catch {
                // ignore
            }
        }
        return { size, complete, partial };
    }

    /** 清空播放缓存 */
    async clear(): Promise<number> {
        let entries: string[];
        try {
            entries = await fs.promises.readdir(this.dir);
        } catch {
            return 0;
        }
        let freed = 0;
        for (const name of entries) {
            try {
                const stat = await fs.promises.lstat(path.join(this.dir, name));
                await fs.promises.unlink(path.join(this.dir, name));
                freed += stat.size;
            } catch {
                // ignore
            }
        }
        return freed;
    }

    /**
     * LRU 淘汰：超过上限就从最久没碰过的开始删，删到低于上限为止。
     * 每次写完调一次，避免后台静默膨胀。
     */
    async evict(): Promise<number> {
        if (!this.limit || !this.dir) {
            return 0;
        }
        let entries: string[];
        try {
            entries = await fs.promises.readdir(this.dir);
        } catch {
            return 0;
        }
        const metas = entries.filter((n) => n.endsWith(META_EXT));
        if (!metas.length) {
            return 0;
        }
        const items: { hash: string; updatedAt: number }[] = [];
        let total = 0;
        for (const name of entries) {
            try {
                total += (await fs.promises.lstat(path.join(this.dir, name))).size;
            } catch {
                // ignore
            }
        }
        if (total <= this.limit) {
            return 0;
        }
        for (const name of metas) {
            const hash = name.slice(0, -META_EXT.length);
            if (this.busy.has(hash)) {
                continue;
            }
            const meta = this.readMeta(hash);
            items.push({ hash, updatedAt: meta?.updatedAt ?? 0 });
        }
        items.sort((a, b) => a.updatedAt - b.updatedAt);

        let freed = 0;
        for (const item of items) {
            if (total <= this.limit) {
                break;
            }
            for (const p of [
                this.completePath(item.hash),
                this.partPath(item.hash),
                this.metaPath(item.hash),
            ]) {
                try {
                    const stat = await fs.promises.lstat(p);
                    await fs.promises.unlink(p);
                    total -= stat.size;
                    freed += stat.size;
                } catch {
                    // 文件不存在（例如只有 .bin 没有 .part）
                }
            }
        }
        return freed;
    }
}

export default new MediaCache();
