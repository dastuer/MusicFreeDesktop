import { app, BrowserWindow, protocol, ipcMain, dialog, shell, Menu } from "electron";
import path from "path";
import fs from "fs";
import { Readable } from "stream";
import { registerMediaProtocol } from "./services/mediaProtocol";
import pluginHost from "./services/pluginHost";
import pluginSubscription from "./services/pluginSubscription";
import configStore from "./services/configStore";
import localMusic from "./services/localMusic";
import builtinMusic from "./services/builtinMusic";
import downloadService from "./services/downloadService";
import cacheManager, { CacheKey } from "./services/cacheManager";
import mediaCache, {
    DEFAULT_MEDIA_CACHE_LIMIT,
} from "./services/mediaCache";
import sessionStore from "./services/sessionStore";
import backupService, { ResumeMode } from "./services/backupService";

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
/** 与前端 --titlebar-height 对齐：Windows 的 caption 按钮要压在标题栏拖拽区上 */
const TITLEBAR_HEIGHT = 64;

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
        // 桌面端外观：隐藏标题栏，红绿灯（macOS）/ caption 按钮（Windows）由系统绘制，可拖拽区域由前端提供
        ...(isMac
            ? {
                  titleBarStyle: "hiddenInset" as const,
                  trafficLightPosition: { x: 14, y: 18 },
                  vibrancy: "sidebar" as const,
                  visualEffectState: "followWindow" as const,
                  backgroundColor: "#00000000",
              }
            : {
                  titleBarStyle: "hidden" as const,
                  titleBarOverlay: {
                      color: "#ffffff",
                      symbolColor: "#333333",
                      height: TITLEBAR_HEIGHT,
                  },
                  backgroundColor: "#ffffff",
              }),
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

    // 关窗（红点 / ⌘W）在 macOS 上等于退出应用，所以这里也要把「上次播放会话」要回来。
    // 这是**唯一**的落盘时机：播放进度只在退出前记一次（见 src/core/playProgress.ts），
    // 主进程手里没有「上一版进度」可兜底。
    mainWindow.on("close", (event) => {
        if (!needsSessionFlush()) {
            return;
        }
        event.preventDefault();
        requestSessionFlush().finally(() => mainWindow?.close());
    });

    // 调试：开发模式下自动打开 DevTools
    // 用 detach（独立窗口）而非 dock：本应用布局精确到 px，内嵌 DevTools 会挤压窗口宽度导致样式错位
    const isDev = !!process.env.ELECTRON_START_URL;
    if (isDev) {
        mainWindow.webContents.openDevTools({ mode: "detach" });
    }

    // F12 或 Cmd+Option+I 切换 DevTools（生产构建下同样可用，便于排查打包后的问题）
    // 必须 preventDefault：否则默认菜单的 Toggle Developer Tools 加速键会再触发一次，变成开了又关
    mainWindow.webContents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown") {
            return;
        }
        const isToggleDevTools =
            input.key === "F12" ||
            (input.meta && input.alt && input.key.toLowerCase() === "i");
        if (isToggleDevTools) {
            event.preventDefault();
            mainWindow?.webContents.toggleDevTools();
        }
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
    if (!isMac) {
        // 隐藏标题栏后默认菜单会以菜单栏形式挤进来；快捷键由前端自行处理
        Menu.setApplicationMenu(null);
    }
    const dataDir = path.join(app.getPath("userData"), "data");
    configStore.setup(dataDir);
    sessionStore.setup(dataDir);
    pluginHost.setup(
        path.join(app.getPath("userData"), "plugins"),
        configStore,
    );
    pluginSubscription.setup(configStore);
    localMusic.setup(configStore, dataDir);
    mediaCache.setup(dataDir);
    mediaCache.setLimit(
        configStore.get("mediaCache.limit", DEFAULT_MEDIA_CACHE_LIMIT),
    );
    builtinMusic.setup(dataDir);
    downloadService.setup(
        path.join(app.getPath("userData"), "downloads"),
        configStore,
        () => {
            mainWindow?.webContents.send("download:event", {
                tasks: downloadService.getSerializedTasks(),
            });
        },
    );
    // 封面缓存目录交给协议层读取
    registerMediaProtocol({ coverDir: localMusic.getCoverDir() });

    // 老数据瘦身：封面 base64 内联在 localMusic.list / musicHistory 里、
    // 封面原图直接落盘、老格式的裸 md5 文件名，启动时一次性处理掉。
    // 不做这一步的话，已有的巨型数据照样拖垮界面。
    // 必须串行：这几个迁移都会读-改-写 localMusic.list，并发跑会互相覆盖。
    (async () => {
        const inlineCount = await localMusic.migrateLegacyArtwork();
        const fileCount = await localMusic.migrateLegacyCoverFiles();
        const historyCount = await localMusic.migrateHistoryArtwork();
        if (inlineCount || fileCount || historyCount) {
            console.log(
                `[localMusic] 封面瘦身完成：内联转短链 ${inlineCount} 首、` +
                    `原图转缩略图 ${fileCount} 个、历史 ${historyCount} 条`,
            );
        }
    })().catch(() => {
        // 迁移失败不影响使用
    });

    createWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// 退出前把防抖中的待写数据落盘，避免丢掉最后几百毫秒内的修改
