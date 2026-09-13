import fs from "fs";
import path from "path";
import axios from "axios";
import { app, dialog } from "electron";
import { AuthType, createClient } from "webdav";
import configStore from "./configStore";
import pluginHost, { IBackupPlugin, IPluginResumeResult } from "./pluginHost";

/**
 * 备份与恢复（主进程侧）
 *
 * 设计要点：
 * - **数据只由主进程组装**：歌单、播放历史、本地音乐索引、插件元信息都在 store.json /
 *   plugins 目录里，渲染进程看不到。渲染进程只补上自己的 localStorage 偏好。
 * - **WebDAV 与 URL 都在主进程发起**：渲染进程处于 `file://` 源下，跨域请求会被 CORS 拦掉；
 *   主进程的 axios 没有这个限制，也让密码不必经过 IPC 之外的地方。
 * - **备份文件是可读 JSON**，恢复时逐字段校验，不信任文件内容：
 *   备份文件常常是从别处拷来的，拿坏数据直接覆盖 store.json 会让人丢光数据。
 */

/** 恢复模式，语义与 MusicFree 移动端一致 */
export type ResumeMode = "append" | "overwrite-default" | "overwrite";

export const BACKUP_FORMAT = "musicfree-desktop";
export const BACKUP_VERSION = 1;

/**
 * 「我喜欢的音乐」的固定 id。
 * 与 `src/core/musicSheet.ts` 的 LIKES_SHEET_ID 是同一份存储契约——
 * 主进程不能 import 渲染进程模块（缺 `@/` 别名、且会拖进 React 依赖），只能重复声明。
 * 改一处必须同步另一处。
 */
const DEFAULT_SHEET_ID = "my-likes";

const WEBDAV_DIR = "/MusicFree";
/** 刻意与移动端备份文件区分开，避免两个端互相覆盖 */
const WEBDAV_FILE = `${WEBDAV_DIR}/MusicFreeDesktopBackup.json`;

export interface IWebdavConfig {
    url: string;
    username: string;
    password: string;
    /** 远端文件路径，留空用默认值 */
    filePath: string;
}

export interface IBackupSheet {
    id: string;
    title: string;
    createAt: number;
    musicList: any[];
}

export interface IBackupPayload {
    format?: string;
    version?: number;
    appVersion?: string;
    createdAt?: number;
    musicSheets?: any[];
    plugins?: any[];
    musicHistory?: any[];
    localMusic?: any[];
    appConfig?: Record<string, any>;
    /** 渲染进程侧 localStorage 偏好，由渲染进程读写 */
    preferences?: Record<string, any>;
}

export interface ISheetResumeStats {
    created: number;
    merged: number;
    replaced: number;
    songsAdded: number;
    /** 备份里有名字但没有歌曲内容的歌单（多为移动端备份），恢复了名字 */
    nameOnly: number;
}

export interface IResumeSummary {
    sheets: ISheetResumeStats;
    plugins: IPluginResumeResult;
    history: number;
    localMusic: number;
    appConfig: number;
    preferences: Record<string, any> | null;
    warnings: string[];
}

const EMPTY_PLUGIN_RESULT: IPluginResumeResult = {
    installed: 0,
    updated: 0,
    skipped: 0,
    failed: [],
};

const EMPTY_SHEET_STATS: ISheetResumeStats = {
    created: 0,
    merged: 0,
    replaced: 0,
    songsAdded: 0,
    nameOnly: 0,
};

/** ---------- 工具 ---------- */

