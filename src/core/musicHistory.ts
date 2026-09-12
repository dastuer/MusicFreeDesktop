import { ipcInvoke } from "./ipc";

/**
 * 播放历史：主进程 configStore 持久化
 */

export interface HistoryItem extends IMusic.IMusicItem {
    playAt: number;
}

/**
 * 历史条目里不带大体积内联封面。
 * 音源可能把整张封面塞成 base64（见过 13 MB 的 PNG），
 * 每播一首就往 store.json 写一次这种串，文件会被撑到几百 MB。
 */
const MAX_HISTORY_ARTWORK = 64 * 1024;

function slimArtwork<T extends IMusic.IMusicItem>(item: T): T {
    if (typeof item.artwork === "string" && item.artwork.length > MAX_HISTORY_ARTWORK) {
        return { ...item, artwork: "" };
    }
    return item;
}

export async function setMusicHistory(musicItem: IMusic.IMusicItem) {
    try {
        const history: HistoryItem[] = await ipcInvoke("config:get", "musicHistory", []);
        const filtered = history.filter(
            (it) => !(it.id === musicItem.id && it.platform === musicItem.platform),
        );
        filtered.unshift({ ...slimArtwork(musicItem), playAt: Date.now() });
        // 顺手清掉历史里残留的大体积封面，避免旧数据一直占着 store.json
        const cleaned = filtered.slice(0, 300).map(slimArtwork);
        await ipcInvoke("config:set", "musicHistory", cleaned);
    } catch {
        // ignore
    }
}

export async function getMusicHistory(): Promise<HistoryItem[]> {
    try {
        return (await ipcInvoke("config:get", "musicHistory", [])) ?? [];
    } catch {
        return [];
    }
}

export async function clearMusicHistory() {
    await ipcInvoke("config:set", "musicHistory", []);
}
