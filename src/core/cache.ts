import { atom, getDefaultStore } from "jotai";
import { ipcInvoke } from "./ipc";

/** 设置页「存储与缓存」：读取缓存占用、按类别清除 */

/**
 * 封面版本号：重建封面后自增。
 * 封面组件会把它一起参与"src 变化"的判断，否则已经加载失败过的封面
 * 不会重新去取文件——用户点了「重建」，列表和播放栏却还是音符占位图。
 */
export const coverVersionAtom = atom(0);

function bumpCoverVersion() {
    const store = getDefaultStore();
    store.set(coverVersionAtom, store.get(coverVersionAtom) + 1);
}

export type CacheKey = "media" | "cover" | "http" | "temp" | "storage";

export interface CacheCategory {
    key: CacheKey;
    label: string;
    desc: string;
    size: number;
    /** 文件数；HTTP 缓存由 Chromium 内部管理，拿不到文件数 */
    count: number | null;
    risky: boolean;
    /** 点「清除」实际能释放多少。封面缓存只删无人引用的残留，通常远小于 size */
    clearable: number;
}

export interface CacheInfo {
    total: number;
    categories: CacheCategory[];
}

export interface ClearCacheResult {
    success: boolean;
    canceled?: boolean;
    /** 没有任何可清理的内容，连确认弹窗都没弹 */
    empty?: boolean;
    message?: string;
    freed?: Record<string, number>;
    freedTotal?: number;
}

export function getCacheInfo(): Promise<CacheInfo> {
    return ipcInvoke<CacheInfo>("cache:info");
}

/**
 * 主进程看不到渲染进程的 localStorage，而当前播放列表就存在那儿。
 * 清理前把它引用的封面文件名一起交上去，否则正在播放的封面会被当成残留删掉。
 */
function collectRendererCoverRefs(): string[] {
    const refs = new Set<string>();
    try {
        const re = /mfs:\/\/cover\/([A-Za-z0-9._-]+)/g;
        for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (!key) {
                continue;
            }
            const value = localStorage.getItem(key) ?? "";
            let match: RegExpExecArray | null;
            while ((match = re.exec(value))) {
                refs.add(match[1]);
            }
        }
    } catch {
        // 读不到就算了，最多多删几张可重建的封面
    }
    return [...refs];
}

export function clearCache(keys: CacheKey[]): Promise<ClearCacheResult> {
    return ipcInvoke<ClearCacheResult>("cache:clear", keys, collectRendererCoverRefs());
}

/** 重新生成本地音乐封面（封面缓存被清空后用来恢复），返回处理的条目数 */
export async function rebuildLocalCovers(onlyMissing = true): Promise<{
    success: boolean;
    message?: string;
    data?: { checked: number; updated: number; missingFile: number };
}> {
    const res = await ipcInvoke<{
        success: boolean;
        message?: string;
        data?: { checked: number; updated: number; missingFile: number };
    }>("localMusic:rebuildCovers", onlyMissing);
    // 重建成功后让已挂载的封面组件重新取图（否则它们还停在失败占位图上）
    if (res?.success && (res.data?.updated ?? 0) > 0) {
        bumpCoverVersion();
    }
    return res;
}

export function openCoverCacheDir(): Promise<string> {
    return ipcInvoke<string>("cache:openDir");
}

/** 字节 -> 人类可读。10 以下保留一位小数，更大的整数直读，避免一串无意义的小数位 */
export function formatSize(bytes: number): string {
    if (!bytes || bytes < 0) {
        return "0 B";
    }
    if (bytes < 1024) {
        return `${Math.round(bytes)} B`;
    }
    const kb = bytes / 1024;
    if (kb < 1024) {
        return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    }
    const mb = kb / 1024;
    if (mb < 1024) {
        return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
    }
    return `${(mb / 1024).toFixed(2)} GB`;
}

/** 条形图配色，与 CacheKey 一一对应 */
export const CACHE_COLORS: Record<CacheKey, string> = {
    media: "#7f77dd",
    cover: "#4c8dff",
    http: "#3ec9a7",
    temp: "#f5a623",
    storage: "#ec4141",
};

/** 播放缓存容量上限（字节）。0 = 关闭缓存，其余值超出后按最久未播放淘汰 */
export function getMediaCacheLimit(): Promise<number> {
    return ipcInvoke<number>("mediaCache:getLimit");
}

export function setMediaCacheLimit(bytes: number): Promise<number> {
    return ipcInvoke<number>("mediaCache:setLimit", bytes);
}

/** 可选上限档位，界面直接遍历 */
export const MEDIA_CACHE_LIMIT_OPTIONS: { label: string; bytes: number }[] = [
    { label: "关闭", bytes: 0 },
    { label: "1 GB", bytes: 1024 ** 3 },
    { label: "2 GB", bytes: 2 * 1024 ** 3 },
    { label: "5 GB", bytes: 5 * 1024 ** 3 },
    { label: "10 GB", bytes: 10 * 1024 ** 3 },
];
