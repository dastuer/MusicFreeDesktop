import { app, BrowserWindow, protocol, ipcMain, dialog, shell } from "electron";
import path from "path";
import fs from "fs";
import { Readable } from "stream";
import { registerMediaProtocol } from "./services/mediaProtocol";
import pluginHost from "./services/pluginHost";
import configStore from "./services/configStore";
import localMusic from "./services/localMusic";
import builtinMusic from "./services/builtinMusic";
import downloadService from "./services/downloadService";

let mainWindow: BrowserWindow | null = null;

protocol.registerSchemesAsPrivileged([
    {
        scheme: "mfs",
        privileges: {
            standard: true,
            stream: true,
            supportFetchAPI: true,
            bypassCSP: true,
        },
    },
]);

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1180,
        height: 780,
        minWidth: 960,
        minHeight: 640,
        show: false,
        // 桌面端外观：隐藏标题栏，保留 macOS 红绿灯，可拖拽区域由前端提供
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 14, y: 18 },
        vibrancy: "sidebar",
        visualEffectState: "followWindow",
        backgroundColor: "#00000000",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: true,
        },
    });

    mainWindow.once("ready-to-show", () => {
        mainWindow?.show();
    });

    // 外部链接交给系统浏览器
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: "deny" };
    });

    // 渲染进程控制台转发到主进程日志（便于排查 CSP / 媒体错误）
    mainWindow.webContents.on("console-message", (event: any, ...rest: any[]) => {
        // Electron >= 32: 事件对象携带属性；旧版为位置参数
        const level = event?.level ?? rest[0];
        const message = event?.message ?? rest[1];
        const sourceId = event?.sourceId ?? rest[3] ?? "";
        const line = event?.lineNumber ?? event?.line ?? rest[2] ?? "";
        console.log(`[renderer][${level}] ${message} (${sourceId}:${line})`);
    });

    if (process.env.ELECTRON_START_URL) {
        mainWindow.loadURL(process.env.ELECTRON_START_URL);
    } else {
        mainWindow.loadFile(path.join(__dirname, "../dist-renderer/index.html"));
    }
}

app.whenReady().then(() => {
    configStore.setup(path.join(app.getPath("userData"), "data"));
    pluginHost.setup(
        path.join(app.getPath("userData"), "plugins"),
        configStore,
    );
    localMusic.setup(configStore);
    builtinMusic.setup(path.join(app.getPath("userData"), "data"));
    downloadService.setup(
        path.join(app.getPath("userData"), "downloads"),
        configStore,
        () => {
            mainWindow?.webContents.send("download:event", {
                tasks: downloadService.getSerializedTasks(),
            });
        },
    );
    registerMediaProtocol();

    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    app.quit();
});

/** ---------- IPC ---------- */

// 通用配置存取
ipcMain.handle("config:get", (_e, key: string, defaultValue?: any) =>
    configStore.get(key, defaultValue));
ipcMain.handle("config:set", (_e, key: string, value: any) =>
    configStore.set(key, value));
ipcMain.handle("config:remove", (_e, key: string) =>
    configStore.remove(key));
ipcMain.handle("config:getAll", () => configStore.getAll());

// 插件
ipcMain.handle("plugin:list", () => pluginHost.getSerializedPlugins());
ipcMain.handle("plugin:installFromFile", (_e, pluginPath: string, config?: any) =>
    pluginHost.installPluginFromLocalFile(pluginPath, config));
ipcMain.handle("plugin:installFromUrl", (_e, url: string, config?: any) =>
    pluginHost.installPluginFromUrl(url, config));
ipcMain.handle("plugin:uninstall", (_e, hash: string) =>
    pluginHost.uninstallPlugin(hash));
ipcMain.handle("plugin:setEnabled", (_e, hash: string, enabled: boolean) =>
    pluginHost.setPluginEnabled(hash, enabled));
ipcMain.handle("plugin:setOrder", (_e, hashes: string[]) =>
    pluginHost.setPluginOrder(hashes));
ipcMain.handle("plugin:setUserVariables", (_e, hash: string, vars: Record<string, string>) =>
    pluginHost.setUserVariables(hash, vars));
ipcMain.handle("plugin:call", async (_e, payload: { hash: string; method: string; args: any[] }) => {
    try {
        const result = await pluginHost.callMethod(payload.hash, payload.method, payload.args ?? []);
        // 插件返回值可能包含不可结构化克隆的对象（axios 响应、循环引用等），安全序列化
        let data: any;
        try {
            data = JSON.parse(
                JSON.stringify(result ?? null, (_k, v) =>
                    typeof v === "function" || typeof v === "symbol" ? undefined : v,
                ),
            );
        } catch {
            data = null;
        }
        return { success: true, data };
    } catch (e: any) {
        return { success: false, message: e?.message ?? String(e) };
    }
});

