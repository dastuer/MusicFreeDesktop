import { getPluginByMedia, ipcInvoke, pluginCall } from "./ipc";
import { getQuality } from "./appConfig";
import { resolveQualityLadder } from "./trackPlayer";
import { INeteaseSong } from "./netease";
import { ISongMatch, matchNeteaseSongs } from "./neteaseMatch";
import { replaceMusicInSheetMany } from "./musicSheet";

/**
 * 我的歌单 · 音源修复 / 重新匹配 / 替换音源。
 *
 * 三个功能共用一条管线，差别在「谁有资格进入匹配」和「用哪些音源匹配」：
 *  - 重新匹配音乐（rematch）：流媒体曲目全部重配；本地文件先查存在性，只有文件
 *    丢失的才配（本地文件好好的没必要折腾）。音源可多选，默认全部。
 *  - 修复音源（repair）：先逐首探测能不能拿到可播放的链接，正常的直接跳过，
 *    失效的才配。音源可多选，默认全部。
 *  - 替换音源（replacer）：用户指定唯一音源，用它匹配到的版本替换曲目；
 *    本地文件同样只处理已丢失的。
 *
 * 匹配复用网易云推荐歌单那套打分管线（neteaseMatch）：把歌单元目转成
 * INeteaseSong 形状（id 用「原platform-原id」，顺带复用它的映射缓存），
 * 搜索打分 + 可播性闸门，赢家作为替换候选交给弹窗对比确认。
 */

/** 歌单音源管理的动作类型 */
export type TSheetFixMode = "rematch" | "repair" | "replacer";

/** 单首探测：能否拿到可播放的音源 */
export interface ITrackHealth {
    ok: boolean;
    /** 不可用原因（ok 时为空），对比弹窗里红标展示 */
    reason?: string;
}

/** 单次 getMediaSource 探测的最长等待（与播放器的 MEDIA_SOURCE_TIMEOUT 同量级） */
const HEALTH_TIMEOUT = 8000;
/** 健康检查并发数 */
const HEALTH_CONCURRENCY = 4;

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * 歌单元目 → 匹配管线的歌曲形状。
 * id 用「原platform-原id」：既避免与网易云数字 id 撞车，又让同一首歌
 * 的匹配结果落进映射缓存，下次重跑同一个歌单时秒出。
 */
export function musicItemToSong(item: IMusic.IMusicItem): INeteaseSong {
    return {
        id: `${item.platform}-${item.id}`,
        name: item.title ?? "",
        artists: splitArtists(item.artist),
        album: item.album ?? "",
        durationMs: Math.round((item.duration || 0) * 1000),
        fee: 0,
        artwork: item.artwork ?? "",
    };
}

/** 歌手串拆成数组（歌手串的分隔符各家不一，常见的都切一下；匹配器内部还会再细拆） */
function splitArtists(s?: string): string[] {
    return (s ?? "")
        // feat/ft 必须紧跟在空白之后（"Daft Punk" 里的 ft 不能中招）
        .split(/\/|、|，|,|&|;|；|\s+(?:feat|ft)\.?\s*/i)
        .map((x) => x.trim())
        .filter(Boolean);
}

/** 本地文件批量查存在性（渲染进程摸不到文件系统，走主进程） */
async function checkLocalPaths(paths: string[]): Promise<Record<string, boolean>> {
    if (!paths.length) {
        return {};
    }
    try {
        return (await ipcInvoke("localMusic:checkPaths", paths)) ?? {};
    } catch {
        return {};
    }
}

/** 流媒体曲目探测：插件在不在、getMediaSource 按音质档逐级降能不能拿到直链 */
async function checkStreamHealth(item: IMusic.IMusicItem): Promise<ITrackHealth> {
    const plugin = await getPluginByMedia(item);
    if (!plugin) {
        return { ok: false, reason: "音源插件已卸载或禁用" };
    }
    if (!plugin.supportedMethods.includes("getMediaSource")) {
        return item.url ? { ok: true } : { ok: false, reason: "音源插件不支持取流播放" };
    }
    for (const quality of resolveQualityLadder(getQuality())) {
        try {
            const source = await Promise.race([
                pluginCall(plugin.hash, "getMediaSource", item, quality) as Promise<
                    IPlugin.IMediaSourceResult | null
                >,
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error("音源响应超时")), HEALTH_TIMEOUT),
                ),
            ]);
            if (source?.url || item.url) {
                return { ok: true };
            }
        } catch {
            // 这一档拿不到/超时：降一档再试（与播放器的降级自救同一口径）
        }
    }
    return { ok: false, reason: "拿不到可播放的链接" };
}

