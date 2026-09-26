import { atom, getDefaultStore, useAtomValue } from "jotai";
import { playerIconData } from "../components/base/Icon";
import {
    TrackPlayerSingleton,
    currentLyricAtom,
    currentMusicAtom,
    loadCurrentLyric,
    musicStateAtom,
    progressAtom,
} from "./trackPlayer";
import { isLiked, toggleLike } from "./musicSheet";

/**
 * 桌面歌词（主窗口侧）：
 *  - 播放状态全在本窗口（Audio 元素在这里），歌词窗只负责显示和遥控；
 *  - 状态推送：歌曲/播放状态/歌词变化时立刻推，进度按 timeupdate 的节奏跟着推；
 *    歌词窗不可见时全部跳过，不白白走 IPC；
 *  - 可见性以主进程回执（lyrics:visibility）为准：开关、歌词窗就绪提醒都汇到这一条上，
 *    变为可见时顺手补推一份最新状态，歌词窗不用等下一次 timeupdate。
 */

export const desktopLyricsVisibleAtom = atom(false);

const store = getDefaultStore();

/** 当前歌曲的喜欢状态：随状态包推给歌词窗，红心不用自己去查 */
let liked = false;

function buildState() {
    const music = store.get(currentMusicAtom);
    const state = store.get(musicStateAtom);
    const progress = store.get(progressAtom);
    return {
        music,
        playing: state === "playing",
        loading: state === "loading",
        liked,
        position: progress.position,
        duration: progress.duration,
        lines: store.get(currentLyricAtom),
        // 激活行在这里解析好：菜单栏（主进程直接设标题）和悬浮窗共用同一条
        activeLine: resolveActiveLine(progress.position),
    };
}

/**
 * 当前激活歌词行：与详情页同一口径（time <= position + 0.2 的最后一行）。
 * 前奏/无歌词退回歌名，菜单栏和悬浮窗都不留空位。
 */
function resolveActiveLine(position: number) {
    const music = store.get(currentMusicAtom);
    let line = "";
    for (const item of store.get(currentLyricAtom)) {
        if (item.time <= position + 0.2) {
            line = item.lrc;
        } else {
            break;
        }
    }
    return line || music?.title || "";
}

function pushState() {
    if (!store.get(desktopLyricsVisibleAtom)) {
        return;
    }
    window.mfp?.sendLyricsState(buildState());
}

async function refreshLiked() {
    const music = store.get(currentMusicAtom);
    const next = music ? await isLiked(music) : false;
    // 歌切走了/被清空的竞态：回来时对不上号就别推旧数据
    if (store.get(currentMusicAtom) === music) {
        liked = next;
        pushState();
    }
}

/** 主窗口挂载时调用一次：接好状态推送与遥控命令两条链路 */
export function setupDesktopLyrics() {
    if (!window.mfp) {
        return;
    }
    window.mfp.onLyricsVisibility((visible) => {
        store.set(desktopLyricsVisibleAtom, visible);
        if (visible) {
            // 歌词窗刚开/重开：这首的歌词还没拉过就补一份（平时换歌时已预载）
            const music = store.get(currentMusicAtom);
            if (music && !store.get(currentLyricAtom).length) {
                loadCurrentLyric(music);
            }
            pushState();
        }
    });
    // 启动时歌词窗可能已经开着（主进程hide过又show，或上次异常退出）——对一次表
    window.mfp.invoke("lyrics:getVisible").then((v) => {
        store.set(desktopLyricsVisibleAtom, !!v);
        if (v) {
            pushState();
        }
    });

    store.sub(currentMusicAtom, () => {
        const music = store.get(currentMusicAtom);
        // 歌词窗开着就随歌预载歌词：详情页平时不开，没人拉歌词桌面歌词就是空的
        //（详情页开着时它自己也会拉，重复调用无害）
        if (music && store.get(desktopLyricsVisibleAtom)) {
            loadCurrentLyric(music);
        }
        refreshLiked();
    });
    store.sub(musicStateAtom, pushState);
    store.sub(progressAtom, pushState);
    store.sub(currentLyricAtom, pushState);
    refreshLiked();
    // 菜单栏托盘图标早一步备好：用户随时可能点「词」
    sendTrayIcons();

    // 歌词窗的遥控命令 → 播放器
    window.mfp.onLyricsCommand((cmd: string) => {
        const music = store.get(currentMusicAtom);
        switch (cmd) {
            case "togglePlay":
                TrackPlayerSingleton.togglePlay();
                break;
            case "next":
                TrackPlayerSingleton.skipToNext();
                break;
            case "prev":
                TrackPlayerSingleton.skipToPrevious();
                break;
            case "toggleLike":
                if (music) {
                    toggleLike(music).then((v) => {
                        liked = v;
                        pushState();
                    });
                }
                break;
        }
    });
}

export async function toggleDesktopLyrics() {
    if (!window.mfp) {
        return;
    }
    const visible = store.get(desktopLyricsVisibleAtom);
    await window.mfp.invoke(visible ? "lyrics:hide" : "lyrics:show");
    // 可见性等主进程的 lyrics:visibility 回执，这里不 optimistic 置位
}

export function useDesktopLyricsVisible() {
    return useAtomValue(desktopLyricsVisibleAtom);
}

/** ---------- 菜单栏托盘图标 ---------- */

/** 托盘图标的逻辑尺寸（pt）：全部等大，状态切换（▶↔⏸、♡↔♥）不会让图标栏抖动 */
const TRAY_ICON_PT = 16;
/** @2x 位图保证 Retina 菜单栏清晰 */
const TRAY_ICON_SCALE = 2;
/** 描边粗细与 Icon 组件的 heart 一致 */
const TRAY_ICON_STROKE = 1.8;

/**
 * 把与播放栏同源的 SVG 路径画成 PNG（base64）。
 * 只能在这边画：主进程没有 canvas/DOM，Tray 又只认位图不认 SVG。
 */
function renderTrayIconPng(spec: { d: string; filled: boolean }, color: string): string {
    const size = TRAY_ICON_PT * TRAY_ICON_SCALE;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return "";
    }
    // viewBox 是 24，缩放到位图尺寸
    ctx.scale(size / 24, size / 24);
    const path = new Path2D(spec.d);
    if (spec.filled) {
        ctx.fillStyle = color;
        ctx.fill(path);
    } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = TRAY_ICON_STROKE;
        ctx.lineJoin = "round";
        ctx.stroke(path);
    }
    return canvas.toDataURL("image/png").replace("data:image/png;base64,", "");
}

/** 生成一整套托盘图标并交给主进程；模板图（纯黑+透明）会随菜单栏深浅色自动反色 */
function sendTrayIcons() {
    if (!window.mfp) {
        return;
    }
    const black = "#000000";
    window.mfp.sendLyricsIcons({
        prev: renderTrayIconPng(playerIconData.prev, black),
        next: renderTrayIconPng(playerIconData.next, black),
        play: renderTrayIconPng(playerIconData.play, black),
        pause: renderTrayIconPng(playerIconData.pause, black),
        heart: renderTrayIconPng(playerIconData.heart, black),
        heartFilled: renderTrayIconPng(playerIconData.heartFilled, "#ec4141"),
    });
}
