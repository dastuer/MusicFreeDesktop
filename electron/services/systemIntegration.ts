import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage } from "electron";
import type { NativeImage } from "electron";
import type configStoreType from "./configStore";

/** configStore 默认导出的是实例，这里借实例拿类型 */
type ConfigStore = typeof configStoreType;

/**
 * 系统集成（托盘 / 关闭行为 / 全局快捷键 / 任务栏缩略图按钮）：
 *
 *  - 托盘：全平台常驻（可在设置里藏起来）。菜单 = 播放控制 + 显示主窗口 + 完全退出；
 *    左键（win/linux 双击）唤回主窗口。托盘图标由渲染进程画好发来（与播放栏同源 SVG），
 *    深浅两套：mac 用模板图（黑色，系统按菜单栏深浅色自动反色），
 *    win 用白色实心图（任务栏深色底上黑色会看不见）。
 *  - 关闭行为：config `app.closeBehavior` = minimize（默认，关窗=藏进托盘）/ quit（旧行为）。
 *    「完全退出」走 app.quit()，before-quit 的会话落盘流程原样复用。
 *  - 全局快捷键：config `app.globalShortcuts.enabled` 开着才注册（默认关：
 *    媒体键被谁抢了很恼火，SMAC/MediaSession 本来就能用，这里只是兜底 + 可选增强）。
 *  - 任务栏缩略图按钮：Windows setThumbarButtons，图标同上白色套。
 *
 * 播放状态由渲染进程经 `system:state` 推来（托盘菜单文案 / 缩略图按钮图标跟着走），
 * 托盘与快捷键的命令经 `system:command` 发回渲染进程执行（与桌面歌词遥控同一套词表）。
 */

const isWin = process.platform === "win32";

interface PlayerSnapshot {
    hasMusic: boolean;
    playing: boolean;
    liked: boolean;
    title: string;
    artist: string;
}

const IDLE_SNAPSHOT: PlayerSnapshot = {
    hasMusic: false,
    playing: false,
    liked: false,
    title: "",
    artist: "",
};

/** 全局快捷键表：媒体键 + 显示/隐藏主窗口 */
const GLOBAL_SHORTCUTS: Array<{ code: string; cmd: string }> = [
    { code: "MediaPlayPause", cmd: "togglePlay" },
    { code: "MediaNextTrack", cmd: "next" },
    { code: "MediaPreviousTrack", cmd: "prev" },
    { code: "CommandOrControl+Alt+M", cmd: "toggleWindow" },
];

let getMainWindow: () => BrowserWindow | null = () => null;
let configStoreRef: ConfigStore | null = null;

let tray: Tray | null = null;
let snapshot: PlayerSnapshot = IDLE_SNAPSHOT;

/** 渲染进程发来的图标（PNG base64 → NativeImage）；没到齐前托盘/缩略图都等着 */
const images: {
    trayTemplate: NativeImage | null;
    trayWhite: NativeImage | null;
    prev: NativeImage | null;
    play: NativeImage | null;
    pause: NativeImage | null;
    next: NativeImage | null;
} = {
    trayTemplate: null,
    trayWhite: null,
    prev: null,
    play: null,
    pause: null,
    next: null,
};

let shortcutsRegistered = false;

/** ---------- 渲染进程 → 主进程的小通道 ---------- */

function sendCommand(cmd: string) {
    const wc = getMainWindow()?.webContents;
    if (wc && !wc.isDestroyed()) {
        wc.send("system:command", cmd);
    }
}

function showMainWindow() {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
        return;
    }
    if (win.isMinimized()) {
        win.restore();
    }
    win.show();
    win.focus();
}

function toggleMainWindow() {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
        return;
    }
    if (win.isVisible() && win.isFocused()) {
        win.hide();
    } else {
        showMainWindow();
    }
}

/** ---------- 托盘 ---------- */

function trayVisible(): boolean {
    return configStoreRef?.get("tray.visible", true) !== false;
}

function trayIcon(): NativeImage {
    // mac：模板图（黑）随菜单栏自动反色；win/linux：白色实心
    if (isWin || process.platform === "linux") {
        return images.trayWhite ?? nativeImage.createEmpty();
    }
    return images.trayTemplate ?? nativeImage.createEmpty();
}

