import { pluginCall, SerializedPlugin, getSortedSearchablePlugins } from "./ipc";
import { getQuality } from "./appConfig";
import { INeteaseSong } from "./netease";
import {
    flushMatchCache,
    getCachedMatch,
    ICachedMatch,
    fingerprintOf,
    isCachedMatchFresh,
    isCachedMatchValid,
    putCachedMatch,
} from "./neteaseMatchCache";

/**
 * 网易云推荐歌曲 → 本地音源插件 匹配器。
 *
 * 打分与采信口径移植自 import-netease-playlist 技能脚本（已在真实歌单上验证过）：
 * 搜索「歌名 + 第一位歌手」，标题相似度 0.55 + 歌手相似度 0.3 + 时长相似度 0.15；
 * 过线条件 total≥0.78 且标题≥0.8 且歌手≥0.6，未过线的候选拿 getMusicInfo
 * 用「专辑一致 + 时长差≤3s」复核（歌手名转写会误杀，如 Gyubin↔규빈）。
 *
 * 视频源（B 站类）默认排除：时长对不上，命中率极低还拖慢整体。
 *
 * 可播性闸门：赢家（及详情复核的备选）必须现场通过 getMediaSource 拿到可播放的
 * 直链才采信，拿不到的源（插件残废 / 曲目下架 / 仅 VIP）按分数顺位补位——
 * 匹配结果里不再混进「看着命中了、其实播不了」的曲目。
 */

const VIDEO_SOURCE = /哔哩|bilibili|b站|youtube/i;

/** 采信闸门（与技能脚本一致） */
const MIN_SCORE = 0.78;