function humanSize(bytes: number): string {
    if (!bytes || bytes < 0) {
        return "0 B";
    }
    if (bytes < 1024) {
        return `${Math.round(bytes)} B`;
    }
    const kb = bytes / 1024;
    if (kb < 1024) {
        return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
    }
    const mb = kb / 1024;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function fileStamp(date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
        `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `-${pad(date.getHours())}${pad(date.getMinutes())}`
    );
}

function isMediaItem(item: any): boolean {
    return !!item && typeof item === "object" && !!item.id && !!item.platform;
}

function mediaKey(item: any): string {
    return `${item.platform}-${item.id}`;
}

/** ---------- 校验 / 归一化 ---------- */

function parsePayload(raw: any): IBackupPayload {
    let obj = raw;
    if (typeof raw === "string") {
        try {
            obj = JSON.parse(raw);
        } catch {
            throw new Error("备份文件格式无效：不是合法的 JSON");
        }
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        throw new Error("备份文件格式无效");
    }
    const known = ["musicSheets", "plugins", "musicHistory", "localMusic", "preferences"];
    if (!known.some((key) => key in obj)) {
        throw new Error("备份文件内容无法识别，可能不是 MusicFree 的备份文件");
    }
    return obj as IBackupPayload;
}

/**
 * 把备份里的歌单条目规整成桌面端结构。
 * 兼容移动端 MusicFree 的备份：那边的歌单是 IMusicSheetItem，可能不带 musicList，
 * 这种情况只恢复歌单名称，并在结果里给出提示。
 */
function normalizeSheet(raw: any, index: number): IBackupSheet | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "";
    if (!title) {
        return null;
    }
    const musicList = Array.isArray(raw.musicList)
        ? raw.musicList.filter(isMediaItem)
        : [];
    const id =
        typeof raw.id === "string" && raw.id
            ? raw.id
            : `imported-${Date.now().toString(36)}-${index}`;
    return {
        id,
        title,
        createAt: typeof raw.createAt === "number" ? raw.createAt : Date.now(),
        musicList,
    };
}

function normalizeSheets(raw: any): { sheets: IBackupSheet[]; nameOnly: number } {
    if (!Array.isArray(raw)) {
        return { sheets: [], nameOnly: 0 };
    }
    const sheets: IBackupSheet[] = [];
    let nameOnly = 0;
    raw.forEach((item, index) => {
        const sheet = normalizeSheet(item, index);
        if (!sheet) {
            return;
        }
        if (!Array.isArray(item.musicList)) {
            nameOnly += 1;
        }
        sheets.push(sheet);
    });
    return { sheets, nameOnly };
}

/** ---------- 歌单合并 ---------- */

function cloneSheet(sheet: IBackupSheet): IBackupSheet {
    return {
        id: sheet.id,
        title: sheet.title,
        createAt: sheet.createAt,
        musicList: Array.isArray(sheet.musicList) ? [...sheet.musicList] : [],
    };
}

/**
 * 按恢复模式合并歌单。
 * - append：同 id 歌单把备份里的歌补进去（按 platform+id 去重），不删除本机已有的歌
 * - overwrite-default：只有「我喜欢的音乐」整体替换（避免越合越多），其余同 append
 * - overwrite：完全丢弃本机歌单，使用备份内容
 */
function mergeSheets(
    existing: IBackupSheet[],
    incoming: IBackupSheet[],
    mode: ResumeMode,
    nameOnly: number,
): { sheets: IBackupSheet[]; stats: ISheetResumeStats } {
    const stats: ISheetResumeStats = { ...EMPTY_SHEET_STATS, nameOnly };

    if (mode === "overwrite") {
        const sheets = incoming.map(cloneSheet);
        stats.replaced = sheets.length;
        stats.songsAdded = sheets.reduce((sum, s) => sum + s.musicList.length, 0);
        return { sheets, stats };
    }

    const result = existing.map((s) => cloneSheet(s));
    const byId = new Map(result.map((s) => [s.id, s]));

    for (const raw of incoming) {
        const exists = byId.get(raw.id);
        if (!exists) {
            const created = cloneSheet(raw);
            result.push(created);
            byId.set(created.id, created);
            stats.created += 1;
            stats.songsAdded += created.musicList.length;
            continue;
        }

        const withinDefault = mode === "overwrite-default" && raw.id === DEFAULT_SHEET_ID;
        if (withinDefault) {
            if (raw.musicList.length) {
                stats.songsAdded += raw.musicList.reduce(
                    (sum, item) =>
                        sum + (exists.musicList.some((it) => mediaKey(it) === mediaKey(item)) ? 0 : 1),
                    0,
                );
                exists.musicList = [...raw.musicList];
            }
            exists.title = raw.title;
            stats.replaced += 1;
            continue;
        }

        const seen = new Set(exists.musicList.map(mediaKey));
        for (const item of raw.musicList) {
            const key = mediaKey(item);
            if (!seen.has(key)) {
                exists.musicList.push(item);
                seen.add(key);
                stats.songsAdded += 1;
            }
        }
        stats.merged += 1;
    }

    return { sheets: result, stats };
}

/** 历史/本地音乐列表：按 platform+id 去重合并，按 append 语义补在已有条目之后 */
function mergeItemList(existing: any[], incoming: any[]): { list: any[]; added: number } {
    const list = existing.filter(isMediaItem).map((it) => ({ ...it }));
    const seen = new Set(list.map(mediaKey));
    let added = 0;
    for (const item of incoming) {
        if (!isMediaItem(item)) {
            continue;
        }
        const key = mediaKey(item);
        if (!seen.has(key)) {
            list.push({ ...item });
            seen.add(key);
            added += 1;
        }
    }
    return { list, added };
}

/** ---------- 服务 ---------- */

class BackupService {
    /** 组装备份数据（不含 preferences，那一部分由渲染进程补齐） */
    collect(options?: { includeHistory?: boolean; includeLocalMusic?: boolean }): IBackupPayload {
        const sheets = configStore.get("userSheets", []);
        const payload: IBackupPayload = {
            format: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            appVersion: app.getVersion(),
            createdAt: Date.now(),
            musicSheets: Array.isArray(sheets) ? sheets : [],
            plugins: pluginHost.backupPlugins(),
        };

        const appConfig: Record<string, any> = {};
        const downloadDir = configStore.get("download.dir");
        const mediaLimit = configStore.get("mediaCache.limit");
        if (typeof downloadDir === "string" && downloadDir) {
            appConfig["download.dir"] = downloadDir;
        }
        if (typeof mediaLimit === "number") {
            appConfig["mediaCache.limit"] = mediaLimit;
        }
        payload.appConfig = appConfig;

        if (options?.includeHistory !== false) {
            const history = configStore.get("musicHistory", []);
            payload.musicHistory = Array.isArray(history) ? history : [];
        }
        if (options?.includeLocalMusic !== false) {
            const localList = configStore.get("localMusic.list", []);
            payload.localMusic = Array.isArray(localList) ? localList : [];
        }
        return payload;
    }

    /** 应用备份数据；preferences 原样返回给渲染进程自行写入 localStorage */
    async apply(raw: any, mode: ResumeMode = "append"): Promise<IResumeSummary> {
        const payload = parsePayload(raw);
        const warnings: string[] = [];

        const summary: IResumeSummary = {
            sheets: { ...EMPTY_SHEET_STATS },
            plugins: { ...EMPTY_PLUGIN_RESULT, failed: [] },
            history: 0,
            localMusic: 0,
            appConfig: 0,
            preferences: null,
            warnings,
        };

        if (payload.format && payload.format !== BACKUP_FORMAT) {
            warnings.push(
                `备份来自其他端（${payload.format}），已尽力恢复可识别的部分`,
            );
        }

        /** 歌单 */
        const { sheets: incoming, nameOnly } = normalizeSheets(payload.musicSheets);
        if (incoming.length) {
            const existing = configStore.get("userSheets", []);
            const { sheets, stats } = mergeSheets(
                Array.isArray(existing) ? existing : [],
                incoming,
                mode,
                nameOnly,
            );
            configStore.set("userSheets", sheets);
            summary.sheets = stats;
            if (nameOnly) {
                warnings.push(
                    `${nameOnly} 个歌单的备份中不含歌曲（多为移动端备份），只恢复了歌单名称`,
                );
            }
        }

        /** 插件：可能要走网络，放最后失败也没关系，放到前面避免歌单白恢复 */
        if (Array.isArray(payload.plugins) && payload.plugins.length) {
            summary.plugins = await pluginHost.resumePlugins(
                payload.plugins as IBackupPlugin[],
            );
            for (const fail of summary.plugins.failed) {
                warnings.push(`音源「${fail.platform}」未恢复：${fail.reason}`);
            }
        }

        /** 播放历史 */
        if (Array.isArray(payload.musicHistory)) {
            const incomingHistory = payload.musicHistory.filter(isMediaItem);
            if (mode === "overwrite") {
                const sorted = [...incomingHistory].sort(
                    (a, b) => (b.playAt ?? 0) - (a.playAt ?? 0),
                );
                configStore.set("musicHistory", sorted.slice(0, 300));
                summary.history = sorted.length;
            } else {
                const existing = configStore.get("musicHistory", []);
                const { list, added } = mergeItemList(
                    Array.isArray(existing) ? existing : [],
                    incomingHistory,
                );
                list.sort((a, b) => (b.playAt ?? 0) - (a.playAt ?? 0));
                configStore.set("musicHistory", list.slice(0, 300));
                summary.history = added;
            }
        }

        /** 本地音乐索引：只恢复列表，文件本身得靠用户自己放回原路径 */
        if (Array.isArray(payload.localMusic)) {
            const incomingLocal = payload.localMusic.filter(isMediaItem);
            if (mode === "overwrite") {
                configStore.set("localMusic.list", incomingLocal);
                summary.localMusic = incomingLocal.length;
            } else {
                const existing = configStore.get("localMusic.list", []);
                const { list, added } = mergeItemList(
                    Array.isArray(existing) ? existing : [],
                    incomingLocal,
                );
                configStore.set("localMusic.list", list);
                summary.localMusic = added;
            }
            if (summary.localMusic) {
                warnings.push(
                    "本地音乐的音频文件不在备份内，恢复后若文件已在其他位置请重新扫描",
                );
            }
        }

        /** 应用级配置 */
        if (payload.appConfig && typeof payload.appConfig === "object") {
            const downloadDir = payload.appConfig["download.dir"];
            if (typeof downloadDir === "string" && downloadDir && fs.existsSync(downloadDir)) {
                configStore.set("download.dir", downloadDir);
                summary.appConfig += 1;
            }
            const mediaLimit = payload.appConfig["mediaCache.limit"];
            if (typeof mediaLimit === "number") {
                configStore.set("mediaCache.limit", mediaLimit);
                summary.appConfig += 1;
            }
        }

        if (payload.preferences && typeof payload.preferences === "object") {
            summary.preferences = payload.preferences;
        }

        return summary;
    }

    /** ---------- 本地文件 ---------- */

    async saveToFile(content: string) {
        const { canceled, filePath } = await dialog.showSaveDialog({
            title: "导出备份",
            defaultPath: path.join(
                app.getPath("downloads"),
                `MusicFreeDesktopBackup-${fileStamp()}.json`,
            ),
            filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (canceled || !filePath) {
            return { success: false, canceled: true } as const;
        }
        try {
            fs.writeFileSync(filePath, content, "utf-8");
            const size = fs.statSync(filePath).size;
            this.markBackedUp("local");
            return { success: true, filePath, size, sizeText: humanSize(size) } as const;
        } catch (e: any) {
            return { success: false, message: e?.message ?? String(e) } as const;
        }
    }

    async readFromFile() {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            title: "选择备份文件",
            properties: ["openFile"],
            filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (canceled || !filePaths.length) {
            return { success: false, canceled: true } as const;
        }
        try {
            const content = fs.readFileSync(filePaths[0], "utf-8");
            return { success: true, content, filePath: filePaths[0] } as const;
        } catch (e: any) {
            return { success: false, message: e?.message ?? String(e) } as const;
        }
    }

    /** 从 URL 拉取备份：渲染进程受 CORS 限制，统一走主进程 */
    async fetchFromUrl(url: string) {
        const target = (url ?? "").trim();
        if (!/^https?:\/\//i.test(target)) {
            return { success: false, message: "请输入以 http(s):// 开头的地址" } as const;
        }
        try {
            const res = await axios.get(target, { timeout: 30000 });
            const content = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
            if (!content?.trim()) {
                return { success: false, message: "远程文件内容为空" } as const;
            }
            return { success: true, content } as const;
        } catch (e: any) {
            return { success: false, message: e?.message ?? String(e) } as const;
        }
    }

    /** ---------- WebDAV ---------- */

    getWebdavConfig(): IWebdavConfig {
        const saved = configStore.get("backup.webdav", {}) ?? {};
        return {
            url: saved.url ?? "",
            username: saved.username ?? "",
            password: saved.password ?? "",
            filePath: saved.filePath ?? "",
        };
    }

    setWebdavConfig(config: Partial<IWebdavConfig>): IWebdavConfig {
        const next: IWebdavConfig = {
            url: (config?.url ?? "").trim(),
            username: config?.username ?? "",
            password: config?.password ?? "",
            filePath: (config?.filePath ?? "").trim(),
        };
        configStore.set("backup.webdav", next);
        return next;
    }

    private createWebdavClient() {
        const cfg = this.getWebdavConfig();
        if (!cfg.url || !cfg.username || !cfg.password) {
            throw new Error("请先完整填写 WebDAV 地址、用户名和密码");
        }
        return {
            client: createClient(cfg.url, {
                authType: AuthType.Password,
                username: cfg.username,
                password: cfg.password,
            }),
            remotePath: cfg.filePath || WEBDAV_FILE,
        };
    }

    private static async ensureParentDir(client: any, remotePath: string) {
        const dir = path.posix.dirname(remotePath);
        if (!dir || dir === "/" || dir === ".") {
            return;
        }
        // 逐级创建，WebDAV 不会自动补齐中间目录
        const parts = dir.split("/").filter(Boolean);
        let current = "";
        for (const part of parts) {
            current += `/${part}`;
            try {
                if (!(await client.exists(current))) {
                    await client.createDirectory(current);
                }
            } catch {
                // 目录已存在（部分服务端 exists 不可靠）直接忽略
            }
        }
    }

    async testWebdav() {
        try {
            const { client } = this.createWebdavClient();
            await client.getDirectoryContents("/", { deep: false });
            return { success: true } as const;
        } catch (e: any) {
            return { success: false, message: e?.message ?? String(e) } as const;
        }
    }

    async uploadToWebdav(content: string) {
        try {
            const { client, remotePath } = this.createWebdavClient();
            await BackupService.ensureParentDir(client, remotePath);
            await client.putFileContents(remotePath, content, { overwrite: true });
            this.markBackedUp("webdav");
            return { success: true, remotePath, size: content.length } as const;
        } catch (e: any) {
            return { success: false, message: e?.message ?? String(e) } as const;
        }
    }

    async downloadFromWebdav() {
        try {
            const { client, remotePath } = this.createWebdavClient();
            if (!(await client.exists(remotePath))) {
                return {
                    success: false,
                    message: `远端不存在备份文件：${remotePath}`,
                } as const;
            }
            const data = await client.getFileContents(remotePath, { format: "text" });
            const content = typeof data === "string" ? data : String(data ?? "");
            if (!content.trim()) {
                return { success: false, message: "远程备份文件内容为空" } as const;
            }
            return { success: true, content, remotePath } as const;
        } catch (e: any) {
            return { success: false, message: e?.message ?? String(e) } as const;
        }
    }

    /** 记录最近一次备份，设置页用来展示「上次备份」 */
    markBackedUp(target: "local" | "webdav") {
        configStore.set("backup.lastAt", Date.now());
        configStore.set("backup.lastTarget", target);
    }

    /**
     * 恢复前的原生确认弹窗。
     * 用主进程的系统弹窗而不是渲染进程的 confirm：与应用内其他破坏性操作
     * （删除本地音乐、清缓存）保持一致，且不会被页面焦点状态影响。
     */
    async confirmApply(raw: any, mode: ResumeMode): Promise<boolean> {
        // 先校验再弹窗：格式不对就直接把原因抛出去，别让用户点完「开始恢复」才报错
        const payload = parsePayload(raw);
        const sheets = Array.isArray(payload.musicSheets) ? payload.musicSheets.length : 0;
        const songs = Array.isArray(payload.musicSheets)
            ? payload.musicSheets.reduce(
                  (sum: number, sheet: any) =>
                      sum + (Array.isArray(sheet?.musicList) ? sheet.musicList.length : 0),
                  0,
              )
            : 0;
        const plugins = Array.isArray(payload.plugins) ? payload.plugins.length : 0;

        const effect =
            mode === "overwrite"
                ? "本机现有的歌单与播放历史会被清空，完全替换为备份内容。"
                : mode === "overwrite-default"
                  ? "「我喜欢的音乐」会被整体替换，其余歌单只补入备份中缺少的歌曲。"
                  : "备份中的歌曲会补进同 id 的歌单，本机已有的内容不会被删除。";

        const { response } = await dialog.showMessageBox({
            type: mode === "overwrite" ? "warning" : "info",
            title: "恢复备份",
            message: `确定按「${RESUME_MODE_TEXT[mode]}」方式恢复吗？`,
            detail:
                `备份包含 ${sheets} 个歌单 / ${songs} 首歌曲、${plugins} 个音源。\n\n` +
                `${effect}\n\n建议先做一次本机备份再恢复。`,
            buttons: ["取消", "开始恢复"],
            defaultId: 0,
            cancelId: 0,
        });
        return response === 1;
    }

    getStatus() {
        const lastAt = configStore.get("backup.lastAt");
        const sheets = configStore.get("userSheets", []);
        const history = configStore.get("musicHistory", []);
        const localList = configStore.get("localMusic.list", []);
        const sheetList = Array.isArray(sheets) ? sheets : [];

        return {
            lastAt: typeof lastAt === "number" ? lastAt : null,
            lastTarget: configStore.get("backup.lastTarget") ?? null,
            webdav: this.getWebdavConfig(),
            webdavFile: this.getWebdavConfig().filePath || WEBDAV_FILE,
            counts: {
                sheets: sheetList.length,
                songs: sheetList.reduce(
                    (sum: number, sheet: any) =>
                        sum + (Array.isArray(sheet?.musicList) ? sheet.musicList.length : 0),
                    0,
                ),
                plugins: pluginHost.getSerializedPlugins().length,
                history: Array.isArray(history) ? history.length : 0,
                localMusic: Array.isArray(localList) ? localList.length : 0,
            },
        };
    }
}

const RESUME_MODE_TEXT: Record<ResumeMode, string> = {
    append: "追加",
    "overwrite-default": "覆盖默认歌单",
    overwrite: "完整覆盖",
};

export { RESUME_MODE_TEXT };

export default new BackupService();