app.on("before-quit", (event) => {
    configStore.flushNow();
    // 已经要过一次就不再问了（下面 app.quit() 会再进一次这个回调）
    if (!needsSessionFlush()) {
        return;
    }
    // 挂起这次退出，先把渲染进程内存里的播放进度要回来：「退出时到底听到哪儿」
    // 只有渲染进程自己知道，而这是唯一一次落盘机会。
    event.preventDefault();
    requestSessionFlush().finally(() => app.quit());
});

app.on("window-all-closed", () => {
    app.quit();
});

/** ---------- 上次播放会话 ---------- */

/** 上次向渲染进程要会话的时间，用来避免「关窗 + 退出」两条路各问一遍 */
let lastSessionFlushAt = 0;
/** 冷却窗口要比超时长：超时兜底那一轮走的还是同一条路，别让它再问一次 */
const SESSION_FLUSH_COOLDOWN = 1000;
/** 渲染进程迟迟不回时也照常退出（它可能已经崩了 / 正在跑长任务） */
const SESSION_FLUSH_TIMEOUT = 400;

function needsSessionFlush() {
    return Date.now() - lastSessionFlushAt > SESSION_FLUSH_COOLDOWN;
}

/**
 * 向渲染进程要一次「上次播放会话」并等它写完。
 * 渲染进程收到 `session:flush` 后落盘（`session:save`，主进程同步写文件）再回 `session:saved`，
 * 所以这个 Promise resolve 时数据已经在盘上，随后的 app.quit() 不会再丢东西。
 */
function requestSessionFlush(): Promise<void> {
    const wc = mainWindow?.webContents;
    if (!wc || wc.isDestroyed()) {
        return Promise.resolve();
    }
    lastSessionFlushAt = Date.now();
    return new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            ipcMain.removeListener("session:saved", finish);
            resolve();
        };
        const timer = setTimeout(finish, SESSION_FLUSH_TIMEOUT);
        timer.unref?.();
        ipcMain.once("session:saved", finish);
        wc.send("session:flush");
    });
}

/** ---------- IPC ---------- */

// 通用配置存取
ipcMain.handle("config:get", (_e, key: string, defaultValue?: any) =>
    configStore.get(key, defaultValue));
ipcMain.handle("config:set", (_e, key: string, value: any) =>
    configStore.set(key, value));
ipcMain.handle("config:remove", (_e, key: string) =>
    configStore.remove(key));
ipcMain.handle("config:getAll", () => configStore.getAll());

/** ---------- 上次播放会话（见 services/sessionStore.ts） ---------- */

// 启动时渲染进程要**同步**拿到它才能让进度条首帧就停在正确位置（preload 里 sendSync）
ipcMain.on("session:getSync", (event) => {
    event.returnValue = sessionStore.getSnapshot();
});
ipcMain.handle("session:save", (_e, partial: any) => {
    sessionStore.save(partial ?? {});
    return true;
});

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
// 聚合音源订阅源：一条链接指向一份 index.json，里面列出整批插件
ipcMain.handle("pluginSubscription:list", () => pluginSubscription.list());
ipcMain.handle("pluginSubscription:add", (_e, url: string, name?: string) =>
    pluginSubscription.add(url, name));
ipcMain.handle("pluginSubscription:update", (_e, id: string) =>
    pluginSubscription.update(id));
ipcMain.handle("pluginSubscription:rename", (_e, id: string, name: string) =>
    pluginSubscription.rename(id, name));
ipcMain.handle("pluginSubscription:remove", (_e, id: string) =>
    pluginSubscription.remove(id));
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

// 重新生成本地音乐封面（封面缓存被清空后的修复手段，可能耗时，调用方需提示等待）
ipcMain.handle("localMusic:rebuildCovers", async (_e, onlyMissing?: boolean) => {
    try {
        return { success: true, data: await localMusic.rebuildCovers(onlyMissing !== false) };
    } catch (e: any) {
        return { success: false, message: e?.message ?? String(e) };
    }
});

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

/** ---------- 缓存 ---------- */

