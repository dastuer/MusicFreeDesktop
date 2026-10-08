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

// ---------- 图标：应用 logo → 单色托盘图 ----------

/**
 * 托盘/缩略图按钮用应用 logo（build/icon.png 的副本，src/assets/logo.png）：
 * 把「白色图形 / 深色圆角底」按亮度抠成单色蒙版（alpha = 亮度），丢弃圆角底，
 * 裁到图形包围盒后着色输出 —— mac 着纯黑做模板图（系统按菜单栏深浅色自动反色），
 * Windows 着白色（深色任务栏上黑色会看不见）。
 */
const ICON_PT = 16;
const ICON_SCALE = 2;

/** 加载 logo 并抽出「白色图形」的 alpha 蒙版（已裁到包围盒），失败返回 null */
async function loadLogoMask(): Promise<ImageData | null> {
    try {
        const { default: logoUrl } = await import("../assets/logo.png");
        const img = new Image();
        img.src = logoUrl;
        await img.decode();
        const size = 256;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
            return null;
        }
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size);
        const px = data.data;
        // 阈值抠图：logo 只有两种颜色——白猫图形（亮度≈1）与深色圆角底（亮度≈0.18）。
        // 直接拿亮度当 alpha 会把暗底留成 18% 的灰块（菜单栏上很难看），
        // 这里按 0.45/0.75 双阈值平滑映射：暗底彻底透明、图形完全不透明、边缘过渡自然。
        const LO = 0.45;
        const HI = 0.75;
        let minX = size, minY = size, maxX = 0, maxY = 0;
        for (let i = 0; i < px.length; i += 4) {
            const luminance = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
            const t = Math.min(Math.max((luminance - LO) / (HI - LO), 0), 1);
            const alpha = (px[i + 3] / 255) * t;
            px[i] = px[i + 1] = px[i + 2] = 255;
            px[i + 3] = Math.round(alpha * 255);
            if (alpha > 0.5) {
                const p = i / 4;
                const x = p % size;
                const y = Math.floor(p / size);
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
        if (maxX <= minX || maxY <= minY) {
            return null;
        }
        // 只留包围盒：托盘里图形尽量占满 16pt，不浪费在留白上
        const w = maxX - minX + 1;
        const h = maxY - minY + 1;
        const cropped = new ImageData(w, h);
        for (let y = 0; y < h; y++) {
            cropped.data.set(
                px.subarray(((minY + y) * size + minX) * 4, ((minY + y) * size + minX) * 4 + w * 4),
                y * w * 4,
            );
        }
        return cropped;
    } catch {
        return null;
    }
}

/** 蒙版着色成 PNG（base64）：宽高比保持，短边贴满 ICON_PT */
function renderMaskPng(mask: ImageData, color: string): string {
    // 长边贴 32px（@2x），短边按比例
    const scale = (ICON_PT * ICON_SCALE) / Math.max(mask.width, mask.height);
    const w = Math.max(1, Math.round(mask.width * scale));
    const h = Math.max(1, Math.round(mask.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return "";
    }
    // 先把蒙版画到位图，再 source-in 罩色：一次合成得到单色图形
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = mask.width;
    maskCanvas.height = mask.height;
    maskCanvas.getContext("2d")!.putImageData(mask, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(maskCanvas, 0, 0, w, h);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
    return canvas.toDataURL("image/png").replace("data:image/png;base64,", "");
}

/** 播放控制的矢量图标（缩略图按钮沿用与播放栏同源的 SVG 形状） */
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

async function sendIcons() {
    if (!window.mfp) {
        return;
    }
    const mask = await loadLogoMask();
    if (!mask) {
        return; // logo 没加载出来：保持空图，主进程不会挂空托盘
    }
    const white = "#ffffff";
    window.mfp.sendSystemIcons({
        // mac 托盘：模板图（纯黑+透明，系统按菜单栏深浅色自动反色）
        trayTemplate: renderMaskPng(mask, "#000000"),
        // win 托盘与缩略图按钮：白色实心（深色任务栏上黑色会看不见）
        trayWhite: renderMaskPng(mask, white),
        prevWhite: renderPng(playerIconData.prev, white),
        nextWhite: renderPng(playerIconData.next, white),
        playWhite: renderPng(playerIconData.play, white),
        pauseWhite: renderPng(playerIconData.pause, white),
    });
}
