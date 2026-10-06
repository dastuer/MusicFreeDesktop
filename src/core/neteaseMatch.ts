import { pluginCall, SerializedPlugin, getSortedSearchablePlugins } from "./ipc";
import { INeteaseSong } from "./netease";

/**
 * 网易云推荐歌曲 → 本地音源插件 匹配器。
 *
 * 打分与采信口径移植自 import-netease-playlist 技能脚本（已在真实歌单上验证过）：
 * 搜索「歌名 + 第一位歌手」，标题相似度 0.55 + 歌手相似度 0.3 + 时长相似度 0.15；
 * 过线条件 total≥0.78 且标题≥0.8 且歌手≥0.6，未过线的候选拿 getMusicInfo
 * 用「专辑一致 + 时长差≤3s」复核（歌手名转写会误杀，如 Gyubin↔규빈）。
 *
 * 视频源（B 站类）默认排除：时长对不上，命中率极低还拖慢整体。
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

function toMusicItem(platform: string, cand: any): IMusic.IMusicItem {
    return {
        platform,
        id: String(cand.id),
        title: cand.title,
        artist: cand.artist,
        album: cand.album,
        duration: cand.duration,
        artwork: cand.artwork || cand.coverImg,
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
    const { concurrency = 4, onResult, onProgress, shouldContinue } = options;
    const plugins = await getMatchableSourcePlugins();
    if (!plugins.length) {
        throw new NoMatchSourceError();
    }
    const pluginByPlatform = new Map(plugins.map((p) => [p.platform, p]));

    const results: ISongMatch[] = [];
    const seenKeys = new Map<string, number>(); // 音源+id → 首次命中的序号
    const queue = songs.map((song, index) => ({ song, index }));
    let done = 0;

    const report = (result: ISongMatch) => {
        results.push(result);
        done++;
        onProgress?.(done, songs.length);
        onResult?.(result);
    };

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
        let winner = perSource[0];

        // 没过线的拿详情复核：专辑一致 + 时长差≤3s 才翻案
        if (winner && !(winner.score.total >= MIN_SCORE && winner.score.ts >= 0.8 && winner.score.as >= 0.6)) {
            for (const cand of perSource.slice(0, 3)) {
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
                        item: toMusicItem(winner.plugin.platform, winner.cand),
                        matchedPlatform: winner.plugin.platform,
                        score: +winner.score.total.toFixed(2),
                    };
                    return finalize(viaDetailMatch, index);
                }
            }
        }

        if (winner && winner.score.total >= MIN_SCORE && winner.score.ts >= 0.8 && winner.score.as >= 0.6) {
            return finalize(
                {
                    song,
                    status: "matched",
                    low: winner.score.total < MIN_SCORE + 0.07,
                    item: toMusicItem(winner.plugin.platform, winner.cand),
                    matchedPlatform: winner.plugin.platform,
                    score: +winner.score.total.toFixed(2),
                },
                index,
            );
        }
        return {
            song,
            status: "missed",
            bestTitle: winner
                ? `「${winner.cand.title}」${winner.cand.artist ?? ""}（${winner.plugin.platform}，${winner.score.total.toFixed(2)} 分）`
                : undefined,
        };
    }

    /** 命中后统一处理源内重复：与更早的歌命中了同一首时只保留第一条 */
    function finalize(match: ISongMatch, index: number): ISongMatch {
        if (match.item) {
            const key = `${match.item.platform}-${match.item.id}`;
            if (seenKeys.has(key)) {
                match.duplicate = true;
            } else {
                seenKeys.set(key, index);
            }
        }
        return match;
    }

    async function worker() {
        while (queue.length && (!shouldContinue || shouldContinue())) {
            const next = queue.shift()!;
            const result = await matchOne(next.song, next.index);
            // 已取消时结果不再外报，避免页面卸载后还刷状态
            if (!shouldContinue || shouldContinue()) {
                report(result);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

    return results;
}
