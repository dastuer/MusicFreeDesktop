import React, { useEffect, useRef, useState } from "react";
import {
    INeteaseSong,
    fetchNeteaseSongComments,
    fetchNeteaseSongRedCount,
    searchNeteaseSongs,
} from "./netease";
import { isPassing, scoreOf } from "./neteaseMatch";

/**
 * 「当前播放曲 → 网易云歌曲 id」解析（localStorage 持久化，模式同 neteaseMatchCache）。
 *
 * 队列里的曲目 platform 是音源插件的，网易原 id 只有经 neteaseMatch 新匹配导入的
 * 条目带（neteaseId 字段）。其余靠「曲名 + 第一位歌手」走 cloudsearch 反查，用与
 * neteaseMatch 相同的相似度打分采信（total≥0.78 且标题≥0.8 且歌手≥0.6），不过线
 * 视为未匹配，宁缺毋滥——评论区张冠李戴比没有评论糟糕得多。
 *
 * 反查结果（含「未匹配」负缓存）写 localStorage；负缓存 7 天过期重查，
 * 留口子给网易侧补录/更名的情况。
 */

const CACHE_KEY = "neteaseCommentSongMap.v1";
/** 容量上限：超出时按 cachedAt 淘汰最旧 */
const MAX_ENTRIES = 3000;
const SAVE_DELAY = 600;
/** 「未匹配」负缓存的过期时间：期间不再重复反查 */
const NEGATIVE_TTL = 7 * 24 * 3600 * 1000;

interface ICachedSongId {
    /** 网易歌曲 id；null = 反查过但没把握 */
    neteaseId: string | null;
    cachedAt: number;
}

let cache: Record<string, ICachedSongId> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Record<string, ICachedSongId> {
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
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(cache ?? {}));
        } catch {
            // localStorage 满/不可写：缓存丢弃即可，不影响功能
        }
    }, SAVE_DELAY);
}

function put(key: string, value: ICachedSongId) {
    const store = load();
    store[key] = value;
    const keys = Object.keys(store);
    if (keys.length > MAX_ENTRIES) {
        keys
            .sort((a, b) => (store[a]?.cachedAt ?? 0) - (store[b]?.cachedAt ?? 0))
            .slice(0, keys.length - MAX_ENTRIES)
            .forEach((k) => delete store[k]);
    }
    scheduleSave();
}

function cacheKeyOf(music: IMusic.IMusicItem) {
    return `${music.platform}:${music.id}`;
}

/** 打分两侧各自适配：播放曲摆成「网易歌」形状，搜索结果摆成「插件候选」形状 */
function scoreAgainst(music: IMusic.IMusicItem, song: INeteaseSong) {
    const pseudoSong = {
        id: "",
        name: music.title ?? "",
        artists: String(music.artist ?? "")
            .split(/[/、,，&]/)
            .map((s) => s.trim())
            .filter(Boolean),
        album: music.album ?? "",
        durationMs: (music.duration ?? 0) * 1000,
        fee: 0,
        artwork: "",
    } as INeteaseSong;
    return scoreOf(pseudoSong, {
        title: song.name,
        artist: song.artists.join("/"),
        album: song.album,
        duration: song.durationMs / 1000,
    });
}

/**
 * 解析播放曲的网易歌曲 id。自带 neteaseId 的直接用；
 * 其余走 cloudsearch 反查（结果缓存，未登录可用——搜索本身免登录）。
 */
export async function resolveNeteaseSongId(music: IMusic.IMusicItem): Promise<string | null> {
    const key = cacheKeyOf(music);
    const hit = load()[key];
    const directId = (music as { neteaseId?: string }).neteaseId;
    if (typeof directId === "string" && directId) {
        if (hit?.neteaseId !== directId) {
            put(key, { neteaseId: directId, cachedAt: Date.now() });
        }
        return directId;
    }
    if (hit) {
        if (hit.neteaseId) {
            return hit.neteaseId;
        }
        if (Date.now() - hit.cachedAt < NEGATIVE_TTL) {
            return null;
        }
    }
    const artist = String(music.artist ?? "").split(/[/、,，&]/)[0]?.trim() ?? "";
    const keyword = [music.title, artist].filter(Boolean).join(" ");
    if (!keyword) {
        put(key, { neteaseId: null, cachedAt: Date.now() });
        return null;
    }
    const candidates = await searchNeteaseSongs(keyword, 10);
    const best = candidates
        .map((song) => ({ song, score: scoreAgainst(music, song) }))
        .sort((a, b) => b.score.total - a.score.total)[0];
    const neteaseId = best && isPassing(best.score) ? best.song.id : null;
    put(key, { neteaseId, cachedAt: Date.now() });
    return neteaseId;
}

/** 清空映射缓存（设置页「存储与缓存」清理匹配缓存时一并清，属可重建派生数据） */
export function clearCommentSongMap() {
    cache = {};
    try {
        localStorage.removeItem(CACHE_KEY);
    } catch {
        // 忽略：清不掉也只是下次还命中旧映射
    }
}