/** 探测单首歌的音源健康度 */
export async function checkMusicHealth(item: IMusic.IMusicItem): Promise<ITrackHealth> {
    if (item.localPath) {
        const exists = (await checkLocalPaths([item.localPath]))[item.localPath];
        return exists ? { ok: true } : { ok: false, reason: "本地文件丢失" };
    }
    return checkStreamHealth(item);
}

export interface ICheckManyOptions {
    onProgress?: (done: number, total: number) => void;
    /** 取消旗标：弹窗关闭后不再发起新的探测 */
    shouldContinue?: () => boolean;
}

/** 批量探测（有限并发），返回与传入顺序一致的数组 */
export async function checkMusicHealthMany(
    items: IMusic.IMusicItem[],
    options: ICheckManyOptions = {},
): Promise<ITrackHealth[]> {
    const { onProgress, shouldContinue } = options;
    const results: ITrackHealth[] = new Array(items.length);
    let done = 0;
    const queue = items.map((item, index) => ({ item, index }));
    async function worker() {
        while (queue.length) {
            if (shouldContinue && !shouldContinue()) {
                return;
            }
            const next = queue.shift()!;
            results[next.index] = await checkMusicHealth(next.item);
            done++;
            onProgress?.(done, items.length);
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(HEALTH_CONCURRENCY, items.length) }, worker),
    );
    // 取消后未探测的位置补成「未知」，按正常处理（宁可少修也不误伤）
    return results.map((r) => r ?? { ok: true });
}

export interface IMatchItemsOptions {
    onProgress?: (done: number, total: number) => void;
    onResult?: (result: ISongMatch) => void;
    shouldContinue?: () => boolean;
    /** 限定参与匹配的音源插件 hash（替换音源模式传单个，不传 = 全部可用音源） */
    sourceHashes?: string[];
}

/** 对歌单元目跑匹配管线，返回按传入顺序对齐的结果 */
export async function matchMusicItems(
    items: IMusic.IMusicItem[],
    options: IMatchItemsOptions = {},
): Promise<ISongMatch[]> {
    const songs = items.map(musicItemToSong);
    const results = await matchNeteaseSongs(songs, {
        concurrency: 4,
        sourceHashes: options.sourceHashes,
        onProgress: options.onProgress,
        onResult: options.onResult,
        shouldContinue: options.shouldContinue,
    });
    // matchNeteaseSongs 按完成序返回（并发乱序）：对回原列表顺序
    const bySongId = new Map(results.map((r) => [r.song.id, r]));
    return songs.map((song) => bySongId.get(song.id)!).filter(Boolean);
}

export interface ISheetReplacementPair {
    from: IMusic.IMusicItem;
    to: IMusic.IMusicItem;
}

/** 把确认过的替换落进歌单（原位替换 + 防重复行），返回真正生效的替换供播放队列同步 */
export function applySheetReplacements(sheetId: string, pairs: ISheetReplacementPair[]) {
    return replaceMusicInSheetMany(sheetId, pairs);
}

/** 替换候选相对原曲的可用性（对比弹窗逐行判定用） */
export function describeReplacement(
    original: IMusic.IMusicItem,
    match?: ISongMatch,
): { candidate: IMusic.IMusicItem | null; skipReason?: string } {
    if (!match || match.status !== "matched") {
        return {
            candidate: null,
            skipReason: match?.bestTitle
                ? `未找到合适的替换（最接近：${match.bestTitle}）`
                : "未找到合适的替换",
        };
    }
    if (match.duplicate || !match.item) {
        return { candidate: null, skipReason: "与列表中其他歌曲命中了同一首，跳过替换" };
    }
    const keyOf = (it: IMusic.IMusicItem) => `${it.platform}-${it.id}`;
    if (keyOf(match.item) === keyOf(original)) {
        return { candidate: null, skipReason: "匹配结果与当前一致，无需替换" };
    }
    return { candidate: match.item };
}
