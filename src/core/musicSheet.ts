import { nanoid } from "nanoid";
import { atom, getDefaultStore } from "jotai";
import { ipcInvoke } from "./ipc";

/**
 * 用户歌单（收藏/自建）：持久化在主进程 configStore
 */

/** 喜欢列表版本号：任何喜欢状态变化后自增，驱动列表刷新红心状态 */
export const likesVersionAtom = atom(0);

function bumpLikesVersion() {
    const store = getDefaultStore();
    store.set(likesVersionAtom, store.get(likesVersionAtom) + 1);
}

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

/** 歌单内去重用的键（与 MusicList 的 musicKey 同构） */
function mediaKey(musicItem: IMusic.IMusicItem) {
    return `${musicItem.platform}-${musicItem.id}`;
}

/**
 * 批量添加到歌单：一次读取、一次落盘。
 * 歌曲已在歌单内（或传入数组自身有重复）时跳过，返回实际新增/跳过的条数。
 * 目标是我喜欢的音乐时顺带自增喜欢版本号，红心状态才会跟着刷新。
 */
export async function addMusicToSheetMany(
    id: string,
    musicItems: IMusic.IMusicItem[],
): Promise<{ added: number; skipped: number }> {
    if (!musicItems.length) {
        return { added: 0, skipped: 0 };
    }
    const sheets = await getUserSheets();
    const sheet = sheets.find((it) => it.id === id);
    if (!sheet) {
        return { added: 0, skipped: 0 };
    }
    const seen = new Set(sheet.musicList.map(mediaKey));
    const toAdd: IMusic.IMusicItem[] = [];
    for (const musicItem of musicItems) {
        const key = mediaKey(musicItem);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        toAdd.push(musicItem);
    }
    if (toAdd.length) {
        // unshift(...toAdd) 本身按序插入，新歌会以「原列表里看到的顺序」排在歌单最前。
        // 注意别顺手加 reverse（batchSetLike 那种「逐个点赞、最新在最上」的语义不适用批量收藏）
        sheet.musicList.unshift(...toAdd);
        await saveSheets(sheets);
        if (id === LIKES_SHEET_ID) {
            bumpLikesVersion();
        }
    }
    return { added: toAdd.length, skipped: musicItems.length - toAdd.length };
}

export async function addMusicToSheet(id: string, musicItem: IMusic.IMusicItem) {
    await addMusicToSheetMany(id, [musicItem]);
}

/** 批量从歌单移除，返回实际移除的条数 */
export async function removeMusicFromSheetMany(
    id: string,
    musicItems: IMusic.IMusicItem[],
): Promise<number> {
    if (!musicItems.length) {
        return 0;
    }
    const sheets = await getUserSheets();
    const sheet = sheets.find((it) => it.id === id);
    if (!sheet) {
        return 0;
    }
    const removeKeys = new Set(musicItems.map(mediaKey));
    const before = sheet.musicList.length;
    sheet.musicList = sheet.musicList.filter((it) => !removeKeys.has(mediaKey(it)));
    const removed = before - sheet.musicList.length;
    if (removed) {
        await saveSheets(sheets);
        if (id === LIKES_SHEET_ID) {
            bumpLikesVersion();
        }
    }
    return removed;
}

export async function removeMusicFromSheet(id: string, musicItem: IMusic.IMusicItem) {
    await removeMusicFromSheetMany(id, [musicItem]);
}

/**
 * 歌单内音源替换：把 from 在原位置换成 to（不改变歌曲顺序，一次读取一次落盘）。
 *
 * 用于「重新匹配音乐 / 修复音源」：匹配出的新曲目顶掉旧条目，歌单的排列保持原样。
 * 逐对顺序处理，两道防线避免替换出重复行：
 *  - 目标曲目已在歌单里（占据别的行）→ 跳过这条替换；
 *  - 同一批里两行换成了同一首 → 先换的生效，后一条因上面的检查自然被跳过。
 *
 * @returns appliedPairs 是真正落盘的替换（播放队列同步用它，两边口径必须一致）
 */