/** ---------- 歌曲计数（喜欢数/评论数，播放条角标用，localStorage 持久化） ---------- */

const COUNTS_KEY = "neteaseSongCounts.v1";
/** 计数刷新周期：一天后过期重拉（红心数会涨） */
const COUNTS_TTL = 24 * 3600 * 1000;

export interface ISongCounts {
    neteaseId: string;
    likeCount: number | null;
    /** 网易自己的展示格式（如「100w+」），角标直接展示 */
    likeCountDesc: string | null;
    commentCount: number | null;
}

let countsStore: Record<string, ISongCounts & { at: number }> | null = null;

function loadCounts(): Record<string, ISongCounts & { at: number }> {
    if (countsStore) {
        return countsStore;
    }
    try {
        const parsed = JSON.parse(localStorage.getItem(COUNTS_KEY) ?? "{}");
        countsStore = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        countsStore = {};
    }
    return countsStore!;
}

function saveCounts() {
    try {
        localStorage.setItem(COUNTS_KEY, JSON.stringify(countsStore ?? {}));
    } catch {
        // 忽略：计数缓存丢失只是角标空一次
    }
}

const EMPTY_COUNTS = { likeCount: null, likeCountDesc: null, commentCount: null };

/** 角标数字格式化（参考网易云）：不足 1 万原样，之后取整到「Nw+」 */
export function formatCountBadge(n: number | null | undefined): string {
    if (n == null || n <= 0) {
        return "";
    }
    if (n < 10000) {
        return String(n);
    }
    return `${Math.round(n / 10000)}w+`;
}

/** 同步读缓存（含过期判断：过期字段按缺失处理，待异步刷新） */
function peekSongCounts(music: IMusic.IMusicItem): ISongCounts {
    const hit = loadCounts()[cacheKeyOf(music)];
    if (!hit) {
        return { neteaseId: "", ...EMPTY_COUNTS };
    }
    const fresh = Date.now() - hit.at < COUNTS_TTL;
    return {
        neteaseId: hit.neteaseId,
        likeCount: fresh ? hit.likeCount : null,
        likeCountDesc: fresh ? hit.likeCountDesc : null,
        commentCount: fresh ? hit.commentCount : null,
    };
}

/**
 * 拉取歌曲计数：先反查网易 id（自身有缓存），红心数与评论数并行取、
 * 只补缺失字段，结果落盘。评论页加载后也会回写评论数（rememberCommentTotal）。
 */
export async function fetchSongCounts(music: IMusic.IMusicItem): Promise<ISongCounts> {
    const key = cacheKeyOf(music);
    const cached = peekSongCounts(music);
    const neteaseId = cached.neteaseId || (await resolveNeteaseSongId(music)) || "";
    if (!neteaseId) {
        return { neteaseId: "", ...EMPTY_COUNTS };
    }
    const [red, commentCount] = await Promise.all([
        cached.likeCountDesc !== null
            ? null
            : fetchNeteaseSongRedCount(neteaseId).catch(() => null),
        cached.commentCount !== null
            ? null
            : fetchNeteaseSongComments(neteaseId, { limit: 1, offset: 0 })
                  .then((p) => p.total)
                  .catch(() => null),
    ]);
    const next: ISongCounts = {
        neteaseId,
        likeCount: red ? red.count : cached.likeCount,
        likeCountDesc: red ? red.countDesc : cached.likeCountDesc,
        commentCount: commentCount ?? cached.commentCount,
    };
    const store = loadCounts();
    store[key] = { ...next, at: Date.now() };
    saveCounts();
    return next;
}

/** 评论区拉到最新总数后回写，播放条角标即可同步（不必等 TTL） */
export function rememberCommentTotal(music: IMusic.IMusicItem, total: number) {
    const key = cacheKeyOf(music);
    const store = loadCounts();
    const hit = store[key];
    if (hit && hit.commentCount === total) {
        return;
    }
    store[key] = {
        neteaseId: hit?.neteaseId ?? "",
        likeCount: hit?.likeCount ?? null,
        likeCountDesc: hit?.likeCountDesc ?? null,
        commentCount: total,
        at: Date.now(),
    };
    saveCounts();
}

/**
 * 播放条角标 hook：先同步吐缓存（切歌瞬间有值），再异步补拉缺失/过期的部分。
 */
export function useNeteaseSongCounts(
    music: IMusic.IMusicItem | null | undefined,
): ISongCounts | null {
    const musicKey = music ? `${music.platform}:${music.id}` : "";
    const [counts, setCounts] = useState<ISongCounts | null>(() =>
        music ? peekSongCounts(music) : null,
    );
    const musicRef = useRef(music);
    musicRef.current = music;
    useEffect(() => {
        if (!musicKey) {
            setCounts(null);
            return;
        }
        let cancelled = false;
        setCounts(musicRef.current ? peekSongCounts(musicRef.current) : null);
        fetchSongCounts(musicRef.current!)
            .then((c) => {
                if (!cancelled) {
                    setCounts(c);
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [musicKey]);
    return counts;
}
