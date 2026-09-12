import { ipcInvoke } from "./ipc";

/**
 * 播放历史：主进程 configStore 持久化
 */

export interface HistoryItem extends IMusic.IMusicItem {
    playAt: number;
}

export async function setMusicHistory(musicItem: IMusic.IMusicItem) {
    try {
        const history: HistoryItem[] = await ipcInvoke("config:get", "musicHistory", []);
        const filtered = history.filter(
            (it) => !(it.id === musicItem.id && it.platform === musicItem.platform),
        );
        filtered.unshift({ ...musicItem, playAt: Date.now() });
        await ipcInvoke("config:set", "musicHistory", filtered.slice(0, 300));
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
