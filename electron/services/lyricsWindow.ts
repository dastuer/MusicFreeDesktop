import {
    BrowserWindow,
    Menu,
    Tray,
    ipcMain,
    nativeImage,
    screen,
} from "electron";
import type { NativeImage } from "electron";
import path from "path";
import type configStoreType from "./configStore";

/** configStore 默认导出的是实例，这里借实例拿类型 */
type ConfigStore = typeof configStoreType;

/**
 * 桌面歌词（双形态）：
 *  - macOS：菜单栏歌词 —— 一排状态项直接躺在系统菜单栏上：
 *      [完整歌词行] [上一首] [播放/暂停] [下一首] [喜欢]
 *    图标是渲染进程用与播放栏同源的 SVG 画成的等大位图（16pt@2x，模板图随深浅色
 *    自动反色），每个都是独立可单击的状态项，不用二次点菜单；
 *    点歌词条本体只弹一项「关闭」，作为退出入口。
 *  - Windows / Linux：系统栏不支持应用自绘文本，退回透明置顶悬浮窗
 *    （无边框、可拖动、位置记忆，贴在屏幕上方）。
 *
 * 两种形态共用同一条数据链（见 core/desktopLyrics.ts）：
 *      主窗口 --lyrics:state--> 这里（歌曲/进度/激活行）
 *      这里   --lyrics:command--> 主窗口（播放/切歌/喜欢遥控）
 */

const LYRICS_WIDTH = 680;
const LYRICS_HEIGHT = 72;
const BOUNDS_KEY = "lyricsWindow.bounds";
/** 菜单栏无歌时占一个音符，让「开启了」这件事看得见、也点得到 */
const MENUBAR_IDLE_TITLE = "♪";
/** 支持把歌词画进系统栏的只有 macOS 菜单栏；其余平台退回悬浮窗 */
const MENUBAR_SUPPORTED = process.platform === "darwin";

/**
 * 文本字形：位图图标没就位时的兜底（正常流程下渲染进程启动即发来图标）。
 * 每个字形后跟 U+FE0E（文本变体选择符），强制单色渲染，避免被系统画成彩色 emoji。
 */
const MENUBAR_GLYPHS = {
    prev: "\u23EE\uFE0E", // ⏮
    play: "\u25B6\uFE0E", // ▶
    pause: "\u23F8\uFE0E", // ⏸
    next: "\u23ED\uFE0E", // ⏭
    likeOff: "\u2661\uFE0E", // ♡
    likeOn: "\u2665\uFE0E", // ♥
};

/**
 * 托盘图标位图：与播放栏同源的 SVG 画成（渲染进程生成 PNG 交来），
 * 全部等大（16pt@2x）——播放/暂停、喜欢/取消喜欢切换时尺寸不变，图标栏不抖动。
 */
let trayImages: {
    prev: NativeImage;
    play: NativeImage;
    pause: NativeImage;
    next: NativeImage;
    heart: NativeImage;
    heartFilled: NativeImage;
} | null = null;

let lyricsWin: BrowserWindow | null = null;
/** 菜单栏形态的全部状态项（歌词 + 四个遥控图标） */
let menubar: {
    lyric: Tray;
    prev: Tray;
    play: Tray;
    next: Tray;
    like: Tray;
} | null = null;
/** 最近一次收到的播放状态：图标形态/提示文案跟着它走 */
let lastState: { playing?: boolean; liked?: boolean; activeLine?: string } | null = null;
let configStoreRef: ConfigStore | null = null;
let getMainWindow: () => BrowserWindow | null = () => null;

/** 主窗口可见性回执：开关按钮的状态跟这条走 */
function notifyMainWindow(visible: boolean) {
    const wc = getMainWindow()?.webContents;
    if (wc && !wc.isDestroyed()) {
        wc.send("lyrics:visibility", visible);
    }
}

function sendCommand(cmd: string) {
    const wc = getMainWindow()?.webContents;
    if (wc && !wc.isDestroyed()) {
        wc.send("lyrics:command", cmd);
    }
}

/** ---------- 形态一：macOS 菜单栏歌词 ---------- */

function createControlTray(tooltip: string, onClick: () => void) {
    const t = new Tray(nativeImage.createEmpty());
    t.setToolTip(tooltip);
    // 空图标 Tray 没挂 contextMenu 时 click 事件才会照常触发
    t.on("click", onClick);
    return t;
}