/** 视频源之外没有可用的搜索音源时抛出，页面给出安装插件指引 */
export class NoMatchSourceError extends Error {
    constructor() {
        super("没有可用的音源插件，请先在「音源插件」中安装并启用");
        this.name = "NoMatchSourceError";
    }
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

/** ---------- 文本相似度（技能脚本 lib.cjs 的移植） ---------- */

function norm(s: string) {    return (s || "")
        .toLowerCase()
        .normalize("NFKC")
        .replace(/[\s　·・．.、,，。_'’`\-—~/\\|!！?？:：;“”"《》]+/g, "");
}

function stripParens(s: string) {
    return (s || "").replace(/（[^）]*）|\([^)]*\)/g, " ").replace(/[（(】\[].*$/, " ");
}

function artistTokens(s: string) {
    return (s || "")
        .split(/[/、,，&（(]|\s+feat\.?\s+|\s+\+s?|\bfeat\.?\b|\bft\.?\b/)
        .map(norm)
        .filter(Boolean);
}

export function titleSim(a: string, b: string) {
    const na = norm(a);
    const nb = norm(b);
    if (!na || !nb) {
        return 0;
    }
    if (na === nb) {
        return 1;
    }
    const sa = norm(stripParens(a));
    const sb = norm(stripParens(b));
    if (sa && sa === sb) {
        return 0.97;
    }
    const ratio = (x: string, y: string) =>
        0.9 * (Math.min(x.length, y.length) / Math.max(x.length, y.length)) + 0.06;
    if (sa && sb && (sa.includes(sb) || sb.includes(sa))) {
        return ratio(sa, sb);
    }
    if (na.includes(nb) || nb.includes(na)) {
        return ratio(na, nb);
    }
    const A = new Set((sa || na).split(""));
    let hit = 0;
    for (const ch of new Set(sb || nb)) {
        if (A.has(ch)) {
            hit++;
        }
    }
    const union = new Set([...(sa || na), ...(sb || nb)]).size;
    return union ? (hit / union) * 0.8 : 0;
}

export function artistSim(targetList: string[], candArtist: string) {
    const T = new Set(artistTokens(targetList.join("/")));
    const C = new Set(artistTokens(candArtist));
    if (!T.size || !C.size) {
        return 0.5;
    }
    let best = 0;
    for (const t of T) {
        for (const c of C) {
            if (t === c) {
                best = Math.max(best, 1);
            } else if (t.includes(c) || c.includes(t)) {
                best = Math.max(best, 0.9);
            }
        }
    }
    if (best) {
        return best;
    }
    if ([...T].some((t) => [...C].some((c) => titleSim(t, c) >= 0.8))) {
        return 0.8;
    }
    return 0.1;
}

export function durScore(targetMs: number, candSec: number) {
    if (!candSec) {
        return 0.75;
    }
    const d = Math.abs(targetMs / 1000 - candSec);
    if (d <= 3) {
        return 1;
    }
    if (d <= 10) {
        return 0.7;
    }
    if (d <= 30) {
        return 0.35;
    }
    return 0.05;
}

interface IScored {
    total: number;
    ts: number;
    as: number;
    ds: number;
}

/** 采信闸门：总分过线且标题、歌手相似度都达标（评论区的歌曲反查也用同一口径） */
export function isPassing(s: IScored) {
    return s.total >= MIN_SCORE && s.ts >= 0.8 && s.as >= 0.6;
}

/**
 * 可播性探测的最长等待。匹配阶段只是「验证」，不值得为一个死源等满 pluginCall 的 30s。
 */
const PROBE_TIMEOUT = 8000;

/** 探测用的音质序列：默认音质优先，拿不到再用 standard 兜底（不少插件只备了标准档） */
function probeQualities(): IMusic.IQualityKey[] {
    const quality = getQuality();
    return quality === "standard" ? ["standard"] : [quality, "standard"];
}

/**
 * 探测一个候选能不能真的拿到可播放的直链（与播放时同一条 getMediaSource 通道）。
 * 条目自带直链（item.url）直接算可播；两档都拿不到链接视为不可播。
 */
async function probePlayable(
    plugin: SerializedPlugin,
    item: IMusic.IMusicItem,
): Promise<boolean> {
    if (item.url) {
        return true;
    }
    if (!plugin.supportedMethods.includes("getMediaSource")) {
        return false;
    }
    for (const quality of probeQualities()) {
        try {
            const source = await Promise.race([
                pluginCall(plugin.hash, "getMediaSource", item, quality) as Promise<
                    IPlugin.IMediaSourceResult | null
                >,
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error("音源响应超时")), PROBE_TIMEOUT),
                ),
            ]);
            if (source?.url) {
                return true;
            }
        } catch {
            // 这一档拿不到/超时：换 standard 再试一次
        }
    }
    return false;
}

export function scoreOf(song: INeteaseSong, cand: any): IScored {
    const ts = titleSim(song.name, cand.title);
    const as = artistSim(song.artists, cand.artist);
    const ds = durScore(song.durationMs, cand.duration);
    return { total: 0.55 * ts + 0.3 * as + 0.15 * ds, ts, as, ds };
}

/** ---------- 匹配结果与流程 ---------- */

export interface ISongMatch {
    song: INeteaseSong;
    status: "matched" | "missed";
    /** 命中来自映射缓存（未走插件搜索） */
    fromCache?: boolean;
    /** 靠详情复核才采信（低置信，导入后建议试听确认） */
    viaDetail?: boolean;
    /** 得分刚过线（低置信） */
    low?: boolean;
    /** 命中的可播放条目（platform = 音源插件的 platform，可直接进歌单/播放队列） */
    item?: IMusic.IMusicItem;
    matchedPlatform?: string;
    score?: number;
    /** 未命中时展示的最佳候选，便于人工判断 */
    bestTitle?: string;
    /** 与列表中更早的一首命中了同一首歌（按 音源+id），导入时只保留第一条 */
    duplicate?: boolean;
}

export function getMatchableSourcePlugins(): Promise<SerializedPlugin[]> {
    return getSortedSearchablePlugins().then((plugins) =>
        plugins.filter((p) => !VIDEO_SOURCE.test(p.platform)),
    );
}

function toMusicItem(platform: string, cand: any, song?: INeteaseSong): IMusic.IMusicItem {
    return {
        platform,
        id: String(cand.id),
        title: cand.title,
        artist: cand.artist,
        album: cand.album,
        duration: cand.duration,
        artwork: cand.artwork || cand.coverImg,
        // 网易原曲 id：评论区等网易侧功能按它直接定位歌曲，免去运行时标题反查
        ...(song ? { neteaseId: song.id } : {}),
    };
}

/** 对单个候选做详情复核：专辑一致 + 时长差 ≤3s 即铁证 */
async function recheckViaDetail(
    plugin: SerializedPlugin,
    cand: any,
    song: INeteaseSong,
): Promise<{ album?: string; duration?: number } | null> {
    if (!plugin.supportedMethods.includes("getMusicInfo")) {
        return null;
    }
    try {
        const info = (await pluginCall(plugin.hash, "getMusicInfo", { ...cand })) ?? {};
        return { album: info.album, duration: info.duration };
    } catch {
        return null;
    }
}

export interface IMatchOptions {
    /** 并发数（每路串行按歌消费） */
    concurrency?: number;
    /**
     * 上一轮的匹配结果（重置会话时保留的那份）。
     * 拉到的曲目与上一轮完全一致（指纹逐首相同、音源插件未变）时整列表直接复用，
     * 一首都不再搜索；有出入时只对没变的歌用映射缓存，变了的照常匹配。
     */
    previous?: ISongMatch[];
    /**
     * 限定参与匹配的音源插件 hash 列表（歌单音源管理的「选择音源 / 指定音源替换」用）。
     * 不传或为空 = 全部可用音源；传入后会再过滤一遍（已卸载/禁用的自动剔除）。
     */
    sourceHashes?: string[];
    /** 每完成一首回调一次（含未命中），页面据此渐进渲染 */
    onResult?: (result: ISongMatch) => void;
    onProgress?: (done: number, total: number) => void;
    /** 取消旗标：翻页/关弹窗/卸载后不再发起新的搜索 */
    shouldContinue?: () => boolean;
}

export async function matchNeteaseSongs(
    songs: INeteaseSong[],
    options: IMatchOptions = {},
): Promise<ISongMatch[]> {
    const {
        concurrency = 4,
        onResult,
        onProgress,
        shouldContinue,
        previous,
        sourceHashes,
    } = options;
    let plugins = await getMatchableSourcePlugins();
    if (sourceHashes?.length) {
        const allowed = new Set(sourceHashes);
        plugins = plugins.filter((p) => allowed.has(p.hash));
    }
    if (!plugins.length) {
        throw new NoMatchSourceError();
    }

    const results: ISongMatch[] = [];
    const seenKeys = new Map<string, number>(); // 音源+id → 首次命中的序号
    let done = 0;

    const report = (result: ISongMatch) => {
        results.push(result);
        done++;
        onProgress?.(done, songs.length);
        onResult?.(result);
    };

    /**
     * 复用上一轮结果的判定：曲目列表与上一轮完全一致（数量 + 逐首指纹相同），
     * 且上一轮每个命中的音源插件当前仍启用——此时音乐数据没变，匹配结果也不会变，
     * 直接原样复用（含未命中），一首都不搜。任何出入都退化到逐首流程。
     */
    if (previous?.length) {
        const prevBySongId = new Map(previous.map((m) => [m.song.id, m]));
        const identical =
            previous.length === songs.length &&
            songs.every((s) => {
                const prev = prevBySongId.get(s.id);
                return !!prev && fingerprintOf(prev.song) === fingerprintOf(s);
            }) &&
            previous.every(
                (m) =>
                    m.status !== "matched" ||
                    isCachedMatchValid({ item: m.item! }, plugins),
            );
        if (identical) {
            for (const [index, song] of songs.entries()) {
                const prev = prevBySongId.get(song.id)!;
                if (shouldContinue && !shouldContinue()) {
                    break;
                }
                report({ ...prev, fromCache: true });
            }
            flushMatchCache();
            return results;
        }
    }

    /**
     * 缓存优先：命中映射缓存的直接出结果（该曲目所属音源插件仍在启用列表才有效，
     * 插件被卸载/禁用后视为失效重新匹配），只有没缓存的才进队列做完整匹配。
     * 旧版本写入的缓存条目没有可播性标记（verified），进队列走 worker 补验——
     * 探测通过才采信（并回写标记），播不了的当作没缓存过重新匹配。
     */
    const queue: { song: INeteaseSong; index: number; cached?: ICachedMatch }[] = [];
    for (const [index, song] of songs.entries()) {
        const cached = getCachedMatch(song.id);
        if (
            cached &&
            isCachedMatchValid(cached, plugins) &&
            isCachedMatchFresh(cached, song)
        ) {
            if (cached.verified) {
                if (!shouldContinue || shouldContinue()) {
                    report(
                        finalize(
                            {
                                song,
                                status: "matched",
                                fromCache: true,
                                item: cached.item,
                                matchedPlatform: cached.item.platform,
                                score: cached.score,
                                viaDetail: cached.viaDetail,
                                low: cached.score < MIN_SCORE + 0.07,
                            },
                            index,
                        ),
                    );
                }
            } else {
                queue.push({ song, index, cached });
            }
        } else {
            queue.push({ song, index });
        }
    }

    async function matchOne(song: INeteaseSong, index: number): Promise<ISongMatch> {
        const query = `${song.name} ${song.artists[0] ?? ""}`.trim();
        // 每个音源取搜索结果里的最高分候选，再跨音源比出总赢家
        const perSource: { plugin: SerializedPlugin; cand: any; score: IScored }[] = [];
        for (const plugin of plugins) {
            if (shouldContinue && !shouldContinue()) {
                break;
            }
            let data: any[] = [];
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const r = await pluginCall(plugin.hash, "search", query, 1, "music");
                    data = r?.data ?? [];
                    break;
                } catch (e: any) {
                    if (attempt > 0) {
                        console.warn(
                            `[neteaseMatch] ${plugin.platform} 搜索失败 #${index + 1}「${song.name}」:`,
                            e?.message,
                        );
                    }
                    await sleep(700);
                }
            }
            const best = data
                .slice(0, 12)
                .map((cand) => ({ cand, score: scoreOf(song, cand) }))
                .sort((a, b) => b.score.total - a.score.total)[0];
            if (best) {
                perSource.push({ plugin, cand: best.cand, score: best.score });
            }
            await sleep(120);
        }
        if (shouldContinue && !shouldContinue()) {
            return { song, status: "missed" };
        }

        perSource.sort((a, b) => b.score.total - a.score.total);

        /**
         * 可播性闸门：按分数从高到低逐个探测「拿不拿得到可播放的直链」，
         * 不可播的源直接跳过、由下一位顶上。最多探测 3 个（与详情复核窗口一致）；
         * 已有过线的可播候选就不再多探——典型情况每首歌只多一次 getMediaSource。
         */
        const playableSources: typeof perSource = [];
        for (const entry of perSource.slice(0, 3)) {
            if (playableSources.some((p) => isPassing(p.score))) {
                break;
            }
            if (shouldContinue && !shouldContinue()) {
                break;
            }
            if (
                await probePlayable(entry.plugin, toMusicItem(entry.plugin.platform, entry.cand, song))
            ) {
                playableSources.push(entry);
            }
        }

        let winner = playableSources[0];

        // 没过线的拿详情复核：专辑一致 + 时长差≤3s 才翻案（只在真能播的候选里翻）
        if (winner && !isPassing(winner.score)) {
            for (const cand of playableSources) {
                const info = await recheckViaDetail(cand.plugin, cand.cand, song);
                if (!info) {
                    continue;
                }
                const durOk =
                    !!info.duration &&
                    Math.abs(info.duration - song.durationMs / 1000) <= 3;
                const albumOk =
                    !!info.album && titleSim(info.album, song.album) >= 0.9;
                if (durOk && cand.score.ts >= 0.9 && (albumOk || cand.score.as >= 0.8)) {
                    winner = {
                        plugin: cand.plugin,
                        cand: { ...cand.cand, album: info.album, duration: info.duration },
                        score: { ...cand.score, ds: 1 },
                    };
                    const viaDetailMatch: ISongMatch = {
                        song,
                        status: "matched",
                        viaDetail: true,
                        item: toMusicItem(winner.plugin.platform, winner.cand, song),
                        matchedPlatform: winner.plugin.platform,
                        score: +winner.score.total.toFixed(2),
                    };
                    return finalize(viaDetailMatch, index);
                }
            }
        }

        if (winner && isPassing(winner.score)) {
            return finalize(
                {
                    song,
                    status: "matched",
                    low: winner.score.total < MIN_SCORE + 0.07,
                    item: toMusicItem(winner.plugin.platform, winner.cand, song),
                    matchedPlatform: winner.plugin.platform,
                    score: +winner.score.total.toFixed(2),
                },
                index,
            );
        }
        // 未命中线索取最高分的候选：它是「本来最像的一首」，即使因为不可播没被采信
        const hint = winner ?? perSource[0];
        return {
            song,
            status: "missed",
            bestTitle: hint
                ? `「${hint.cand.title}」${hint.cand.artist ?? ""}（${hint.plugin.platform}，${hint.score.total.toFixed(2)} 分${
                    winner ? "" : "，但拿不到可播放的链接"
                  }）`
                : undefined,
        };
    }

