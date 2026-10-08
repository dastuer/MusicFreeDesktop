import { getDefaultStore } from "jotai";
import { playerIconData } from "../components/base/Icon";
import {
    TrackPlayerSingleton,
    currentMusicAtom,
    musicStateAtom,
} from "./trackPlayer";
import { isLiked, likesVersionAtom, toggleLike } from "./musicSheet";

/**
 * 系统集成（主窗口侧）：托盘菜单、全局快捷键、Windows 任务栏缩略图按钮
 * 都活在主进程，但它们显示什么、按下去做什么，全在这边供数与执行：
 *  - 图标：与播放栏同源 SVG 画成 PNG（主进程没有 canvas），黑色模板套给 mac 托盘，
 *    白色实心套给 Windows 托盘与缩略图按钮（任务栏深色底上黑色会看不见）；
 *  - 状态：当前歌曲/播放中/喜欢 → `system:state`（托盘文案与按钮图标跟着走）；
 *  - 命令：`system:command`（togglePlay/next/prev/toggleLike）
 *    与桌面歌词遥控共用同一词表。
 */

const store = getDefaultStore();

export function setupSystemIntegration() {
    if (!window.mfp) {
        return;
    }
    sendIcons();
    refreshLiked();

    store.sub(currentMusicAtom, () => {
        pushState();
        refreshLiked();
    });
    store.sub(musicStateAtom, pushState);
    store.sub(likesVersionAtom, () => {
        // 列表页/播放栏任何位置切换喜欢，托盘菜单的红字/黑字跟着变
        refreshLiked();
    });

    window.mfp.onSystemCommand((cmd: string) => {
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
            case "toggleLike": {
                const music = store.get(currentMusicAtom);
                if (music) {
                    void toggleLike(music);
                }
                break;
            }
        }
    });
}

let liked = false;

async function refreshLiked() {
    const music = store.get(currentMusicAtom);
    const next = music ? await isLiked(music) : false;
    // 歌切走了的竞态：回来时对不上号就别推旧数据
    if (store.get(currentMusicAtom) === music) {
        liked = next;
        pushState();
    }
}

function pushState() {
    const music = store.get(currentMusicAtom);
    const state = store.get(musicStateAtom);
    window.mfp?.sendSystemState({
        hasMusic: !!music,
        playing: state === "playing",
        liked,
        title: music?.title ?? "",
        artist: music?.artist ?? "",
    });
}

// ---------- 图标：与播放栏同源的 SVG → PNG ----------

/** 图标逻辑尺寸（pt）：mac 菜单栏 16pt@2x；win 缩略图按钮官方推荐 16px 上下 */
const ICON_PT = 16;
const ICON_SCALE = 2;

function renderPng(spec: { d: string; filled: boolean }, color: string): string {
    const size = ICON_PT * ICON_SCALE;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return "";
    }
    ctx.scale(size / 24, size / 24);
    const path = new Path2D(spec.d);
    if (spec.filled) {
        ctx.fillStyle = color;
        ctx.fill(path);
    } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.lineJoin = "round";
        ctx.stroke(path);
    }
    return canvas.toDataURL("image/png").replace("data:image/png;base64,", "");
}

/** 音符形状：托盘本体图标（与菜单栏歌词的 ♪ 占位同源） */
const NOTE_PATH = {
    d: "M9 18.5V6l10-2v12.5M9 18.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zm10-2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
    filled: false,
};

function sendIcons() {
    if (!window.mfp) {
        return;
    }
    const white = "#ffffff";
    window.mfp.sendSystemIcons({
        // mac 托盘：模板图（纯黑+透明，系统按菜单栏深浅色自动反色）
        trayTemplate: renderPng(NOTE_PATH, "#000000"),
        // win 托盘与缩略图按钮：白色实心（深色任务栏上黑色会看不见）
        trayWhite: renderPng(NOTE_PATH, white),
        prevWhite: renderPng(playerIconData.prev, white),
        nextWhite: renderPng(playerIconData.next, white),
        playWhite: renderPng(playerIconData.play, white),
        pauseWhite: renderPng(playerIconData.pause, white),
    });
}
