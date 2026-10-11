import { SerializedPlugin } from "./ipc";
import { INeteaseSong } from "./netease";

/**
 * 网易云歌曲 → 音源曲目 的匹配结果缓存（localStorage 持久化）。
 *
 * 每次匹配优先查缓存：命中直接出结果（要求该曲目所属音源插件当前仍启用且挂载，
 * 否则视为失效重新匹配），未命中才走插件逐首搜索。搜到的新命中会写回缓存。
 *
 * 属可重建的派生数据：刻意存 localStorage 且不进备份（不在 PREF_KEYS 白名单），
 * 不进 store.json（避免加重其全量写盘），可随时在设置里清除。
 */

const CACHE_KEY = "neteaseMatchCache.v1";
/** 容量上限：超出时按 cachedAt 淘汰最旧的，防止 localStorage 无限膨胀 */
const MAX_ENTRIES = 5000;
const SAVE_DELAY = 800;

export interface ICachedMatch {
    item: IMusic.IMusicItem;
    score: number;
    viaDetail?: boolean;
    cachedAt: number;
    /** 曲目指纹（歌名/歌手/专辑/时长），曲目变了缓存即失效，见 fingerprintOf */
    fp?: string;
    /**
     * 写入时已通过 getMediaSource 可播性探测。旧版本写入的条目没有这个标记，
     * 命中时要补验一次，播不了的当作未命中重新匹配（见 matchNeteaseSongs）。
     */
    verified?: boolean;
}

let cache: Record<string, ICachedMatch> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Record<string, ICachedMatch> {
    if (cache) {
        return cache;
    }
    try {
        const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}");
        cache = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        cache = {};
    }
    return cache!;
}

function scheduleSave() {
    if (saveTimer) {
        return;
    }
    saveTimer = setTimeout(() => {
        saveTimer = null;
        flushMatchCache();
    }, SAVE_DELAY);
}

/** 立即落盘（localStorage 同步写，量大会卡一帧，所以平时走防抖） */
export function flushMatchCache() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    if (!cache) {
        return;
    }
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
        // 存储满等异常：缓存丢弃不影响主流程
        console.warn("[neteaseMatchCache] save failed:", e);
    }
}

export function getCachedMatch(neteaseId: string): ICachedMatch | null {
    return load()[neteaseId] ?? null;
}

/**
 * 缓存命中是否仍然可用：曲目所属音源插件必须还在启用列表里。
 * 只看 item.platform，所以缓存条目（ICachedMatch）和上一轮结果（ISongMatch）都能传。
 */
export function isCachedMatchValid(
    cached: { item: { platform: string } },
    plugins: SerializedPlugin[],
): boolean {
    return plugins.some((p) => p.platform === cached.item.platform);
}

/**
 * 曲目指纹：歌名/歌手/专辑/时长的简单稳定哈希。
 * 匹配结果只跟这几样有关，指纹一致即可认定「音乐数据没变」，
 * 刷新时整列表对得上的歌直接复用缓存，不再逐首搜索。
 */
export function fingerprintOf(song: {
    name: string;
    artists: string[];
    album: string;
    durationMs: number;
}): string {
    const s = `${song.name}|${song.artists.join("/")}|${song.album}|${song.durationMs}`;
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
}

/** 缓存条目是否与曲目指纹对得上（旧版本写入的无指纹条目视为对不上，走原判定） */
export function isCachedMatchFresh(cached: ICachedMatch, song: INeteaseSong): boolean {
    if (!cached.fp) {
        return true;
    }
    return cached.fp === fingerprintOf(song);
}

export function putCachedMatch(
    neteaseId: string,
    item: IMusic.IMusicItem,
    score: number,
    viaDetail?: boolean,
    fingerprint?: string,
) {
    const map = load();
    const existing = map[neteaseId];
    if (
        existing &&
        existing.item.platform === item.platform &&
        existing.item.id === item.id
    ) {
        // 同一映射重复写入只刷新分数，不动 cachedAt（作为 LRU 淘汰依据保持稳定）
        existing.score = score;
        existing.viaDetail = viaDetail;
        if (fingerprint) {
            existing.fp = fingerprint;
        }
        existing.verified = true;
    } else {
        const keys = Object.keys(map);
        if (keys.length >= MAX_ENTRIES && !map[neteaseId]) {
            let oldestKey = keys[0];
            for (const k of keys) {
                if (map[k].cachedAt < map[oldestKey].cachedAt) {
                    oldestKey = k;
                }
            }
            delete map[oldestKey];
        }
        map[neteaseId] = {
            item,
            score,
            viaDetail,
            cachedAt: Date.now(),
            fp: fingerprint,
            verified: true,
        };
    }
    scheduleSave();
}

export function clearMatchCache() {
    cache = {};
    flushMatchCache();
}

/**
 * 缓存占用统计（字节）：序列化整个映射一次。设置页展示「匹配缓存」类别用，
 * 主进程看不到渲染进程的 localStorage，由渲染层随 cache:info 请求带上去。
 */
export function getMatchCacheStats(): { count: number; size: number } {
    try {
        const raw = localStorage.getItem(CACHE_KEY) ?? "";
        return { count: Object.keys(load()).length, size: raw.length };
    } catch {
        return { count: 0, size: 0 };
    }
}
