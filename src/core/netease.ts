import { ipcInvoke } from "./ipc";

/**
 * 网易云账号与每日推荐的渲染进程客户端。
 * cookie 只存在主进程（safeStorage 加密），渲染层只拿归一化后的数据；
 * 登录过期时数据接口抛 NeteaseNeedLoginError，由页面引导重新扫码。
 */

export class NeteaseNeedLoginError extends Error {
    constructor() {
        super("网易云登录已过期，请重新扫码登录");
        this.name = "NeteaseNeedLoginError";
    }
}

/** 归一化后的网易云歌曲（新旧字段风格都收：ar/al/dt 与 artists/album/duration） */
export interface INeteaseSong {
    id: string;
    name: string;
    artists: string[];
    album: string;
    durationMs: number;
    /** 0 免费 / 1 VIP / 4 购买专辑 / 8 非会员可播放低音质 */
    fee: number;
    artwork: string;
}

export interface INeteasePlaylistCard {
    id: string;
    title: string;
    artwork: string;
    /** 播放次数（接口给的是 1.5E8 这类科学计数法，展示时再格式化） */
    playCount?: number;
    trackCount?: number;
    source: "daily" | "personalized";
}

function neteaseSongFromApi(s: any): INeteaseSong {
    const artists: string[] = (s.ar ?? s.artists ?? []).map((a: any) => a.name).filter(Boolean);
    return {
        id: String(s.id),
        name: s.name ?? s.title ?? "",
        artists,
        album: s.al?.name ?? s.album?.name ?? "",
        durationMs: s.dt ?? s.duration ?? 0,
        fee: s.fee ?? 0,
        artwork: s.al?.picUrl ?? s.album?.picUrl ?? s.picUrl ?? "",
    };
}

export async function getNeteaseStatus(): Promise<{ loggedIn: boolean }> {
    return ipcInvoke("netease:getStatus");
}

/** 当前登录的网易云账号资料（未登录/获取失败为 null） */
export interface INeteaseProfile {
    userId: string;
    nickname: string;
    avatarUrl: string;
}

/**
 * 模块级缓存的账号资料：页面挂载初始化时（还没发异步请求）就要用它决定
 * 快照/会话归属哪个账号，只能靠上一轮请求留下的这份缓存同步取。
 */
let cachedProfile: INeteaseProfile | null = null;

export function getCachedNeteaseProfile(): INeteaseProfile | null {
    return cachedProfile;
}

export async function getNeteaseAccountInfo(): Promise<INeteaseProfile | null> {
    const res = await ipcInvoke("netease:getAccountInfo");
    if (!res?.success) {
        // 拿不到资料不抛错：只影响「识别换号」与设置页展示，不当成登录失败
        return null;
    }
    cachedProfile = (res.data as INeteaseProfile | null) ?? null;
    return cachedProfile;
}

export async function openNeteaseLogin(): Promise<{
    success: boolean;
    canceled?: boolean;
    message?: string;
}> {
    return ipcInvoke("netease:login");
}

export async function neteaseLogout(): Promise<void> {
    cachedProfile = null;
    await ipcInvoke("netease:logout");
}

/** 解包主进程的 {success, data | message, needLogin} 约定 */
async function unwrap<T>(channel: string, ...args: any[]): Promise<T> {
    const res = await ipcInvoke(channel, ...args);
    if (!res?.success) {
        if (res?.needLogin) {
            throw new NeteaseNeedLoginError();
        }
        throw new Error(res?.message ?? "网易云接口请求失败");
    }
    return res.data as T;
}

export async function fetchNeteaseDailySongs(): Promise<INeteaseSong[]> {
    const songs = await unwrap<any[]>("netease:getDailySongs");
    return songs.map(neteaseSongFromApi);
}

export async function fetchNeteaseRecommendPlaylists(): Promise<INeteasePlaylistCard[]> {
    const list = await unwrap<any[]>("netease:getRecommendPlaylists");
    return list.map((it) => ({
        id: String(it.id),
        title: it.name ?? "",
        artwork: it.picUrl ?? "",
        playCount: Number(it.playCount) || 0,
        trackCount: it.trackCount,
        source: "daily" as const,
    }));
}

export async function fetchNeteasePersonalizedPlaylists(limit = 30): Promise<INeteasePlaylistCard[]> {
    const list = await unwrap<any[]>("netease:getPersonalizedPlaylists", limit);
    return list.map((it) => ({
        id: String(it.id),
        title: it.name ?? "",
        artwork: it.picUrl ?? "",
        playCount: Number(it.playCount) || 0,
        trackCount: it.trackCount,
        source: "personalized" as const,
    }));
}

export async function fetchNeteasePlaylistDetail(
    id: string,
): Promise<{ name: string; songs: INeteaseSong[] }> {
    const { name, tracks } = await unwrap<{ name: string; tracks: any[] }>(
        "netease:getPlaylistDetail",
        id,
    );
    return { name, songs: tracks.map(neteaseSongFromApi) };
}

/** 播放次数格式化：接口给的是 1.5080416E8 这类科学计数法字符串 */
export function formatPlayCount(count?: number): string {
    const n = Number(count) || 0;
    if (n >= 1e8) {
        return `${(n / 1e8).toFixed(1)}亿`;
    }
    if (n >= 1e4) {
        return `${Math.round(n / 1e4)}万`;
    }
    return n ? String(n) : "";
}

