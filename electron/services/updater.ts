import axios from "axios";
import { app, shell } from "electron";
import { compare } from "compare-versions";
import configStoreType from "./configStore";

/** configStore 默认导出的是实例，这里借实例拿类型 */
type ConfigStore = typeof configStoreType;

/**
 * 检查更新（渠道：GitHub Releases）
 *
 *  - 只查不装：拉 latest release 与当前版本比一比，有新版就把「去哪下、更新了什么」
 *    告诉用户。应用以免签 dmg / 便携包分发，没有统一的静默升级通道，
 *    自动下载装一半还得用户手动确认，不如只提醒。
 *  - 自动检查由渲染进程挂载时触发一次（app:updates:startupCheck），
 *    仅当「已打包 + 用户开启 + 本会话没查过」才真正联网；失败静默，不打扰启动。
 *    开发模式不自动查（天天启动都查一次没有意义），手动检查不受限制，便于联调。
 *  - 手动检查（设置页 → 关于）不做上述限制，结果原样返回（含失败原因）。
 *  - 配置只有一项：app.updates.autoCheck（默认开）。
 *  - 最近一次结果缓存在内存（lastResult）：设置页打开时直接展示，不用为了显示再查一遍。
 */

const RELEASES_API_URL =
    "https://api.github.com/repos/dastuer/MusicFreeDesktop/releases/latest";
const RELEASES_PAGE_URL =
    "https://github.com/dastuer/MusicFreeDesktop/releases/latest";

const CHECK_TIMEOUT = 10_000;
/** release 说明截断：够设置页展示更新内容，又不至于把 IPC 负载撑大 */
const NOTES_MAX_LENGTH = 4000;

export interface IUpdateCheckResult {
    updateAvailable: boolean;
    currentVersion: string;
    latestVersion: string | null;
    /** release 标题（name），一般形如 v1.0.4 */
    name: string | null;
    /** release 说明（Markdown 原文，截断） */
    notes: string | null;
    /** release 页面链接 */
    url: string | null;
    publishedAt: string | null;
    checkedAt: number;
    /** 检查失败的原因；有值时除版本号外其余字段不可信 */
    error?: string;
}

export interface IUpdateStatus {
    currentVersion: string;
    autoCheck: boolean;
    lastResult: IUpdateCheckResult | null;
}

let configStoreRef: ConfigStore | null = null;
let lastResult: IUpdateCheckResult | null = null;
let startupChecked = false;

export function setup(configStore: ConfigStore) {
    configStoreRef = configStore;
}

export function getAutoCheck(): boolean {
    return configStoreRef?.get("app.updates.autoCheck", true) !== false;
}

export function setAutoCheck(enabled: boolean): boolean {
    configStoreRef?.set("app.updates.autoCheck", !!enabled);
    return !!enabled;
}

export function getStatus(): IUpdateStatus {
    return {
        currentVersion: app.getVersion(),
        autoCheck: getAutoCheck(),
        lastResult,
    };
}

/** 拉一次 latest release 并比对版本。网络错误转成 error 字段，不让调用方挂掉 */
async function fetchAndCompare(): Promise<IUpdateCheckResult> {
    const currentVersion = app.getVersion();
    try {
        const resp = await axios.get(RELEASES_API_URL, {
            timeout: CHECK_TIMEOUT,
            headers: {
                Accept: "application/vnd.github+json",
                // GitHub API 不带 UA 直接 403
                "User-Agent": "MusicFreeDesktop",
            },
        });
        const data = resp.data ?? {};
        const tag: string = typeof data.tag_name === "string" ? data.tag_name : "";
        const latestVersion = tag.replace(/^v/i, "").trim();
        let updateAvailable = false;
        if (latestVersion) {
            try {
                // tag 可能不是语义版本（如 "beta"），比不动就当没有更新
                updateAvailable = compare(latestVersion, currentVersion, ">");
            } catch {
                updateAvailable = false;
            }
        }
        return {
            updateAvailable,
            currentVersion,
            latestVersion: latestVersion || null,
            name: typeof data.name === "string" && data.name ? data.name : tag || null,
            notes:
                typeof data.body === "string"
                    ? data.body.slice(0, NOTES_MAX_LENGTH)
                    : null,
            url:
                typeof data.html_url === "string" && data.html_url
                    ? data.html_url
                    : RELEASES_PAGE_URL,
            publishedAt:
                typeof data.published_at === "string" ? data.published_at : null,
            checkedAt: Date.now(),
        };
    } catch (e: any) {
        return {
            updateAvailable: false,
            currentVersion,
            latestVersion: null,
            name: null,
            notes: null,
            url: null,
            publishedAt: null,
            checkedAt: Date.now(),
            error: e?.message ?? String(e),
        };
    }
}

/** 手动检查：任何环境都执行，并作为最新结果缓存 */
export async function checkNow(): Promise<IUpdateCheckResult> {
    lastResult = await fetchAndCompare();
    return lastResult;
}

/**
 * 启动自动检查：已打包 + 用户开启 + 本会话没查过才真正联网。
 * 返回 null 表示本次没查（调用方不更新任何状态）；网络失败也静默成 null。
 */
export async function startupCheck(): Promise<IUpdateCheckResult | null> {
    if (!app.isPackaged || !getAutoCheck() || startupChecked) {
        return null;
    }
    startupChecked = true;
    try {
        const result = await fetchAndCompare();
        if (result.error) {
            return null;
        }
        lastResult = result;
        return result;
    } catch {
        return null;
    }
}

/** 打开 release 页面（默认跳最新 release）。url 来自渲染进程，只放行 GitHub 链接 */
export function openReleasePage(url?: string): string {
    const target = url || lastResult?.url || RELEASES_PAGE_URL;
    if (/^https:\/\/(github\.com|api\.github\.com)\//.test(target)) {
        void shell.openExternal(target);
    } else {
        void shell.openExternal(RELEASES_PAGE_URL);
    }
    return target;
}
