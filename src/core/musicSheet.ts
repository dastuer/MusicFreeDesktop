import { nanoid } from "nanoid";
import { ipcInvoke } from "./ipc";

/**
 * 用户歌单（收藏/自建）：持久化在主进程 configStore
 */

export interface IUserSheet {
    id: string;
    title: string;
    createAt: number;
    musicList: IMusic.IMusicItem[];
}

export async function getUserSheets(): Promise<IUserSheet[]> {
    return (await ipcInvoke("config:get", "userSheets", [])) ?? [];
}

async function saveSheets(sheets: IUserSheet[]) {
    await ipcInvoke("config:set", "userSheets", sheets);
}

export async function createSheet(title: string): Promise<IUserSheet> {
    const sheet: IUserSheet = {
        id: nanoid(8),
        title,
        createAt: Date.now(),
        musicList: [],
    };
    const sheets = await getUserSheets();
    sheets.unshift(sheet);
    await saveSheets(sheets);
    return sheet;
}

export async function deleteSheet(id: string) {
    const sheets = await getUserSheets();
    await saveSheets(sheets.filter((it) => it.id !== id));
}

export async function getSheetById(id: string): Promise<IUserSheet | undefined> {
    const sheets = await getUserSheets();
    return sheets.find((it) => it.id === id);
}

export async function addMusicToSheet(id: string, musicItem: IMusic.IMusicItem) {
    const sheets = await getUserSheets();
    const sheet = sheets.find((it) => it.id === id);
    if (!sheet) {
        return;
    }
    const exists = sheet.musicList.some(
        (it) => it.id === musicItem.id && it.platform === musicItem.platform,
    );
    if (!exists) {
        sheet.musicList.unshift(musicItem);
    }
    await saveSheets(sheets);
}

export async function removeMusicFromSheet(id: string, musicItem: IMusic.IMusicItem) {
    const sheets = await getUserSheets();
    const sheet = sheets.find((it) => it.id === id);
    if (!sheet) {
        return;
    }
    sheet.musicList = sheet.musicList.filter(
        (it) => !(it.id === musicItem.id && it.platform === musicItem.platform),
    );
    await saveSheets(sheets);
}

export async function renameSheet(id: string, title: string) {
    const sheets = await getUserSheets();
    const sheet = sheets.find((it) => it.id === id);
    if (sheet) {
        sheet.title = title;
        await saveSheets(sheets);
    }
}

/** 「我喜欢的音乐」：固定 id 的特殊歌单 */
export const LIKES_SHEET_ID = "my-likes";
export const LIKES_SHEET_TITLE = "我喜欢的音乐";

export async function ensureLikesSheet(): Promise<IUserSheet> {
    const sheets = await getUserSheets();
    let likes = sheets.find((it) => it.id === LIKES_SHEET_ID);
    if (!likes) {
        likes = {
            id: LIKES_SHEET_ID,
            title: LIKES_SHEET_TITLE,
            createAt: 0,
            musicList: [],
        };
        await saveSheets([likes, ...sheets]);
    }
    return likes;
}

function isSameMedia(a: IMusic.IMusicItem, b: IMusic.IMusicItem) {
    return a.id === b.id && a.platform === b.platform;
}

export async function isLiked(musicItem: IMusic.IMusicItem): Promise<boolean> {
    const likes = await ensureLikesSheet();
    return likes.musicList.some((it) => isSameMedia(it, musicItem));
}

/** 喜欢/取消喜欢，返回操作后的状态 */
export async function toggleLike(musicItem: IMusic.IMusicItem): Promise<boolean> {
    await ensureLikesSheet();
    const sheets = await getUserSheets();
    const likes = sheets.find((it) => it.id === LIKES_SHEET_ID)!;
    const idx = likes.musicList.findIndex((it) => isSameMedia(it, musicItem));
    if (idx >= 0) {
        likes.musicList.splice(idx, 1);
        await saveSheets(sheets);
        return false;
    }
    likes.musicList.unshift(musicItem);
    await saveSheets(sheets);
    return true;
}
