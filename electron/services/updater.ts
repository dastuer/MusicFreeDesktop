import axios from "axios";
import { app, shell } from "electron";
import { compare } from "compare-versions";
import { createRequire } from "node:module";
import path from "node:path";
import type { SparkleBridge } from "electron-sparkle-updater";
import configStoreType from "./configStore";

/** configStore 默认导出的是实例，这里借实例拿类型 */
type ConfigStore = typeof configStoreType;

/**
 * 检查更新与macOS应用内更新
 *
 *  - macOS（已打包）：接 Sparkle 2（经 electron-sparkle-updater 的 N-API 桥）。
 *    Sparkle 接受 ad-hoc 签名，绕开 Squirrel.Mac 的 Developer ID 签名硬性要求。
 *    检查/下载/安装全走 Sparkle，应用内直接「重启并安装」，appcast 托管在
 *    GitHub Releases（latest/download/appcast.xml）。
 *  - 其他平台 / 开发模式 / 桥加载失败：退回 GitHub Releases API 检查——
 *    只查不装，提醒用户去 release 页手动下载（Windows 免签安装包与
 *    portable 也没有静默升级通道，portable 单文件无固定安装位置）。
 *  - 检查与下载解耦：桥的 SilentUserDriver「发现更新即自动下载」且 JS 侧拦不住，
 *    所以「有没有新版本」一律先用 GitHub API 探测；用户在更新确认弹窗里点了
 *    「更新」才调 Sparkle 的 checkForUpdates 让它开始下载（进度经 updates:event
 *    推送，关闭进度弹窗不影响下载，下载完成可选安装时机：立即重启或退出时自动装）。
 *    桥的定时自动检查（setAutomaticChecks）保持关闭，避免绕过弹窗直接下载。
 *  - 自动检查由渲染进程挂载时触发一次（app:updates:startupCheck），
 *    仅当「已打包 + 用户开启 + 本会话没查过」才联网；失败静默，不打扰启动。
 *  - 配置只有一项：app.updates.autoCheck（默认开）。
 */

const RELEASES_API_URL =
    "https://api.github.com/repos/dastuer/MusicFreeDesktop/releases/latest";
const RELEASES_PAGE_URL =
    "https://github.com/dastuer/MusicFreeDesktop/releases/latest";
/** Sparkle appcast：每次 release 随资产上传（generate-appcast 产物） */
const APPCAST_URL =
    "https://github.com/dastuer/MusicFreeDesktop/releases/latest/download/appcast.xml";
/** EdDSA 公钥（私钥在发布者本机钥匙串，经 sign_update 签 appcast） */
const SPARKLE_PUBLIC_ED_KEY = "38LHF3fdC4xjvz5+LhEHCgKSTvZJKShpMDKRWJkKlTk=";

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

/**
 * Sparkle 引擎的实时状态（下载进度等），经 updates:event 推给渲染层。
 * 引擎不可用时恒为 engine:"none"，渲染层只展示 fallback 检查结果。
 */
export interface ISparkleState {
    /** none = 引擎不可用（非 mac/未打包/桥加载失败） */
    engine: "none" | "sparkle";
    stage: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
    version: string | null;
    /** 下载进度 0-100（downloading 阶段） */
    progress: number | null;
    /** 已下载字节数（downloading 阶段；Sparkle 事件里 phase=apply 提取时不带） */
    transferred: number | null;
    /** 下载总字节数（服务器未回报 Content-Length 时为 null，此时只展示百分比） */
    total: number | null;
    error: string | null;
}

export interface IUpdateStatus {
    currentVersion: string;
    autoCheck: boolean;
    lastResult: IUpdateCheckResult | null;
    sparkle: ISparkleState;
}

let configStoreRef: ConfigStore | null = null;
let lastResult: IUpdateCheckResult | null = null;
let startupChecked = false;

/** ---------- Sparkle 桥（macOS 应用内更新引擎） ---------- */

/**
 * addon 加载路径。不走包自带的 loadSparkleBridgeForApp：它的 defaultPackageRoot
 * 依赖 import.meta.url，被 esbuild 的 CJS bundle 打成空对象后 fileURLToPath(undefined)
 * 直接抛错（且求值发生在 addonPath 覆盖之前）；也不能用子路径 resolve——
 * 该包 exports 只开放 "."/"builder"/"fallback"，native 子路径被封。
 * 按它的布局约定手工拼：打包后在 app.asar.unpacked（asarUnpack 产物，
 * require 时 Electron 自动重定向 asar 内同名路径，这里直接给 unpacked 真实路径）；
 * 开发模式直接在 node_modules 里找。
 */
function resolveSparkleAddonPath(): string | null {
    const relative = "native/build/Release/sparkle_bridge.node";
    if (app.isPackaged) {
        return path.join(
            process.resourcesPath,
            "app.asar.unpacked",
            "node_modules",
            "electron-sparkle-updater",
            relative,
        );
    }
    try {
        const pkgJson = createRequire(__filename).resolve(
            "electron-sparkle-updater/package.json",
        );
        return pkgJson.replace(/package\.json$/, relative);
    } catch {
        return null;
    }
}

let sparkleBridge: SparkleBridge | null = null;

const sparkleState: ISparkleState = {
    engine: "none",
    stage: "idle",
    version: null,
    progress: null,
    transferred: null,
    total: null,
    error: null,
};

/** 状态变化回调（main.ts 注入：往主窗口广播 updates:event） */
let onSparkleStateChange: ((state: ISparkleState) => void) | null = null;