/** ---------- 歌曲评论 ---------- */

export interface INeteaseCommentUser {
    userId: string;
    nickname: string;
    avatarUrl: string;
    /** >0 时展示 VIP 徽标（网易云样式） */
    vipType?: number;
}

export interface INeteaseComment {
    commentId: string;
    content: string;
    /** 时间戳（毫秒），展示按 今天 HH:mm / 今年 MM-DD / 更早 YYYY-MM-DD 格式化 */
    time: number;
    timeStr: string;
    likedCount: number;
    liked: boolean;
    user: INeteaseCommentUser;
    /** 回复的引用上下文（最新评论流里回复按网易云样式混排，引用条展示被回复人） */
    beReplied: { content: string; user: INeteaseCommentUser }[];
    /** 是回复时指向被回复的评论 id（顶层评论无） */
    parentCommentId?: string;
}

export interface INeteaseCommentsPage {
    total: number;
    /** 最新评论是否还有下一页 */
    hasMore: boolean;
    hotComments: INeteaseComment[];
    comments: INeteaseComment[];
    /** 当前登录用户 userId（未登录时接口给 -1） */
    userId: string;
}

function commentUserFromApi(u: any): INeteaseCommentUser {
    return {
        userId: String(u?.userId ?? ""),
        nickname: u?.nickname ?? "网易用户",
        avatarUrl: u?.avatarUrl ?? "",
        vipType: typeof u?.vipType === "number" ? u.vipType : 0,
    };
}

function commentFromApi(c: any): INeteaseComment {
    return {
        commentId: String(c?.commentId ?? ""),
        content: c?.content ?? "",
        time: typeof c?.time === "number" ? c.time : 0,
        timeStr: c?.timeStr ?? "",
        likedCount: c?.likedCount ?? 0,
        liked: !!c?.liked,
        user: commentUserFromApi(c?.user),
        beReplied: (Array.isArray(c?.beReplied) ? c.beReplied : []).map((r: any) => ({
            content: r?.content ?? "",
            user: commentUserFromApi(r?.user),
        })),
        parentCommentId: c?.parentCommentId ? String(c.parentCommentId) : undefined,
    };
}

/**
 * 歌曲评论（网易云桌面端同款模型）：hotComments 为热评块（纯热评降序），
 * comments 为最新块（回复按时间混排、带 beReplied 引用）。
 * 未登录也能读；带登录 cookie 时评论才带 liked 状态。
 *
 * offset 分页有服务端上限（热门歌曲约 1100 条处就 more=false，远小于 total），
 * 要翻完整流须传 beforeTime（上一页最后一条的 time，此时 offset 传 0）。
 */
export async function fetchNeteaseSongComments(
    songId: string,
    { limit = 30, offset = 0, beforeTime = 0 }: { limit?: number; offset?: number; beforeTime?: number } = {},
): Promise<INeteaseCommentsPage> {
    const j = await unwrap<any>("netease:getSongComments", songId, limit, offset, beforeTime);
    return {
        total: j?.total ?? 0,
        hasMore: !!j?.more,
        hotComments: (Array.isArray(j?.hotComments) ? j.hotComments : []).map(commentFromApi),
        comments: (Array.isArray(j?.comments) ? j.comments : []).map(commentFromApi),
        userId: String(j?.userId ?? "-1"),
    };
}

export async function likeNeteaseComment(songId: string, commentId: string, like: boolean): Promise<void> {
    await unwrap<void>("netease:likeComment", songId, commentId, like);
}

/** 发表评论；带 replyCommentId 时为回复（落进目标评论的楼中楼） */
export async function addNeteaseComment(
    songId: string,
    content: string,
    replyCommentId?: string,
): Promise<void> {
    await unwrap<void>("netease:addComment", songId, content, replyCommentId);
}

export async function deleteNeteaseComment(songId: string, commentId: string): Promise<void> {
    await unwrap<void>("netease:deleteComment", songId, commentId);
}

/** 关键词搜网易歌曲（免登录）：给「播放曲 → 网易歌曲 id」反查用 */
export async function searchNeteaseSongs(keyword: string, limit = 10): Promise<INeteaseSong[]> {
    const songs = await unwrap<any[]>("netease:searchSongs", keyword, limit);
    return songs.map(neteaseSongFromApi);
}

/** 歌曲红心（喜欢）数量；countDesc 是网易自己的展示格式（如「100w+」） */
export interface INeteaseSongRedCount {
    count: number;
    countDesc: string | null;
}

export async function fetchNeteaseSongRedCount(songId: string): Promise<INeteaseSongRedCount> {
    return unwrap<INeteaseSongRedCount>("netease:getSongRedCount", songId);
}

/** 精彩评论（热门评论独立分页） */
export interface INeteaseHotCommentsPage {
    total: number;
    hasMore: boolean;
    comments: INeteaseComment[];
}

export async function fetchNeteaseHotComments(
    songId: string,
    { limit = 30, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<INeteaseHotCommentsPage> {
    const j = await unwrap<any>("netease:getHotComments", songId, limit, offset);
    return {
        total: j?.total ?? 0,
        hasMore: !!j?.hasMore,
        comments: (Array.isArray(j?.hotComments) ? j.hotComments : []).map(commentFromApi),
    };
}
