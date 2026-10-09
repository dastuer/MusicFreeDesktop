import { contextBridge, ipcRenderer } from "electron";

const allowedChannels = [
    "config:get",
    "config:set",
    "config:remove",
    "config:getAll",
    "plugin:list",
    "plugin:installFromFile",
    "plugin:installFromUrl",
    "plugin:uninstall",
    "plugin:setEnabled",
    "plugin:setOrder",
    "plugin:setUserVariables",
    "plugin:call",
    "pluginSubscription:list",
    "pluginSubscription:add",
    "pluginSubscription:update",
    "pluginSubscription:rename",
    "pluginSubscription:remove",
    "localMusic:pickFolder",
    "localMusic:scan",
    "localMusic:getSavedMusicList",
    "localMusic:readCover",
    "localMusic:rebuildCovers",
    "localMusic:openInFinder",
    "localMusic:delete",
    "builtinMusic:list",
    "download:start",
    "download:list",
    "download:retry",
    "download:remove",
    "download:clearCompleted",
    "download:openInFolder",
    "download:getDir",
    "download:pickDir",
    "app:getInfo",
    "app:getAutoLaunch",
    "app:setAutoLaunch",
    "netease:getStatus",
    "netease:getAccountInfo",
    "netease:login",
    "netease:logout",
    "netease:getDailySongs",
    "netease:getRecommendPlaylists",
    "netease:getPersonalizedPlaylists",
    "netease:getPlaylistDetail",
    "window:setCaptionOverlay",
    "session:save",
    "app:getCloseBehavior",
    "app:setCloseBehavior",
    "app:updates:getStatus",
    "app:updates:startupCheck",
    "app:updates:checkNow",
    "app:updates:setAutoCheck",
    "app:updates:openPage",
    "app:updates:getSparkleState",
    "app:updates:installNow",
    "localLyrics:read",
    "localLyrics:applyRemote",
    "system:setShortcutsEnabled",
    "system:setTrayVisible",
    "cache:info",
    "cache:clear",
    "cache:openDir",
    "mediaCache:getLimit",
    "mediaCache:setLimit",
    "backup:collect",
    "backup:apply",
    "backup:saveFile",
    "backup:openFile",
    "backup:fetchUrl",
    "backup:status",
    "backup:webdav:get",
    "backup:webdav:set",
    "backup:webdav:test",
    "backup:webdav:upload",
    "backup:webdav:download",
    "lyrics:show",
    "lyrics:hide",
    "lyrics:getVisible",
];

/**
 * 上次播放会话（当前歌曲 + 听到哪儿 + 播放队列），主进程在 createWindow 之前就读好了。
 * 这里用 sendSync 同步取：`TrackPlayer.setup()` 要能在**第一帧渲染之前**把进度条摆到
 * 记忆位置（异步取的话进度条会先闪一下 00:00 再跳回去）。数据只有几百字节，主进程随取随回。
 * 读不到（首次启动 / 文件损坏）就是 null，按没有会话处理。
 */
let initialSession: any = null;
try {
    initialSession = ipcRenderer.sendSync("session:getSync");
} catch {
    initialSession = null;
}

contextBridge.exposeInMainWorld("mfp", {
    invoke: (channel: string, ...args: any[]) => {
        if (!allowedChannels.includes(channel)) {
            return Promise.reject(new Error(`channel not allowed: ${channel}`));
        }
        return ipcRenderer.invoke(channel, ...args);
    },
    onDownloadEvent: (callback: (data: any) => void) => {
        ipcRenderer.on("download:event", (_e, data) => callback(data));
    },
    /** 主窗口：Sparkle 更新引擎状态推送（下载进度/已就绪可安装，见 services/updater.ts） */
    onUpdateEvent: (callback: (state: any) => void) => {
        ipcRenderer.on("updates:event", (_e, state) => callback(state));
    },
    /** 启动时的上次播放会话（主进程侧那份，见 services/sessionStore.ts） */
    initialSession,
    /** 主进程在退出前要一次「最新进度」（见 main.ts 的 requestSessionFlush） */
    onSessionFlush: (callback: () => void) => {
        ipcRenderer.on("session:flush", () => callback());
    },
    /** 告知主进程「这次的会话已经写完盘了」，它可以继续退出 */
    notifySessionSaved: () => {
        ipcRenderer.send("session:saved");
    },
    /** ---------- 桌面歌词（两个窗口之间都经主进程中转，见 services/lyricsWindow.ts） ---------- */
    /** 主窗口 → 歌词窗：推送播放状态（歌曲/进度/歌词行/喜欢） */
    sendLyricsState: (state: any) => {
        ipcRenderer.send("lyrics:state", state);
    },
    /** 歌词窗 → 主窗口：遥控命令（togglePlay / next / prev / toggleLike） */
    sendLyricsCommand: (cmd: string) => {
        ipcRenderer.send("lyrics:command", cmd);
    },
    /** 歌词窗挂载完成：请主进程让主窗口补推一份最新状态 */
    notifyLyricsReady: () => {
        ipcRenderer.send("lyrics:ready");
    },
    /** 主窗口：歌词窗可见性变化（开关回执，Toggle 按钮状态跟它走） */
    onLyricsVisibility: (callback: (visible: boolean) => void) => {
        ipcRenderer.on("lyrics:visibility", (_e, visible) => callback(visible));
    },
    /** 歌词窗：接收播放状态 */
    onLyricsState: (callback: (state: any) => void) => {
        ipcRenderer.on("lyrics:state", (_e, state) => callback(state));
    },
    /** 主窗口：接收歌词窗遥控命令 */
    onLyricsCommand: (callback: (cmd: string) => void) => {
        ipcRenderer.on("lyrics:command", (_e, cmd) => callback(cmd));
    },
    /**
     * 主窗口 → 主进程：菜单栏托盘图标（base64 PNG）。
     * SVG 图标只有渲染进程画得出来（canvas），主进程收图后建 Tray 用。
     */
    sendLyricsIcons: (icons: Record<string, string>) => {
        ipcRenderer.send("lyrics:setIcons", icons);
    },
    /** ---------- 桌面歌词设置（字号/双行/锁定）：主窗口 → 主进程 → 歌词窗 ---------- */
    /** 主窗口：推送歌词窗设置（字号/双行/锁定） */
    sendLyricsSettings: (settings: any) => {
        ipcRenderer.send("lyrics:setSettings", settings);
    },
    /** 歌词窗：接收设置 */
    onLyricsSettings: (callback: (settings: any) => void) => {
        ipcRenderer.on("lyrics:settings", (_e, settings) => callback(settings));
    },
    /** ---------- 系统集成（托盘 / 全局快捷键 / 任务栏按钮）---------- */
    /** 主窗口 → 主进程：播放状态快照（托盘菜单与缩略图按钮跟着走） */
    sendSystemState: (state: any) => {
        ipcRenderer.send("system:state", state);
    },
    /** 主窗口 → 主进程：托盘/缩略图按钮的图标（base64 PNG） */
    sendSystemIcons: (icons: Record<string, string>) => {
        ipcRenderer.send("system:icons", icons);
    },
    /** 主窗口：接收托盘菜单/快捷键/缩略图按钮发来的命令（与歌词遥控同一词表） */
    onSystemCommand: (callback: (cmd: string) => void) => {
        ipcRenderer.on("system:command", (_e, cmd) => callback(cmd));
    },
});
