import { atom, getDefaultStore, useAtomValue } from "jotai";
import { INeteaseSong, fetchNeteasePlaylistDetail } from "./netease";
import { ISongMatch, matchNeteaseSongs } from "./neteaseMatch";

/**
 * 跨页面存活的匹配会话：每日推荐与推荐歌单的匹配都在这里跑，
 * 页面（重）挂载只是订阅进度——离开页面不打断，回来接着看，退出应用才结束。
 *
 * 会话按 key 隔离（`daily:<日期>` / `playlist:<歌单id>`）：
 *  - 同 key 已在跑或已完成时重复 start 直接复用（页面重挂载不会重新匹配）；
 *  - 「重新匹配」= 先 reset 再 start（重新拉曲目，匹配仍走映射缓存）。
 */

export type MatchSessionStatus = "loading" | "running" | "done" | "error";

export interface IMatchSessionView {
    key: string;
    title: string;
    status: MatchSessionStatus;
    error?: string;
    /** 曲目总数（loading 阶段曲目还没拉到，为 0） */
    total: number;
    /** 已出结果的曲目数 */
    done: number;
    /** 命中且未与前面重复的条数（可播放/可入库的） */
    matchedCount: number;
    /** 其中来自映射缓存的条数 */
    cachedCount: number;
    /** 未命中 + 源内重复的条数 */
    missedCount: number;
    /** 低置信命中（详情复核才采信或分数刚过线） */
    lowCount: number;
    /** 按歌曲原顺序排列的全部已落地结果（running 时是实时快照） */
    matches: ISongMatch[];
}

interface ISession {
    key: string;
    title: string;
    status: MatchSessionStatus;
    error?: string;
    songs: INeteaseSong[];
    /** 结果按网易云歌曲 id 索引，展示时按 songs 原顺序重排 */
    results: Map<string, ISongMatch>;
    done: number;
}

const sessions = new Map<string, ISession>();
const sessionListAtom = atom<IMatchSessionView[]>([]);
const store = getDefaultStore();

function viewOf(s: ISession): IMatchSessionView {
    const matches = s.songs
        .map((song) => s.results.get(song.id))
        .filter(Boolean) as ISongMatch[];
    const matched = matches.filter((m) => m.status === "matched" && !m.duplicate);
    return {
        key: s.key,
        title: s.title,
        status: s.status,
        error: s.error,
        total: s.songs.length,
        done: s.done,
        matchedCount: matched.length,
        cachedCount: matches.filter((m) => m.fromCache).length,
        missedCount: matches.filter((m) => m.status === "missed" || m.duplicate).length,
        lowCount: matched.filter((m) => m.viaDetail || m.low).length,
        matches,
    };
}

function notify() {
    store.set(sessionListAtom, Array.from(sessions.values()).map(viewOf));
}

/** 订阅某个会话的实时视图（无则返回 null，页面按冷启动处理） */
export function useMatchSession(key: string): IMatchSessionView | null {
    return useAtomValue(sessionListAtom).find((s) => s.key === key) ?? null;
}

export function getMatchSession(key: string): IMatchSessionView | null {
    const s = sessions.get(key);
    return s ? viewOf(s) : null;
}

/** 删除会话：下一次 start 会重新拉取并完整跑一遍（匹配仍优先走映射缓存） */
export function resetMatchSession(key: string) {
    if (sessions.delete(key)) {
        notify();
    }
}

/** 启动会话的匹配阶段（曲目已在手上） */
function runMatcher(session: ISession) {
    session.status = "running";
    notify();
    matchNeteaseSongs(session.songs, {
        onProgress: (done) => {
            if (sessions.get(session.key) === session) {
                session.done = done;
                notify();
            }
        },
        onResult: (r) => {
            if (sessions.get(session.key) === session) {
                session.results.set(r.song.id, r);
                notify();
            }
        },
        // 只有会话被 reset（从 map 里摘掉）才会停：页面离开不影响
        shouldContinue: () => sessions.get(session.key) === session,
    })
        .then(() => {
            if (sessions.get(session.key) === session) {
                session.status = "done";
                notify();
            }
        })
        .catch((e: any) => {
            if (sessions.get(session.key) === session) {
                session.status = "error";
                session.error = e?.message ?? "匹配失败";
                notify();
            }
        });
}

/** 曲目已在手上（每日推荐）：创建会话并开始匹配；同 key 已在跑/已完成时复用 */
export function startMatchSession(key: string, title: string, songs: INeteaseSong[]) {
    const existing = sessions.get(key);
    if (existing && existing.status !== "error") {
        return;
    }
    const session: ISession = {
        key,
        title,
        status: "running",
        songs,
        results: new Map(),
        done: 0,
    };
    sessions.set(key, session);
    notify();
    runMatcher(session);
}

/**
 * 推荐歌单：先拉全量曲目再匹配，整条流水线都在会话里跑——
 * 页面点开只是触发 + 订阅，立即退出拉取和匹配也照样完成。
 */
export function startPlaylistMatchSession(card: { id: string; title: string }) {
    const key = `playlist:${card.id}`;
    const existing = sessions.get(key);
    if (existing && existing.status !== "error") {
        return;
    }
    const session: ISession = {
        key,
        title: card.title,
        status: "loading",
        songs: [],
        results: new Map(),
        done: 0,
    };
    sessions.set(key, session);
    notify();
    fetchNeteasePlaylistDetail(card.id)
        .then(({ songs }) => {
            if (sessions.get(key) !== session) {
                return; // 等待期间被 reset 了
            }
            session.songs = songs;
            runMatcher(session);
        })
        .catch((e: any) => {
            if (sessions.get(key) !== session) {
                return;
            }
            session.status = "error";
            session.error = e?.message ?? "获取歌单曲目失败";
            notify();
        });
}
