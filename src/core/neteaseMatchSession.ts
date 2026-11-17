import { atom, getDefaultStore, useAtomValue } from "jotai";
import { INeteaseSong, fetchNeteasePlaylistDetail } from "./netease";
import { ISongMatch, matchNeteaseSongs } from "./neteaseMatch";
import { addMusicToSheetMany, setSheetImportSource } from "./musicSheet";

/**
 * 跨页面存活的匹配会话：每日推荐与推荐歌单的匹配都在这里跑，
 * 页面（重）挂载只是订阅进度——离开页面不打断，回来接着看，退出应用才结束。
 *
 * 会话按 key 隔离（`daily:<日期>` / `playlist:<歌单id>`）：
 *  - 同 key 已在跑或已完成时重复 start 直接复用（页面重挂载不会重新匹配）；
 *  - 「刷新」= 先 reset 再 start：重新拉曲目，但上一轮结果保留在 lastResults 里——
 *    曲目没变就整列表直接复用，变了才对没匹配过的歌逐首搜索（映射缓存仍优先）。
 */

export type MatchSessionStatus = "loading" | "running" | "done" | "error";

export interface IMatchSessionView {
    key: string;
    title: string;
    /** 歌单封面：链接导入等场景在曲目拉到后回填（此前为空） */
    artwork?: string;
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
    /** 会话对应的网易云曲目原列表（展示编号/对照用；loading 阶段曲目未拉到，为空） */
    songs: INeteaseSong[];
    /** 按歌曲原顺序排列的全部已落地结果（running 时是实时快照） */
    matches: ISongMatch[];
}

interface ISession {
    key: string;
    title: string;
    /** 歌单封面：链接导入等场景在曲目拉到后回填（此前为空） */
    artwork?: string;
    /** 链接导入的目标本地歌单：匹配完成后自动写入并清除导入标记（每日推荐流没有） */
    targetSheetId?: string;
    status: MatchSessionStatus;
    error?: string;
    songs: INeteaseSong[];
    /** 结果按网易云歌曲 id 索引，展示时按 songs 原顺序重排 */
    results: Map<string, ISongMatch>;
    done: number;
    /**
     * 上一轮跑完的结果：reset 时从旧会话摘出来，下一次 start 传给匹配器做
     * 「数据没变直接复用」判定（见 matchNeteaseSongs 的 previous）。
     */
    lastResults?: ISongMatch[];
}

const sessions = new Map<string, ISession>();
/** key → 上一次会话的结果，会话被 reset 时留存，供下一次 start 复用 */
const lastResultsByKey = new Map<string, ISongMatch[]>();
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
        artwork: s.artwork,
        status: s.status,
        error: s.error,
        total: s.songs.length,
        done: s.done,
        matchedCount: matched.length,
        cachedCount: matches.filter((m) => m.fromCache).length,
        missedCount: matches.filter((m) => m.status === "missed" || m.duplicate).length,
        lowCount: matched.filter((m) => m.viaDetail || m.low).length,
        songs: s.songs,
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

/** 网易云歌单匹配会话的 key：按歌单 id 隔离（推荐歌单页 / 链接导入共用同一份结果） */
export function neteaseSessionKey(id: string) {
    return `playlist:${id}`;
}

export function getMatchSession(key: string): IMatchSessionView | null {
    const s = sessions.get(key);
    return s ? viewOf(s) : null;
}

/**
 * 删除会话：下一次 start 会重新拉取曲目，但上一轮结果留存复用——
 * 曲目没变就不重配，变了的歌走映射缓存/逐首搜索。
 */
export function resetMatchSession(key: string) {
    const s = sessions.get(key);
    if (s) {
        const results = Array.from(s.results.values());
        if (results.length === s.songs.length && s.songs.length > 0) {
            lastResultsByKey.set(key, results);
        } else {
            lastResultsByKey.delete(key);
        }
        sessions.delete(key);
        notify();
    }
}

/**
 * 清空全部会话。退出/更换网易云账号时调用：私人雷达等歌单的内容按账号生成，
 * 旧账号拉到的曲目与匹配结果对下一个账号来说是错的，全部作废重走（历史结果一并丢弃）。
 */
export function resetAllMatchSessions() {
    if (sessions.size || lastResultsByKey.size) {
        sessions.clear();
        lastResultsByKey.clear();
        notify();
    }
}