function showMenubarLyrics() {
    if (menubar) {
        return;
    }
    // 创建顺序即摆放顺序：喜欢 → 下一首 → 播放 → 上一首 → 歌词，
    // 视觉上是 [歌词] [上一首] [播放] [下一首] [喜欢]，歌词条在最左、遥控依次排右；
    // 歌词条宽度变化只向左生长，不会推动右边的图标（防抖动）
    const like = createControlTray("喜欢", () => sendCommand("toggleLike"));
    const next = createControlTray("下一首", () => sendCommand("next"));
    const play = createControlTray("继续播放", () => sendCommand("togglePlay"));
    const prev = createControlTray("上一首", () => sendCommand("prev"));
    const lyric = new Tray(nativeImage.createEmpty());
    lyric.setToolTip("MusicFree 桌面歌词");
    lyric.setTitle(lastState?.activeLine || MENUBAR_IDLE_TITLE);
    // 点歌词条只留一个「关闭」：遥控都在旁边的图标上，菜单不必再重复一遍
    lyric.setContextMenu(
        Menu.buildFromTemplate([{ label: "关闭", click: () => hide() }]),
    );

    menubar = { lyric, prev, play, next, like };
    syncMenubarState();
}

/** 状态 → 菜单栏：刷新歌词标题、播放/喜欢图标的形态与提示 */
function syncMenubarState() {
    if (!menubar) {
        return;
    }
    const playing = !!lastState?.playing;
    const liked = !!lastState?.liked;
    menubar.lyric.setTitle(String(lastState?.activeLine || MENUBAR_IDLE_TITLE));
    if (trayImages) {
        // 与播放栏同源的等大位图：▶↔⏸、♡↔♥ 切换尺寸一致，图标栏纹丝不动
        menubar.prev.setImage(trayImages.prev);
        menubar.prev.setTitle("");
        menubar.play.setImage(playing ? trayImages.pause : trayImages.play);
        menubar.play.setTitle("");
        menubar.next.setImage(trayImages.next);
        menubar.next.setTitle("");
        menubar.like.setImage(liked ? trayImages.heartFilled : trayImages.heart);
        menubar.like.setTitle("");
    } else {
        // 位图没到（极端竞态）：先用文本字形顶着
        menubar.prev.setTitle(MENUBAR_GLYPHS.prev);
        menubar.play.setTitle(playing ? MENUBAR_GLYPHS.pause : MENUBAR_GLYPHS.play);
        menubar.next.setTitle(MENUBAR_GLYPHS.next);
        menubar.like.setTitle(liked ? MENUBAR_GLYPHS.likeOn : MENUBAR_GLYPHS.likeOff);
    }
    menubar.play.setToolTip(playing ? "暂停" : "继续播放");
    menubar.like.setToolTip(liked ? "取消喜欢" : "喜欢");
}

function applyStateToMenubar(state: NonNullable<typeof lastState>) {
    lastState = state;
    syncMenubarState();
}

function hideMenubarLyrics() {
    if (!menubar) {
        return;
    }
    for (const t of Object.values(menubar)) {
        t.destroy();
    }
    menubar = null;
}

/** ---------- 形态二：透明置顶悬浮窗（回退方案） ---------- */

/** 拖动落点防抖落盘：move/moved 触发很密，没必要次次写 */
let saveBoundsTimer: NodeJS.Timeout | null = null;
function scheduleSaveBounds() {
    if (saveBoundsTimer) {
        return;
    }
    saveBoundsTimer = setTimeout(() => {
        saveBoundsTimer = null;
        const bounds = lyricsWin?.getBounds();
        if (bounds) {
            configStoreRef?.set(BOUNDS_KEY, { x: bounds.x, y: bounds.y });
        }
    }, 400);
    saveBoundsTimer.unref?.();
}

function clampToWorkArea(x: number, y: number) {
    const wa = screen.getPrimaryDisplay().workArea;
    return {
        x: Math.min(Math.max(x, wa.x), Math.max(wa.x, wa.x + wa.width - LYRICS_WIDTH)),
        y: Math.min(Math.max(y, wa.y), Math.max(wa.y, wa.y + wa.height - LYRICS_HEIGHT)),
    };
}

