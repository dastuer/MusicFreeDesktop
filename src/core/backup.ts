import { getDefaultStore } from "jotai";
import { ipcInvoke, invalidatePluginCache } from "./ipc";
import { likesVersionAtom } from "./musicSheet";
import { setTheme } from "./theme";
import { TrackPlayerSingleton } from "./trackPlayer";

/**
 * 备份与恢复（渲染进程侧）
 *
 * 分工：
 * - 歌单 / 本地音乐索引 / 插件元信息 都在主进程的 store.json 与 plugins 目录里，
 *   由主进程组装与写回（见 `electron/services/backupService.ts`）。
 * - 播放列表、音量、主题、默认音源这类会话偏好存在 localStorage，只有渲染进程能看到，
 *   所以录备份时由渲染进程补上、恢复时由渲染进程写回。
 * - WebDAV 与 URL 拉取也走主进程：渲染进程是 `file://` 源，直连会被 CORS 拦掉。
 *
 * 安全约定：WebDAV 密码只存在主进程配置里，**不写进备份文件**。
 * 范围约定：最近播放（musicHistory）不参与备份与恢复，备份文件里不再有 musicHistory 字段，
 * 恢复时也不会碰本机历史（老备份里的该字段会被忽略）。
 */

/** 恢复模式，语义与 MusicFree 移动端一致 */
export type ResumeMode = "append" | "overwrite-default" | "overwrite";

export const RESUME_MODE_OPTIONS: { value: ResumeMode; label: string; desc: string }[] = [
    {
        value: "append",
        label: "追加",
        desc: "同 id 歌单把备份里的歌曲补进来，本机已有的歌曲不动",
    },
    {
        value: "overwrite-default",
        label: "覆盖默认歌单",
        desc: "只有「我喜欢的音乐」被整体替换，其余歌单按追加处理",
    },
    {
        value: "overwrite",
        label: "完整覆盖",
        desc: "丢弃本机全部歌单，完全使用备份内容（不可撤销，最近播放不受影响）",
    },
];

const RESUME_MODE_KEY = "backup.resumeMode";

export function getResumeMode(): ResumeMode {
    const saved = localStorage.getItem(RESUME_MODE_KEY);
    if (saved === "append" || saved === "overwrite-default" || saved === "overwrite") {
        return saved;
    }
    return "append";
}

export function setResumeMode(mode: ResumeMode) {
    localStorage.setItem(RESUME_MODE_KEY, mode);
}

export function resumeModeLabel(mode: ResumeMode): string {
    return RESUME_MODE_OPTIONS.find((it) => it.value === mode)?.label ?? "追加";
}

/** ---------- 类型 ---------- */

export interface IBackupPayload {
    format?: string;
    version?: number;
    appVersion?: string;
    createdAt?: number;
    musicSheets?: any[];
    plugins?: any[];
    /** 老备份文件里的历史字段，只读兼容用，主进程不会恢复它 */
    musicHistory?: any[];
    localMusic?: any[];
    appConfig?: Record<string, any>;
    preferences?: Record<string, string>;
}

export interface ISheetResumeStats {
    created: number;
    merged: number;
    replaced: number;
    songsAdded: number;
    nameOnly: number;
}

export interface IPluginResumeResult {
    installed: number;
    updated: number;
    skipped: number;
    failed: { platform: string; reason: string }[];
}

export interface IResumeSummary {
    sheets: ISheetResumeStats;
    plugins: IPluginResumeResult;
    localMusic: number;
    appConfig: number;
    preferences: Record<string, string> | null;
    warnings: string[];
}

export interface IWebdavConfig {
    url: string;
    username: string;
    password: string;
    filePath: string;
}

export interface IBackupCounts {
    sheets: number;
    songs: number;
    plugins: number;
    localMusic: number;
}

export interface IBackupStatus {
    lastAt: number | null;
    lastTarget: "local" | "webdav" | null;
    webdav: IWebdavConfig;
    /** WebDAV 上的备份文件路径（按配置回退到默认值） */
    webdavFile: string;
    counts: IBackupCounts;
}

export interface IBackupResult {
    success: boolean;
    canceled?: boolean;
    message?: string;
    filePath?: string;
    remotePath?: string;
    sizeText?: string;
}