function setSparkleState(patch: Partial<ISparkleState>) {
    Object.assign(sparkleState, patch);
    onSparkleStateChange?.({ ...sparkleState });
}

async function initSparkle() {
    if (process.platform !== "darwin" || !app.isPackaged) {
        return;
    }
    try {
        const addonPath = resolveSparkleAddonPath();
        if (!addonPath) {
            console.warn("[updater] Sparkle addon 未找到，退回 GitHub API 检查");
            return;
        }
        // electron-sparkle-updater 的 .node addon（N-API，包导出表与 SparkleBridge 一致）
        const bridge = createRequire(__filename)(addonPath) as SparkleBridge;
        if (
            typeof bridge.init !== "function" ||
            typeof bridge.checkForUpdates !== "function" ||
            typeof bridge.installUpdateNow !== "function" ||
            typeof bridge.setEventHandler !== "function"
        ) {
            console.warn("[updater] Sparkle addon 导出异常，退回 GitHub API 检查");
            return;
        }
        if (!bridge.init({
            appcastUrl: APPCAST_URL,
            publicEdKey: SPARKLE_PUBLIC_ED_KEY,
        })) {
            console.warn("[updater] Sparkle 初始化失败，退回 GitHub API 检查");
            return;
        }
        bridge.setEventHandler((event: any) => {
            switch (event?.type) {
                case "checking":
                    setSparkleState({ stage: "checking", error: null });
                    break;
                case "update-available":
                    setSparkleState({
                        stage: "available",
                        version: event.version ?? sparkleState.version,
                        error: null,
                    });
                    break;
                case "download-progress":
                    setSparkleState({
                        stage: "downloading",
                        progress:
                            typeof event.percent === "number" ? event.percent : null,
                        transferred:
                            typeof event.transferred === "number"
                                ? event.transferred
                                : null,
                        total:
                            typeof event.total === "number" ? event.total : null,
                    });
                    break;
                case "update-downloaded":
                    setSparkleState({
                        stage: "downloaded",
                        progress: 100,
                        version: event.version ?? sparkleState.version,
                    });
                    break;
                case "update-not-available":
                    setSparkleState({ stage: "idle", version: null, error: null });
                    break;
                case "error":
                    setSparkleState({
                        stage: "error",
                        error: event.message ?? String(event ?? "未知错误"),
                    });
                    break;
                default:
                    break;
            }
        });
        sparkleBridge = bridge;
        // 定时自动检查关掉：发现更新即下载的桥绕不过弹窗，检查时机统一由渲染层控制
        bridge.setAutomaticChecks(false);
        setSparkleState({ engine: "sparkle" });
        console.log("[updater] Sparkle 更新引擎已就绪");
    } catch (e: any) {
        console.warn("[updater] Sparkle 桥加载异常，退回 GitHub API 检查:", e?.message);
    }
}

/** 检查是否由 Sparkle 引擎执行（mac 已打包且桥就绪） */
export function isSparkleActive(): boolean {
    return sparkleBridge != null;
}

export function getSparkleState(): ISparkleState {
    return { ...sparkleState };
}

export function setup(
    configStore: ConfigStore,
    hooks?: { onSparkleStateChange?: (state: ISparkleState) => void },
) {
    configStoreRef = configStore;
    onSparkleStateChange = hooks?.onSparkleStateChange ?? null;
    void initSparkle();
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
        sparkle: { ...sparkleState },
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

/**
 * 检查（不下载）：任何环境都执行，并作为最新结果缓存。
 * mac 也走 GitHub API 探测——Sparkle 的检查会直接开始下载，必须等用户确认
 * （downloadNow）才能发起；Sparkle 侧真正的版本判断以 appcast 为准。
 */
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

/**
 * 用户在更新确认弹窗点了「更新」：让 Sparkle 开始检查并下载（mac 专用）。
 * 返回 false 表示引擎不可用（调用方退跳 release 页手动下载）。
 */
export function downloadNow(): boolean {
    if (!sparkleBridge) {
        return false;
    }
    setSparkleState({ stage: "checking", error: null });
    sparkleBridge.checkForUpdates();
    return true;
}

/**
 * 应用内安装已下载的更新（Sparkle：退出并安装新版后自动重启）。
 *
 * 桥的 installUpdateNow 消费 readyToInstallReply 或置 installWhenReady 后重查；
 * 但 readyToInstallReply 可能在之前某轮检查 abort 时已被原生侧清掉（showUpdaterError
 * 统一清标志，实测 23:14 sessionInProgress 时 abort 过一次），此时桥只会「重新检查/
 * 下载并把新包暂存好」，不会主动终止宿主——UI 上就是「点了没反应」。
 * 所以这里挂 3 秒兜底：应用还没退出就主动 quit，Sparkle 在宿主终止时接管暂存包、
 * 安装并自动重启进新版本（Sparkle 标准行为，播放进度由退出前的会话落盘保住）。
 */
export function installNow(): boolean {
    if (!sparkleBridge) {
        return false;
    }
    sparkleBridge.installUpdateNow();
    setTimeout(() => {
        if (!app.isPackaged) {
            return; // 开发模式不折腾
        }
        console.log("[updater] installNow 3s 未退出，主动退出以触发安装");
        app.quit();
    }, 3000);
    return true;
}

/**
 * 不打断使用，应用这次退出时自动装已下载的更新（下次打开即新版本）。
 * 仅 mac Sparkle 可用；返回 false 表示引擎不可用。
 */
export function installOnQuit(): boolean {
    if (!sparkleBridge) {
        return false;
    }
    sparkleBridge.installUpdateOnQuit();
    return true;
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