function createLyricsWindow() {
    const saved = configStoreRef?.get(BOUNDS_KEY) as
        | { x?: number; y?: number }
        | undefined;
    const wa = screen.getPrimaryDisplay().workArea;
    const { x, y } = clampToWorkArea(
        saved?.x ?? Math.round(wa.x + (wa.width - LYRICS_WIDTH) / 2),
        saved?.y ?? wa.y + 12,
    );

    lyricsWin = new BrowserWindow({
        width: LYRICS_WIDTH,
        height: LYRICS_HEIGHT,
        x,
        y,
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        movable: true,
        skipTaskbar: true,
        // 不抢焦点：点歌词窗上的按钮，正在打字的窗口不失焦
        focusable: false,
        alwaysOnTop: true,
        roundedCorners: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    // floating 级别盖住普通窗口即可：screen-saver 级会连全屏视频都压住，太吵
    lyricsWin.setAlwaysOnTop(true, "floating");
    // 每个桌面空间都可见（切到别的虚拟桌面歌词还在）
    lyricsWin.setVisibleOnAllWorkspaces(true);
    lyricsWin.once("ready-to-show", () => {
        // showInactive 同样是为了不抢焦点
        lyricsWin?.showInactive();
    });
    lyricsWin.on("moved", scheduleSaveBounds);
    lyricsWin.on("closed", () => {
        lyricsWin = null;
        notifyMainWindow(false);
    });

    // 与主窗口同一份前端代码：query 参数 ?window=desktopLyrics 让入口渲染歌词窗根组件
    if (process.env.ELECTRON_START_URL) {
        lyricsWin.loadURL(`${process.env.ELECTRON_START_URL}?window=desktopLyrics`);
    } else {
        lyricsWin.loadFile(path.join(__dirname, "../dist-renderer/index.html"), {
            search: "window=desktopLyrics",
        });
    }
}

/** ---------- 开关与 IPC ---------- */

function show() {
    if (MENUBAR_SUPPORTED) {
        showMenubarLyrics();
    } else if (!lyricsWin || lyricsWin.isDestroyed()) {
        createLyricsWindow();
    } else {
        lyricsWin.showInactive();
    }
    notifyMainWindow(true);
}

function hide() {
    if (MENUBAR_SUPPORTED) {
        hideMenubarLyrics();
    } else if (lyricsWin && !lyricsWin.isDestroyed()) {
        // 藏起来但保留实例：再次开启不用重载页面，状态链路也还热着
        lyricsWin.hide();
    }
    notifyMainWindow(false);
}

function close() {
    hideMenubarLyrics();
    if (lyricsWin && !lyricsWin.isDestroyed()) {
        lyricsWin.destroy();
    }
    lyricsWin = null;
}

function setup(options: {
    configStore: ConfigStore;
    getMainWindow: () => BrowserWindow | null;
}) {
    configStoreRef = options.configStore;
    getMainWindow = options.getMainWindow;

    ipcMain.handle("lyrics:show", () => {
        show();
        return true;
    });
    ipcMain.handle("lyrics:hide", () => {
        hide();
        return true;
    });
    ipcMain.handle("lyrics:getVisible", () => {
        if (MENUBAR_SUPPORTED) {
            return !!menubar;
        }
        return !!lyricsWin && !lyricsWin.isDestroyed() && lyricsWin.isVisible();
    });

    // 主窗口画好的托盘图标（与播放栏同源 SVG 位图）；模板图随菜单栏深浅色自动反色
    ipcMain.on("lyrics:setIcons", (_e, icons: Record<string, string>) => {
        const make = (base64: string, template: boolean) => {
            if (!base64) {
                return nativeImage.createEmpty();
            }
            const img = nativeImage.createFromBuffer(Buffer.from(base64, "base64"), {
                scaleFactor: 2,
            });
            if (template) {
                img.setTemplateImage(true);
            }
            return img;
        };
        trayImages = {
            prev: make(icons?.prev, true),
            play: make(icons?.play, true),
            pause: make(icons?.pause, true),
            next: make(icons?.next, true),
            heart: make(icons?.heart, true),
            heartFilled: make(icons?.heartFilled, false),
        };
        // 歌词已经开着（图标晚到）：就地换图，不重建状态项
        syncMenubarState();
    });

    // 主窗口 → 歌词形态：macOS 直接落到菜单栏标题；其余转发给悬浮窗渲染
    ipcMain.on("lyrics:state", (_e, state) => {
        if (MENUBAR_SUPPORTED) {
            applyStateToMenubar(state);
            return;
        }
        if (lyricsWin && !lyricsWin.isDestroyed()) {
            lyricsWin.webContents.send("lyrics:state", state);
        }
    });
    // 歌词形态 → 主窗口：遥控命令（播放/切歌/喜欢）
    ipcMain.on("lyrics:command", (_e, cmd) => {
        sendCommand(cmd);
    });
    // 悬浮窗挂载完成：让主窗口补推一份最新状态（窗口刚开/重开时别等下一次 timeupdate）
    ipcMain.on("lyrics:ready", () => {
        notifyMainWindow(
            MENUBAR_SUPPORTED
                ? !!menubar
                : !!lyricsWin && !lyricsWin.isDestroyed() && lyricsWin.isVisible(),
        );
    });
}

export default { setup, show, hide, close };
