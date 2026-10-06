import { SerializedPlugin } from "./ipc";

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

interface ICachedMatch {
    item: IMusic.IMusicItem;
    score: number;
    viaDetail?: boolean;
    cachedAt: number;
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

/** 缓存命中是否仍然可用：曲目所属音源插件必须还在启用列表里 */
export function isCachedMatchValid(cached: ICachedMatch, plugins: SerializedPlugin[]): boolean {
    return plugins.some((p) => p.platform === cached.item.platform);
}

export function putCachedMatch(
    neteaseId: string,
    item: IMusic.IMusicItem,
    score: number,
    viaDetail?: boolean,
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
        map[neteaseId] = { item, score, viaDetail, cachedAt: Date.now() };
    }
    scheduleSave();
}

export function clearMatchCache() {
    cache = {};
    flushMatchCache();
}

export function getMatchCacheCount(): number {
    return Object.keys(load()).length;
}