    /** 命中后统一处理源内重复：与更早的歌命中了同一首时只保留第一条；全新命中回写映射缓存 */
    function finalize(match: ISongMatch, index: number): ISongMatch {
        if (match.item) {
            const key = `${match.item.platform}-${match.item.id}`;
            if (seenKeys.has(key)) {
                match.duplicate = true;
            } else {
                seenKeys.set(key, index);
                if (!match.fromCache) {
                    putCachedMatch(
                        match.song.id,
                        match.item,
                        match.score ?? 0,
                        match.viaDetail,
                        fingerprintOf(match.song),
                    );
                }
            }
        }
        return match;
    }

    async function worker() {
        while (queue.length && (!shouldContinue || shouldContinue())) {
            const next = queue.shift()!;
            if (next.cached) {
                // 旧缓存补验：直链现在拿得到才采信（回写 verified 标记，下次走快路），
                // 拿不到就当没缓存过，降级走完整匹配
                const plugin = plugins.find(
                    (p) => p.platform === next.cached!.item.platform,
                );
                if (plugin && (await probePlayable(plugin, next.cached.item))) {
                    putCachedMatch(
                        next.song.id,
                        next.cached.item,
                        next.cached.score,
                        next.cached.viaDetail,
                        fingerprintOf(next.song),
                    );
                    if (!shouldContinue || shouldContinue()) {
                        report(
                            finalize(
                                {
                                    song: next.song,
                                    status: "matched",
                                    fromCache: true,
                                    item: next.cached.item,
                                    matchedPlatform: next.cached.item.platform,
                                    score: next.cached.score,
                                    viaDetail: next.cached.viaDetail,
                                    low: next.cached.score < MIN_SCORE + 0.07,
                                },
                                next.index,
                            ),
                        );
                    }
                    continue;
                }
            }
            const result = await matchOne(next.song, next.index);
            // 已取消时结果不再外报，避免页面卸载后还刷状态
            if (!shouldContinue || shouldContinue()) {
                report(result);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    // 把本次新写入的映射落盘（防抖兜底）
    flushMatchCache();

    return results;
}
