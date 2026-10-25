import { atom, getDefaultStore } from "jotai";
import { ipcInvoke, pluginCall, SerializedPlugin } from "./ipc";
import { artistSim, titleSim, getMatchableSourcePlugins } from "./neteaseMatch";
import { getSearchSource } from "./mediaSource";
import { rememberRemoteLyric } from "./localLyricMatch";
import { TrackPlayerSingleton } from "./trackPlayer";

/**
 * 本地音乐的歌词/封面匹配（批量 + 单曲共用一条管线）：
 *
 *  1. 先看文件已有什么：内嵌/同名 .lrc 歌词（主进程读）+ 列表 artwork（扫描时
 *     由内嵌封面生成，空即无封面）。批量模式下两样齐全的直接跳过，不浪费搜索；
 *  2. 拿指定音源按「标题 + 歌手」搜同款，评分口径与 localLyricMatch 一致
 *     （0.55 标题相似度 + 0.45 歌手相似度，0.78 过线）；
 *  3. getLyric 拿歌词、候选条目拿封面，经主进程 localLyrics:applyRemote 写回
 *     文件本身（mp3/flac 内嵌，其余格式退同名 .lrc；封面同时进封面缓存并更新
 *     localMusic.list），列表页与播放队列即时换图。
 *
 * 批量匹配跑在模块级会话里（localBatchMatchAtom）：离开页面不打断，回来接着看，
 * 与 neteaseMatchSession 同一思路；单曲匹配（详情页/右键入口）则同步等结果。
 */

export type TLocalMatchStatus = "matched" | "skipped" | "missed" | "error";

export interface ILocalMatchOutcome {
    status: TLocalMatchStatus;
    /** 命中后写回的新封面短链（mfs://cover/…），界面即时换图用 */
    artwork?: string;
    /** 本次实际写入了歌词 / 封面 */
    gotLyric?: boolean;
    gotCover?: boolean;
    /** skipped / missed / error 的人话原因 */
    reason?: string;
}