/** 主进程侧的体积格式化（原生确认弹窗里要显示「预计释放 XX」） */
function humanSize(bytes: number): string {
    if (!bytes || bytes < 0) {
        return "0 B";
    }
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

ipcMain.handle("cache:info", () => cacheManager.getInfo());

ipcMain.handle("cache:clear", async (_e, rawKeys: string[], extraRefs: string[] = []) => {
    // 只用已知类别，避免渲染层传来奇怪的 key
    const keys = (rawKeys ?? []).filter((k): k is CacheKey =>
        ["media", "cover", "http", "temp", "storage"].includes(k),
    );
    if (!keys.length) {
        return { success: false, canceled: true };
    }
    try {
        const info = await cacheManager.getInfo();
        const targets = info.categories.filter((c) => keys.includes(c.key));
        // 用「实际可清理」而不是总占用：封面缓存只删残留，数字对不上会让人以为没清掉
        const total = targets.reduce((sum, c) => sum + c.clearable, 0);
        if (total === 0) {
            return { success: false, canceled: true, empty: true };
        }

        const notes: string[] = [];
        if (keys.includes("media")) {
            notes.push("播放缓存清除后，下次播放这些歌曲需要重新下载。");
        }
        if (keys.includes("cover")) {
            notes.push("封面缓存只清理无人引用的残留文件，正在显示的封面会保留。");
        }
        if (keys.includes("storage")) {
            notes.push("本地存储包含当前播放列表与界面偏好，清除后需重启应用生效。");
        }

        const { response } = await dialog.showMessageBox({
            type: keys.includes("storage") ? "warning" : "info",
            title: "清除缓存",
            message: `确定清除「${targets.map((c) => c.label).join("、")}」吗？`,
            detail: `预计释放 ${humanSize(total)}。${notes.length ? `\n\n${notes.join("\n")}` : ""}`,
            buttons: ["取消", "清除"],
            defaultId: 0,
            cancelId: 0,
        });
        if (response !== 1) {
            return { success: false, canceled: true };
        }

        const freed = await cacheManager.clear(keys, extraRefs);
        const freedTotal = Object.values(freed).reduce((a, b) => a + b, 0);
        return { success: true, freed, freedTotal };
    } catch (e: any) {
        return { success: false, message: e?.message ?? String(e) };
    }
});

/** 播放缓存容量上限：字节数，0 表示关闭缓存 */
ipcMain.handle("mediaCache:getLimit", () => mediaCache.getLimit());
ipcMain.handle("mediaCache:setLimit", (_e, bytes: number) => {
    mediaCache.setLimit(Number(bytes) || 0);
    configStore.set("mediaCache.limit", mediaCache.getLimit());
    return mediaCache.getLimit();
});

ipcMain.handle("cache:openDir", () => {
    const dir = cacheManager.getCoverDir();
    if (dir) {
        shell.openPath(dir);
    }
    return dir;
});

// 应用信息
ipcMain.handle("app:getInfo", () => ({
    version: app.getVersion(),
    userDataPath: app.getPath("userData"),
    platform: process.platform,
    isMac,
}));

// Windows 的 caption 按钮直接叠在标题栏上：底色不跟主题走会在右上角留一块白
ipcMain.handle(
    "window:setCaptionOverlay",
    (_e, colors: { color?: string; symbolColor?: string }) => {
        if (!isWin || !mainWindow) {
            return false;
        }
        mainWindow.setTitleBarOverlay({ ...colors, height: TITLEBAR_HEIGHT });
        return true;
    },
);

/** ---------- 备份与恢复 ---------- */

// 组装本机备份数据（渲染进程再补上自己的 localStorage 偏好）
ipcMain.handle("backup:collect", (_e, options?: any) => backupService.collect(options));

// 应用备份数据；返回 summary.preferences 由渲染进程写入 localStorage
ipcMain.handle(
    "backup:apply",
    async (_e, payload: any, mode: ResumeMode, options?: { confirm?: boolean }) => {
        try {
            // 默认先弹原生确认框：恢复会修改用户数据，不该点一下就执行
            if (options?.confirm !== false) {
                const ok = await backupService.confirmApply(payload, mode ?? "append");
                if (!ok) {
                    return { success: false, canceled: true };
                }
            }
            return { success: true, data: await backupService.apply(payload, mode) };
        } catch (e: any) {
            return { success: false, message: e?.message ?? String(e) };
        }
    },
);

ipcMain.handle("backup:saveFile", (_e, content: string) =>
    backupService.saveToFile(content));
ipcMain.handle("backup:openFile", () => backupService.readFromFile());
ipcMain.handle("backup:fetchUrl", (_e, url: string) =>
    backupService.fetchFromUrl(url));
ipcMain.handle("backup:status", () => backupService.getStatus());

ipcMain.handle("backup:webdav:get", () => backupService.getWebdavConfig());
ipcMain.handle("backup:webdav:set", (_e, config: any) =>
    backupService.setWebdavConfig(config));
ipcMain.handle("backup:webdav:test", () => backupService.testWebdav());
ipcMain.handle("backup:webdav:upload", (_e, content: string) =>
    backupService.uploadToWebdav(content));
ipcMain.handle("backup:webdav:download", () => backupService.downloadFromWebdav());
