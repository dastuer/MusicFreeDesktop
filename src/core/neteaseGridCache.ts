import { INeteasePlaylistCard } from "./netease";

/**
 * 每日推荐「推荐歌单」网格的持久缓存（localStorage，跨应用重启存活）。
 *
 * 网格只在三种时机刷新：手动点刷新按钮、跨天后的首次加载、更换网易云账号。
 * 其余情况——页面反复进出、同一天内重启应用——一律用缓存，绝不后台重拉：
 * 个性化接口每次返回的卡片有出入，自动刷新会让正在看/正在播放的歌单卡片
 * 从网格里消失（匹配会话还在，但入口没了）。
 */
const KEY = "neteaseDaily.gridCache";

export interface IGridCache {
    /** 缓存归属日期（YYYY-MM-DD），跨天自然失效 */
    date: string;
    /** 缓存归属的网易云账号 userId，换号失效 */
    userId: string;
    playlists: INeteasePlaylistCard[];
}

export function readGridCache(): IGridCache | null {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) {
            return null;
        }
        const parsed = JSON.parse(raw);
        if (parsed?.date && Array.isArray(parsed.playlists)) {
            return parsed as IGridCache;
        }
    } catch {
        // 损坏/空间不足就当没有，页面按无缓存处理
    }
    return null;
}

export function writeGridCache(cache: IGridCache) {
    try {
        localStorage.setItem(KEY, JSON.stringify(cache));
    } catch {
        // 存不进去不影响页面，内存里的状态照常用
    }
}
