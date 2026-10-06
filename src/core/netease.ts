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

export async function openNeteaseLogin(): Promise<{
    success: boolean;
    canceled?: boolean;
    message?: string;
}> {
    return ipcInvoke("netease:login");
}

export async function neteaseLogout(): Promise<void> {
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
