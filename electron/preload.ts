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
    "window:setCaptionOverlay",
    "session:save",
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
});
