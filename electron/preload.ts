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
});