export interface ICollectOptions {
    includeLocalMusic: boolean;
}

/** ---------- localStorage 偏好白名单 ---------- */

/**
 * 只备份这些键。刻意不备份 `backup.*`：
 * 恢复模式是本机选项，而 WebDAV 密码属于凭据，绝不能落到备份文件里。
 */
const PREF_KEYS = [
    "theme",
    "defaultQuality",
    "volume",
    "repeatMode",
    "playList",
    "currentMusic",
    "defaultPluginHash",
];

const PREF_PREFIXES = ["pageSource."];

function collectPreferences(): Record<string, string> {
    const prefs: Record<string, string> = {};
    try {
        for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (!key) {
                continue;
            }
            if (!PREF_KEYS.includes(key) && !PREF_PREFIXES.some((p) => key.startsWith(p))) {
                continue;
            }
            const value = localStorage.getItem(key);
            if (value !== null) {
                prefs[key] = value;
            }
        }
    } catch {
        // localStorage 不可用时跳过偏好，不影响主体数据备份
    }
    return prefs;
}

/** 写回偏好。原样字符串进出，避免 JSON 二次编码（theme/volume 存的不是 JSON） */
function applyPreferences(prefs: Record<string, string> | null | undefined): string[] {
    if (!prefs || typeof prefs !== "object") {
        return [];
    }
    const written: string[] = [];
    for (const [key, value] of Object.entries(prefs)) {
        if (typeof value !== "string") {
            continue;
        }
        if (!PREF_KEYS.includes(key) && !PREF_PREFIXES.some((p) => key.startsWith(p))) {
            continue;
        }
        try {
            localStorage.setItem(key, value);
            written.push(key);
        } catch {
            // 单个键写失败不影响其他
        }
    }
    return written;
}

/** 恢复后让界面反映新数据：插件列表缓存作废、红心版本自增触发列表刷新 */
function refreshAfterRestore(prefs: Record<string, string> | null) {
    invalidatePluginCache();
    const store = getDefaultStore();
    store.set(likesVersionAtom, store.get(likesVersionAtom) + 1);

    // 主题与音量可以直接生效，其余偏好（播放列表等）需要重启
    try {
        if (prefs?.theme) {
            setTheme(prefs.theme as any);
        }
        if (prefs?.volume !== undefined) {
            const volume = Number(prefs.volume);
            if (Number.isFinite(volume)) {
                TrackPlayerSingleton.setVolume(volume);
            }
        }
    } catch {
        // 立即生效失败不影响已写入的偏好
    }
}

/** ---------- 对外 API ---------- */

export function getBackupStatus(): Promise<IBackupStatus> {
    return ipcInvoke<IBackupStatus>("backup:status");
}

/** 组装备份数据：主进程主体 + 渲染进程偏好 */
export async function collectBackup(
    options: ICollectOptions = { includeLocalMusic: true },
): Promise<IBackupPayload> {
    const payload = await ipcInvoke<IBackupPayload>("backup:collect", options);
    return { ...payload, preferences: collectPreferences() };
}

/** 备份到本地文件（弹出系统保存对话框） */
export async function exportBackupToLocal(options?: ICollectOptions): Promise<IBackupResult> {
    const payload = await collectBackup(options);
    const content = JSON.stringify(payload);
    const res = await ipcInvoke<IBackupResult>("backup:saveFile", content);
    return res?.success ? res : { success: false, canceled: res?.canceled, message: res?.message };
}

/**
 * 应用一份备份内容。用户在主进程的原生确认框里点了取消时返回 canceled。
 */
export async function restoreBackup(
    payload: IBackupPayload | string,
    mode: ResumeMode = getResumeMode(),
): Promise<{ canceled: boolean; summary: IResumeSummary | null }> {
    const res = await ipcInvoke<{
        success: boolean;
        canceled?: boolean;
        message?: string;
        data?: IResumeSummary;
    }>("backup:apply", payload, mode);
    if (!res?.success) {
        if (res?.canceled) {
            return { canceled: true, summary: null };
        }
        throw new Error(res?.message ?? "恢复失败");
    }
    const summary = res.data!;
    applyPreferences(summary.preferences);
    refreshAfterRestore(summary.preferences);
    return { canceled: false, summary };
}