// 本地音乐
ipcMain.handle("localMusic:pickFolder", async () => {
    const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        // 默认定位到下载目录
        defaultPath: downloadService.getDownloadDir(),
    });
    if (result.canceled || !result.filePaths.length) {
        return null;
    }
    return result.filePaths[0];
});
ipcMain.handle("localMusic:scan", async (_e, folderPath: string) => {
    try {
        return { success: true, data: await localMusic.scan(folderPath) };
    } catch (e: any) {
        return { success: false, message: e?.message ?? String(e) };
    }
});
ipcMain.handle("localMusic:getSavedMusicList", () => localMusic.getSavedMusicList());
ipcMain.handle("localMusic:readCover", (_e, localPath: string) =>
    localMusic.readCover(localPath));

// 在访达中显示本地音乐文件
ipcMain.handle("localMusic:openInFinder", (_e, localPath: string) => {
    if (localPath && fs.existsSync(localPath)) {
        shell.showItemInFolder(localPath);
    }
});

// 删除本地音乐：原生弹窗二次确认后再删文件
ipcMain.handle("localMusic:delete", async (_e, localPaths: string[]) => {
    console.log("[localMusic:delete] invoked with", localPaths);
    const paths = (localPaths ?? []).filter((p) => p && fs.existsSync(p));
    console.log("[localMusic:delete] filtered paths:", paths);
    if (!paths.length) {
        return { success: false, message: "文件不存在或已被删除" };
    }
    try {
        const { response } = await dialog.showMessageBox({
            type: "warning",
            title: "删除本地音乐",
            message:
                paths.length === 1
                    ? `确定要删除「${path.basename(paths[0])}」吗？`
                    : `确定要删除这 ${paths.length} 首本地音乐吗？`,
            detail: "文件将从磁盘删除，此操作不可恢复。",
            buttons: ["取消", "删除"],
            defaultId: 0,
            cancelId: 0,
        });
        console.log("[localMusic:delete] dialog response:", response);
        if (response !== 1) {
            return { success: false, canceled: true };
        }
        const deleted = await localMusic.deleteMusic(paths);
        console.log("[localMusic:delete] deleted:", deleted);
        return { success: true, data: deleted };
    } catch (e: any) {
        console.error("[localMusic:delete] error:", e);
        return { success: false, message: e?.message ?? String(e) };
    }
});

// 下载
ipcMain.handle("download:start", (_e, items: any[], quality: string) =>
    downloadService.addTasks(items, quality));
ipcMain.handle("download:list", () => downloadService.getSerializedTasks());
ipcMain.handle("download:retry", (_e, taskId: string) => downloadService.retryTask(taskId));
ipcMain.handle("download:remove", async (_e, taskId: string, deleteFile = false) => {
    if (deleteFile) {
        const { response } = await dialog.showMessageBox({
            type: "warning",
            title: "删除下载",
            message: "确定要删除该下载记录和已下载的文件吗？",
            detail: "文件将从磁盘删除，此操作不可恢复。",
            buttons: ["取消", "删除"],
            defaultId: 0,
            cancelId: 0,
        });
        if (response !== 1) {
            return { success: false, canceled: true };
        }
    }
    downloadService.removeTask(taskId, deleteFile);
    return { success: true };
});
ipcMain.handle("download:clearCompleted", () => downloadService.clearCompleted());
ipcMain.handle("download:openInFolder", (_e, taskId: string) =>
    downloadService.openInFolder(taskId));
ipcMain.handle("download:getDir", () => downloadService.getDownloadDir());
// 选择新的下载目录（原生对话框），成功后返回新目录
ipcMain.handle("download:pickDir", async () => {
    const result = await dialog.showOpenDialog({
        title: "选择下载目录",
        properties: ["openDirectory", "createDirectory"],
        defaultPath: downloadService.getDownloadDir(),
    });
    if (result.canceled || !result.filePaths.length) {
        return null;
    }
    const dir = result.filePaths[0];
    downloadService.setDownloadDir(dir);
    return dir;
});

// 默认音乐（内置示例曲目）
ipcMain.handle("builtinMusic:list", () => builtinMusic.list());

// 应用信息
ipcMain.handle("app:getInfo", () => ({
    version: app.getVersion(),
    userDataPath: app.getPath("userData"),
    platform: process.platform,
    isMac: process.platform === "darwin",
}));