export async function replaceMusicInSheetMany(
    id: string,
    replacements: { from: IMusic.IMusicItem; to: IMusic.IMusicItem }[],
): Promise<{
    applied: number;
    skipped: number;
    appliedPairs: { from: IMusic.IMusicItem; to: IMusic.IMusicItem }[];
}> {
    const appliedPairs: { from: IMusic.IMusicItem; to: IMusic.IMusicItem }[] = [];
    if (!replacements.length) {
        return { applied: 0, skipped: 0, appliedPairs };
    }
    const sheets = await getUserSheets();
    const sheet = sheets.find((it) => it.id === id);
    if (!sheet) {
        return { applied: 0, skipped: replacements.length, appliedPairs };
    }
    let skipped = 0;
    for (const { from, to } of replacements) {
        const fromIdx = sheet.musicList.findIndex(
            (it) => mediaKey(it) === mediaKey(from),
        );
        if (fromIdx < 0) {
            skipped++;
            continue;
        }
        // 目标曲目已占着别的行：换上去就出现重复行，跳过
        const conflict = sheet.musicList.some(
            (it, idx) => idx !== fromIdx && mediaKey(it) === mediaKey(to),
        );
        if (conflict) {
            skipped++;
            continue;
        }
        sheet.musicList[fromIdx] = to;
        appliedPairs.push({ from, to });
    }
    if (appliedPairs.length) {
        await saveSheets(sheets);
        if (id === LIKES_SHEET_ID) {
            bumpLikesVersion();
        }
    }
    return { applied: appliedPairs.length, skipped, appliedPairs };
}

export async function renameSheet(id: string, title: string) {
    const sheets = await getUserSheets();
    const sheet = sheets.find((it) => it.id === id);
    if (sheet) {
        sheet.title = title;
        await saveSheets(sheets);
    }
}

/**
 * 按传入顺序重排用户歌单（侧边栏拖动排序落盘用）。
 * 「我喜欢的音乐」不参与排序，永远钉在最前。
 */
export async function reorderSheets(orderedIds: string[]) {
    const sheets = await getUserSheets();
    const likes = sheets.filter((it) => it.id === LIKES_SHEET_ID);
    const others = sheets.filter((it) => it.id !== LIKES_SHEET_ID);
    const order = new Map(orderedIds.map((id, i) => [id, i]));
    others.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    await saveSheets([...likes, ...others]);
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

export async function getLikedMusicList(): Promise<IMusic.IMusicItem[]> {
    return (await ensureLikesSheet()).musicList;
}

/** 喜欢/取消喜欢，返回操作后的状态 */
export async function toggleLike(musicItem: IMusic.IMusicItem): Promise<boolean> {
    await ensureLikesSheet();
    const sheets = await getUserSheets();
    const likes = sheets.find((it) => it.id === LIKES_SHEET_ID)!;
    const idx = likes.musicList.findIndex((it) => isSameMedia(it, musicItem));
    let liked: boolean;
    if (idx >= 0) {
        likes.musicList.splice(idx, 1);
        liked = false;
    } else {
        likes.musicList.unshift(musicItem);
        liked = true;
    }
    await saveSheets(sheets);
    bumpLikesVersion();
    return liked;
}

/** 批量喜欢/取消喜欢（一次持久化，列表顺序保持传入顺序） */
export async function batchSetLike(
    musicItems: IMusic.IMusicItem[],
    like: boolean,
): Promise<void> {
    if (!musicItems.length) {
        return;
    }
    await ensureLikesSheet();
    const sheets = await getUserSheets();
    const likes = sheets.find((it) => it.id === LIKES_SHEET_ID)!;
    if (like) {
        const existing = new Set(likes.musicList.map((it) => `${it.platform}-${it.id}`));
        const toAdd = musicItems.filter((it) => !existing.has(`${it.platform}-${it.id}`));
        likes.musicList.unshift(...toAdd.reverse());
    } else {
        const removeKeys = new Set(musicItems.map((it) => `${it.platform}-${it.id}`));
        likes.musicList = likes.musicList.filter(
            (it) => !removeKeys.has(`${it.platform}-${it.id}`),
        );
    }
    await saveSheets(sheets);
    bumpLikesVersion();
}