/** 从本地文件恢复：系统文件选择框 -> 应用 */
export async function importBackupFromLocal(mode: ResumeMode = getResumeMode()) {
    const file = await ipcInvoke<{
        success: boolean;
        canceled?: boolean;
        content?: string;
        filePath?: string;
        message?: string;
    }>("backup:openFile");
    if (!file?.success) {
        if (file?.canceled) {
            return { canceled: true, summary: null } as const;
        }
        throw new Error(file?.message ?? "读取备份文件失败");
    }
    const { canceled, summary } = await restoreBackup(file.content ?? "", mode);
    return { canceled, summary, filePath: file.filePath } as const;
}

/** 从 URL 恢复 */
export async function importBackupFromUrl(url: string, mode: ResumeMode = getResumeMode()) {
    const remote = await ipcInvoke<{ success: boolean; content?: string; message?: string }>(
        "backup:fetchUrl",
        url,
    );
    if (!remote?.success) {
        throw new Error(remote?.message ?? "下载备份失败");
    }
    return restoreBackup(remote.content ?? "", mode);
}

/** 备份到 WebDAV */
export async function exportBackupToWebdav(options?: ICollectOptions): Promise<IBackupResult> {
    const payload = await collectBackup(options);
    return ipcInvoke<IBackupResult>("backup:webdav:upload", JSON.stringify(payload));
}

/** 从 WebDAV 恢复 */
export async function importBackupFromWebdav(mode: ResumeMode = getResumeMode()) {
    const remote = await ipcInvoke<{
        success: boolean;
        content?: string;
        message?: string;
        remotePath?: string;
    }>("backup:webdav:download");
    if (!remote?.success) {
        throw new Error(remote?.message ?? "下载备份失败");
    }
    const { canceled, summary } = await restoreBackup(remote.content ?? "", mode);
    return { canceled, summary, remotePath: remote.remotePath };
}

export function getWebdavConfig(): Promise<IWebdavConfig> {
    return ipcInvoke<IWebdavConfig>("backup:webdav:get");
}

export function setWebdavConfig(config: Partial<IWebdavConfig>): Promise<IWebdavConfig> {
    return ipcInvoke<IWebdavConfig>("backup:webdav:set", config);
}

export function testWebdav(): Promise<{ success: boolean; message?: string }> {
    return ipcInvoke("backup:webdav:test");
}

/** ---------- 展示辅助 ---------- */

/** 把恢复摘要压成一行提示，供 toast 使用 */
export function describeResumeSummary(summary: IResumeSummary): string {
    const parts: string[] = [];
    const { sheets, plugins, localMusic } = summary;

    if (sheets.created || sheets.merged || sheets.replaced) {
        const bits: string[] = [];
        if (sheets.created) {
            bits.push(`新增 ${sheets.created}`);
        }
        if (sheets.merged) {
            bits.push(`合并 ${sheets.merged}`);
        }
        if (sheets.replaced) {
            bits.push(`覆盖 ${sheets.replaced}`);
        }
        parts.push(`歌单 ${bits.join(" / ")}，补入 ${sheets.songsAdded} 首`);
    }

    if (plugins.installed || plugins.updated || plugins.skipped) {
        const bits: string[] = [];
        if (plugins.installed) {
            bits.push(`新增 ${plugins.installed}`);
        }
        if (plugins.updated) {
            bits.push(`更新 ${plugins.updated}`);
        }
        if (plugins.skipped) {
            bits.push(`已是最新 ${plugins.skipped}`);
        }
        parts.push(`音源 ${bits.join(" / ")}`);
    }

    if (localMusic) {
        parts.push(`本地音乐 +${localMusic}`);
    }

    // 主进程侧的提示（如「已忽略 N 首本机不存在音乐文件的本地音乐」）一并列出
    const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
    if (warnings.length) {
        return `恢复完成：${parts.join("；")}。${warnings.join("；")}`;
    }

    if (!parts.length) {
        return "备份中没有可恢复的内容";
    }
    return `恢复完成：${parts.join("；")}`;
}
