import { ipcInvoke, pluginCall, getSortedPluginsWithAbility, SerializedPlugin } from "./ipc";
import { artistSim, titleSim } from "./neteaseMatch";

/**
 * 本地歌曲的歌词匹配（loadCurrentLyric 在本地条目没歌词时调这里）：
 *
 * 优先级（命中即止，命中远程后写回文件）：
 *   1. 文件自带：内嵌歌词（MP3 USLT / FLAC LYRICS）→ 同名 .lrc 边车（主进程读，见 services/localLyrics.ts）
 *   2. 会话内缓存：同一首不重复联网匹配；上次的联网结果也缓存在 localStorage（按歌词指纹键）
 *   3. 联网匹配：拿装机的 getLyric 音源插件按「标题+歌手」搜出同款曲目，再 getLyric
 *
 * 「本地歌曲拿不到歌词」的根因是 loadCurrentLyric 对 localPath 直接跳过插件；
 * 这里把它接回来：匹配成功还会经主进程把歌词/封面写进文件（USLT/LYRICS + PICTURE），
 * 下次就是「文件自带」，不再走网络。
 */

const REMOTE_CACHE_KEY = "localLyricCache.v1";
/** 缓存键不能只有 localPath：换歌不重命名文件会串。键 = 路径 + 标题 + 歌手（内容指纹） */
function lyricCacheKey(item: IMusic.IMusicItem) {
    return `${item.localPath}|${item.title}|${item.artist}`;
}

interface ICachedRemoteLyric {
    rawLrc: string;
    translation?: string;
    cachedAt: number;
}

let remoteCache: Record<string, ICachedRemoteLyric> | null = null;

function loadCache(): Record<string, ICachedRemoteLyric> {
    if (remoteCache) {
        return remoteCache;
    }
    try {
        const parsed = JSON.parse(localStorage.getItem(REMOTE_CACHE_KEY) ?? "{}");
        remoteCache = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        remoteCache = {};
    }
    return remoteCache!;
}

function saveCache(cache: Record<string, ICachedRemoteLyric>) {
    // 容量控制：只留最近 500 条（一首 LRC 几 KB，500 条 <1MB，localStorage 装得下）
    const entries = Object.entries(cache).sort((a, b) => b[1].cachedAt - a[1].cachedAt).slice(0, 500);
    try {
        localStorage.setItem(REMOTE_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
        // 满了就放弃持久化，会话内那份还在
    }
}

function splitArtists(artist: string): string[] {
    return String(artist ?? "")
        .split(/[/、,;&]|feat\.?|ft\.?/i)
        .map((s) => s.trim())
        .filter(Boolean);
}

/** 同一首的在途匹配不重发（桌面歌词与详情页会先后各要一次） */
const inflight = new Map<string, Promise<ILyric.ILyricSource | null>>();

export function clearLocalLyricCache() {
    remoteCache = {};
    localStorage.removeItem(REMOTE_CACHE_KEY);
}

/**
 * 给一条本地曲目找歌词。找不到返回 null（调用方按「没有歌词」处理）。
 * 文件自带（含 .lrc）由主进程读；联网匹配成功会经主进程写回文件。
 */
export function matchLocalLyric(musicItem: IMusic.IMusicItem): Promise<ILyric.ILyricSource | null> {
    const key = lyricCacheKey(musicItem);
    const running = inflight.get(key);
    if (running) {
        return running;
    }
    const task = doMatchLocalLyric(musicItem, key).finally(() => {
        inflight.delete(key);
    });
    inflight.set(key, task);
    return task;
}

async function doMatchLocalLyric(
    musicItem: IMusic.IMusicItem,
    key: string,
): Promise<ILyric.ILyricSource | null> {
    // 1. 文件自带 / 同名 .lrc
    try {
        const embedded = await ipcInvoke<string | null>("localLyrics:read", {
            localPath: musicItem.localPath,
            title: musicItem.title,
            artist: musicItem.artist,
        });
        if (embedded && embedded.trim()) {
            return { rawLrc: embedded };
        }
    } catch {
        // 主进程读不了就算了
    }

    // 2. 上次的联网匹配结果
    const cached = loadCache()[key];
    if (cached?.rawLrc) {
        return { rawLrc: cached.rawLrc, translation: cached.translation };
    }

    // 3. 联网：有 getLyric 的音源插件按标题+歌手搜同款，逐个要歌词
    const plugins = await getLyricSourcePlugins();
    if (!plugins.length) {
        return null;
    }
    const artists = splitArtists(musicItem.artist);
    const query = `${musicItem.title} ${artists[0] ?? ""}`.trim();

    for (const plugin of plugins) {
        try {
            const result = await pluginCall(plugin.hash, "search", query, 1, "music");
            const candidates: any[] = (result?.data ?? []).slice(0, 8);
            // 与 neteaseMatch 同一套相似度口径（时长没有就 0.75 保底分档）
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
                continue;
            }
            const lyricSource = await pluginCall(plugin.hash, "getLyric", best.cand);
            const rawLrc = String(lyricSource?.rawLrc ?? "");
            if (!rawLrc.trim()) {
                continue;
            }
            const translation = String(lyricSource?.translation ?? "") || undefined;
            const source: ILyric.ILyricSource = { rawLrc, translation };
            // 会话外记一笔，下次重启直接命中
            const cache = loadCache();
            cache[key] = { rawLrc, translation, cachedAt: Date.now() };
            saveCache(cache);
            // 写回文件（尽力而为）：下次就是「文件自带」；封面落缓存 + 更新列表 artwork 由主进程做
            void ipcInvoke("localLyrics:applyRemote", {
                localPath: musicItem.localPath,
                lyrics: translation ? `${rawLrc}\n${translation}` : rawLrc,
                artworkUrl: musicItem.artwork && !musicItem.artwork.startsWith("mfs://cover/")
                    ? musicItem.artwork
                    : best.cand?.artwork || undefined,
            }).catch(() => undefined);
            return source;
        } catch {
            // 这个音源不行，下一个
        }
    }
    return null;
}

/** 装了又启用了 getLyric 的插件（排除视频源：B 站类歌词质量差还慢） */
const VIDEO_SOURCE = /哔哩|bilibili|b站|youtube/i;
let lyricPluginsCache: SerializedPlugin[] | null = null;

async function getLyricSourcePlugins(): Promise<SerializedPlugin[]> {
    if (!lyricPluginsCache) {
        lyricPluginsCache = (await getSortedPluginsWithAbility("getLyric")).filter(
            (p) => !VIDEO_SOURCE.test(p.platform),
        );
    }
    return lyricPluginsCache;
}