function trayTitle(): string {
    if (!snapshot.hasMusic) {
        return "MusicFree Desktop";
    }
    const line = `${snapshot.title}${snapshot.artist ? ` - ${snapshot.artist}` : ""}`;
    return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

function buildTrayMenu(): Menu {
    return Menu.buildFromTemplate([
        { label: trayTitle(), enabled: false },
        { type: "separator" },
        {
            label: snapshot.playing ? "暂停" : "播放",
            enabled: snapshot.hasMusic,
            click: () => sendCommand("togglePlay"),
        },
        {
            label: "上一首",
            enabled: snapshot.hasMusic,
            click: () => sendCommand("prev"),
        },
        {
            label: "下一首",
            enabled: snapshot.hasMusic,
            click: () => sendCommand("next"),
        },
        {
            label: snapshot.liked ? "取消喜欢" : "喜欢",
            enabled: snapshot.hasMusic,
            click: () => sendCommand("toggleLike"),
        },
        { type: "separator" },
        { label: "显示主窗口", click: () => showMainWindow() },
        { label: "完全退出", click: () => app.quit() },
    ]);
}

function ensureTray() {
    // 图标没到（渲染进程还没发来）先不挂空托盘：那是一块看得见的空白
    if (tray || !trayVisible() || trayIcon().isEmpty()) {
        return;
    }
    tray = new Tray(trayIcon());
    tray.setToolTip("MusicFree Desktop");
    tray.setContextMenu(buildTrayMenu());
    // mac 单击 / win 双击都唤回窗口；win 右键走 contextMenu 不受影响
    tray.on("click", () => showMainWindow());
    tray.on("double-click", () => showMainWindow());
}

function refreshTray() {
    if (!tray) {
        return;
    }
    tray.setImage(trayIcon());
    tray.setContextMenu(buildTrayMenu());
}

/** 设置页切换「显示托盘图标」：即时挂/摘 */
export function setTrayVisible(visible: boolean) {
    configStoreRef?.set("tray.visible", visible);
    if (visible) {
        ensureTray();
        refreshTray();
    } else if (tray) {
        tray.destroy();
        tray = null;
    }
}

/** ---------- 任务栏缩略图按钮（Windows） ---------- */

function refreshThumbar() {
    const win = getMainWindow();
    if (!isWin || !win || win.isDestroyed()) {
        return;
    }
    if (!images.prev || !images.play || !images.pause || !images.next) {
        return;
    }
    win.setThumbarButtons([
        {
            tooltip: "上一首",
            icon: images.prev,
            click: () => sendCommand("prev"),
        },
        {
            tooltip: snapshot.playing ? "暂停" : "播放",
            icon: snapshot.playing ? images.pause : images.play,
            click: () => sendCommand("togglePlay"),
        },
        {
            tooltip: "下一首",
            icon: images.next,
            click: () => sendCommand("next"),
        },
    ]);
}

/** 主窗口新建/重建后补挂缩略图按钮 */
function attachThumbar() {
    refreshThumbar();
}

/** ---------- 全局快捷键 ---------- */

function applyShortcuts(enabled: boolean) {
    if (enabled === shortcutsRegistered) {
        return;
    }
    if (shortcutsRegistered) {
        for (const { code } of GLOBAL_SHORTCUTS) {
            globalShortcut.unregister(code);
        }
        shortcutsRegistered = false;
    }
    if (!enabled) {
        return;
    }
    for (const { code, cmd } of GLOBAL_SHORTCUTS) {
        const ok = globalShortcut.register(code, () => {
            if (cmd === "toggleWindow") {
                toggleMainWindow();
            } else {
                sendCommand(cmd);
            }
        });
        if (!ok) {
            console.warn(`[systemIntegration] 全局快捷键注册失败: ${code}`);
        }
    }
    shortcutsRegistered = true;
}

/** ---------- 接线 ---------- */

export function setup(options: {
    configStore: ConfigStore;
    getMainWindow: () => BrowserWindow | null;
}) {
    configStoreRef = options.configStore;
    getMainWindow = options.getMainWindow;

    // 图标（渲染进程画好，与播放栏同源）：
    // trayTemplate 黑色模板（mac）/ trayWhite 白色实心（win 托盘与缩略图按钮）/
    // prev play pause next 白色（缩略图按钮）。
    // 全部是 @2x 位图（16pt 逻辑尺寸 → 32px），必须按 scaleFactor: 2 解析：
    // 按 1 解析会把 32px 当成 32pt，菜单栏里比旁边图标大一倍还被裁掉底部。
    ipcMain.on("system:icons", (_e, icons: Record<string, string>) => {
        const make = (base64?: string, template?: boolean) => {
            if (!base64) {
                return null;
            }
            const img = nativeImage.createFromBuffer(Buffer.from(base64, "base64"), {
                scaleFactor: 2,
            });
            if (template) {
                img.setTemplateImage(true);
            }
            return img;
        };
        images.trayTemplate = make(icons?.trayTemplate, true);
        images.trayWhite = make(icons?.trayWhite, false);
        images.prev = make(icons?.prevWhite);
        images.play = make(icons?.playWhite);
        images.pause = make(icons?.pauseWhite);
        images.next = make(icons?.nextWhite);
        ensureTray();
        refreshTray();
        refreshThumbar();
    });

    ipcMain.on("system:state", (_e, state: Partial<PlayerSnapshot>) => {
        snapshot = { ...snapshot, ...state };
        refreshTray();
        refreshThumbar();
    });

    ipcMain.handle("system:setShortcutsEnabled", (_e, enabled: boolean) => {
        applyShortcuts(!!enabled);
        configStoreRef?.set("app.globalShortcuts.enabled", !!enabled);
        return shortcutsRegistered;
    });

    ipcMain.handle("system:setTrayVisible", (_e, visible: boolean) => {
        setTrayVisible(!!visible);
        return trayVisible();
    });

    ensureTray();
    applyShortcuts(configStoreRef.get("app.globalShortcuts.enabled", false) === true);
}

/** 主窗口创建完成后调用（缩略图按钮挂在新窗口上） */
export function onMainWindowReady() {
    attachThumbar();
}

app.on("will-quit", () => {
    try {
        globalShortcut.unregisterAll();
    } catch {
        // ignore
    }
    shortcutsRegistered = false;
    if (tray) {
        tray.destroy();
        tray = null;
    }
});

export default { setup, setTrayVisible, onMainWindowReady };