/** 清掉某个 key 的历史结果（缓存被清等场景下不再有可复用的上一轮） */
export function dropLastResults(key?: string) {
    if (key) {
        lastResultsByKey.delete(key);
    } else {
        lastResultsByKey.clear();
    }
}

/** 启动会话的匹配阶段（曲目已在手上） */
function runMatcher(session: ISession) {
    session.status = "running";
    notify();
    matchNeteaseSongs(session.songs, {
        previous: session.lastResults,
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
        .then(async () => {
            if (sessions.get(session.key) !== session) {
                return; // 等待期间被 reset（取消/刷新）了，不落盘
            }
            if (session.targetSheetId) {
                // 先落盘再宣布完成：详情页在刷到歌单数据前保持骨架，不会闪「暂无歌曲」
                await finalizeSheetImport(session);
                if (session.status !== "error") {
                    session.status = "done";
                }
            } else {
                session.status = "done";
            }
            notify();
        })
        .catch((e: any) => {
            if (sessions.get(session.key) === session) {
                session.status = "error";
                session.error = e?.message ?? "匹配失败";
                notify();
            }
        });
}

/**
 * 链接导入收尾：把命中的曲目写入目标本地歌单并清除导入标记。
 * 按音源+id 去重所以重复执行幂等；写入失败保留导入标记，详情页可见并可重试。
 */
async function finalizeSheetImport(session: ISession) {
    const sheetId = session.targetSheetId!;
    try {
        const items = session.songs
            .map((song) => session.results.get(song.id))
            .filter((m): m is ISongMatch => !!m && m.status === "matched" && !m.duplicate)
            .map((m) => m.item!);
        await addMusicToSheetMany(sheetId, items);
        await setSheetImportSource(sheetId, null);
    } catch (e: any) {
        session.status = "error";
        session.error = e?.message ?? "写入歌单失败";
    }
    notify();
}

/**
 * 曲目已在手上（每日推荐 / 导入弹窗预取）：创建会话并开始匹配；
 * 同 key 已在跑/已完成时复用。targetSheetId 传入时匹配完成自动写入该歌单。
 */
export function startMatchSession(
    key: string,
    title: string,
    songs: INeteaseSong[],
    targetSheetId?: string,
) {
    const existing = sessions.get(key);
    if (existing && existing.status !== "error") {
        if (targetSheetId) {
            // 目标歌单跟着最近的导入走：跑完时 finalize 用它落盘
            existing.targetSheetId = targetSheetId;
            if (existing.status === "done") {
                // 同一歌单再次导入：结果已齐，直接重走一次落盘（幂等）
                void finalizeSheetImport(existing);
            }
        }
        return;
    }
    const lastResults = lastResultsByKey.get(key);
    lastResultsByKey.delete(key);
    const session: ISession = {
        key,
        title,
        status: "running",
        songs,
        results: new Map(),
        done: 0,
        lastResults,
        targetSheetId,
    };
    sessions.set(key, session);
    notify();
    runMatcher(session);
}

/**
 * 推荐歌单：先拉全量曲目再匹配，整条流水线都在会话里跑——
 * 页面点开只是触发 + 订阅，立即退出拉取和匹配也照样完成。
 * 链接导入进页面时只有歌单 id，标题/封面在曲目拉到后回填（title 传占位文案即可）；
 * opts.targetSheetId 传入时匹配完成自动写入该本地歌单。
 */
export function startPlaylistMatchSession(
    card: { id: string; title: string },
    opts?: { targetSheetId?: string },
) {
    const key = neteaseSessionKey(card.id);
    const existing = sessions.get(key);
    if (existing && existing.status !== "error") {
        if (opts?.targetSheetId) {
            existing.targetSheetId = opts.targetSheetId;
        }
        return;
    }
    const lastResults = lastResultsByKey.get(key);
    lastResultsByKey.delete(key);
    const session: ISession = {
        key,
        title: card.title,
        status: "loading",
        songs: [],
        results: new Map(),
        done: 0,
        lastResults,
        targetSheetId: opts?.targetSheetId,
    };
    sessions.set(key, session);
    notify();
    fetchNeteasePlaylistDetail(card.id)
        .then(({ name, songs, artwork }) => {
            if (sessions.get(key) !== session) {
                return; // 等待期间被 reset 了
            }
            // 链接导入的会话进来时标题是占位文案，拿到真实歌单名/封面后回填
            session.title = name || session.title;
            session.artwork = artwork || session.artwork;
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