function splitArtists(artist: string): string[] {
    return String(artist ?? "")
        .split(/[/、,;&]|feat\.?|ft\.?/i)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * 「当前音源」：搜索页记住的音源优先（用户最近在用哪个就是哪个），
 * 其次默认音源（getPlugins 已把默认排最前），都退回第一个可用搜索音源。
 */
export async function resolveCurrentSourcePlugin(): Promise<SerializedPlugin | null> {
    const plugins = await getMatchableSourcePlugins();
    if (!plugins.length) {
        return null;
    }
    const remembered = getSearchSource();
    if (remembered) {
        const hit = plugins.find((p) => p.hash === remembered);
        if (hit) {
            return hit;
        }
    }
    return plugins[0];
}

/**
 * 匹配一首本地歌曲并写回文件。
 * - 批量（overwrite=false）：只补缺——歌词封面已齐全直接 skipped，缺啥补啥；
 * - 手动单曲（overwrite=true）：用户明确点「匹配」，歌词封面都按音源结果重写
 *   （音源没给的字段保留原值，不会把已有的抹掉）。
 * plugin 传 null 视为没有可用音源（error）。
 */
export async function matchLocalTrack(
    musicItem: IMusic.IMusicItem,
    plugin: SerializedPlugin | null,
    options?: { overwrite?: boolean },
): Promise<ILocalMatchOutcome> {
    const localPath = musicItem.localPath;
    if (!localPath) {
        return { status: "error", reason: "不是本地音乐" };
    }
    if (!plugin) {
        return { status: "error", reason: "没有可用的音源插件" };
    }
    const overwrite = !!options?.overwrite;

    // 文件已带的歌词（内嵌 / 同名 .lrc）与已有封面
    let fileLyric = "";
    try {
        fileLyric =
            (await ipcInvoke<string | null>("localLyrics:read", {
                localPath,
                title: musicItem.title,
                artist: musicItem.artist,
            })) ?? "";
    } catch {
        // 主进程读不了就当没有
    }
    const hasCover = !!(musicItem.artwork && String(musicItem.artwork).trim());
    if (!overwrite && fileLyric.trim() && hasCover) {
        return { status: "skipped", reason: "歌词封面已齐全" };
    }

    // 搜同款并评分（与 localLyricMatch 同一套口径）
    const artists = splitArtists(musicItem.artist);
    const query = `${musicItem.title} ${artists[0] ?? ""}`.trim();
    const result = await pluginCall(plugin.hash, "search", query, 1, "music");
    const candidates: any[] = (result?.data ?? []).slice(0, 8);
    const scored = candidates
        .map((cand) => ({
            cand,
            total:
                0.55 * titleSim(musicItem.title, cand.title) +
                0.45 * artistSim(artists, cand.artist),
        }))
        .sort((a, b) => b.total - a.total);
    const best = scored[0];
    if (!best || best.total < 0.78) {
        return { status: "missed", reason: "没找到足够相似的歌曲" };
    }

    // 需要歌词时才去要（批量下已有歌词的不再 getLyric，省一半请求）
    const needLyric = overwrite || !fileLyric.trim();
    let rawLrc = "";
    let translation: string | undefined;
    if (needLyric) {
        try {
            const lyricSource = await pluginCall(plugin.hash, "getLyric", best.cand);
            rawLrc = String(lyricSource?.rawLrc ?? "");
            translation = String(lyricSource?.translation ?? "") || undefined;
        } catch {
            // 这首拿不到歌词，封面还能继续
        }
    }
    const lyrics =
        needLyric && rawLrc.trim()
            ? translation
                ? `${rawLrc}\n${translation}`
                : rawLrc
            : undefined;
    const artworkUrl =
        overwrite || !hasCover
            ? best.cand?.artwork || best.cand?.coverImg || undefined
            : undefined;
    if (!lyrics && !artworkUrl) {
        return {
            status: "missed",
            reason: needLyric ? "音源没有返回歌词和封面" : "音源没有返回封面",
        };
    }

    // handler 把结果包成 {success, data}（preload 不解包），失败时只有 message
    const resp = await ipcInvoke<{
        success: boolean;
        data?: { ok: boolean; artwork?: string; message?: string };
        message?: string;
    }>("localLyrics:applyRemote", { localPath, lyrics, artworkUrl });
    const applied = resp?.data;
    if (!resp?.success || !applied?.ok) {
        return {
            status: "error",
            reason: resp?.message ?? applied?.message ?? "写回文件失败",
        };
    }

    if (lyrics) {
        // 记进播放时的歌词缓存：下次播放直接命中，不再联网搜一遍
        rememberRemoteLyric(musicItem, { rawLrc, translation });
    }
    const artwork = applied.artwork;
    if (artwork) {
        TrackPlayerSingleton.updateLocalMusicArtwork(localPath, artwork);
        notifyArtworkUpdated(localPath, artwork);
    }
    return { status: "matched", artwork, gotLyric: !!lyrics, gotCover: !!artwork };
}

/** ---------- 封面更新事件：页面订阅后把列表里的 artwork 原位换掉 ---------- */

type TArtworkListener = (localPath: string, artwork: string) => void;
const artworkListeners = new Set<TArtworkListener>();

export function onLocalArtworkUpdated(listener: TArtworkListener): () => void {
    artworkListeners.add(listener);
    return () => artworkListeners.delete(listener);
}

function notifyArtworkUpdated(localPath: string, artwork: string) {
    artworkListeners.forEach((listener) => {
        try {
            listener(localPath, artwork);
        } catch {
            // 单个订阅者出错不拖垮其它
        }
    });
}

/** ---------- 批量匹配会话（模块级，离开页面不中断） ---------- */

export interface ILocalBatchMatchView {
    status: "running" | "done" | "canceled";
    total: number;
    done: number;
    matchedCount: number;
    skippedCount: number;
    missedCount: number;
    errorCount: number;
    /** 正在匹配的那首（进度条文案用），空闲为空串 */
    currentTitle: string;
}

export const localBatchMatchAtom = atom<ILocalBatchMatchView | null>(null);

let cancelRequested = false;

export function isLocalBatchMatchRunning(): boolean {
    const view = getDefaultStore().get(localBatchMatchAtom);
    return !!view && view.status === "running";
}

export function cancelLocalBatchMatch() {
    cancelRequested = true;
}

/** 收掉结束态的会话（页面展示完总结后调用），进度条随之消失 */
export function clearLocalBatchMatch() {
    getDefaultStore().set(localBatchMatchAtom, null);
}

/**
 * 启动批量匹配：逐首串行（音源接口普遍限频，并发只会互相挤掉、还更容易被风控）。
 * 已有会话在跑时返回 false（重复点「开始」直接忽略）。
 */
export function startLocalBatchMatch(
    items: IMusic.IMusicItem[],
    plugin: SerializedPlugin | null,
): boolean {
    const store = getDefaultStore();
    if (isLocalBatchMatchRunning() || !items.length) {
        return false;
    }
    cancelRequested = false;
    const view: ILocalBatchMatchView = {
        status: "running",
        total: items.length,
        done: 0,
        matchedCount: 0,
        skippedCount: 0,
        missedCount: 0,
        errorCount: 0,
        currentTitle: items[0]?.title ?? "",
    };
    store.set(localBatchMatchAtom, { ...view });

    (async () => {
        for (const item of items) {
            if (cancelRequested) {
                view.status = "canceled";
                break;
            }
            view.currentTitle = item.title ?? "";
            store.set(localBatchMatchAtom, { ...view });
            let outcome: ILocalMatchOutcome;
            try {
                outcome = await matchLocalTrack(item, plugin);
            } catch (e: any) {
                outcome = { status: "error", reason: e?.message ?? String(e) };
            }
            view.done += 1;
            if (outcome.status === "matched") {
                view.matchedCount += 1;
            } else if (outcome.status === "skipped") {
                view.skippedCount += 1;
            } else if (outcome.status === "missed") {
                view.missedCount += 1;
            } else {
                view.errorCount += 1;
            }
            store.set(localBatchMatchAtom, { ...view });
        }
        if (view.status === "running") {
            view.status = "done";
        }
        view.currentTitle = "";
        store.set(localBatchMatchAtom, { ...view });
    })();

    return true;
}
