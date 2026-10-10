import { atom, getDefaultStore, useAtomValue } from "jotai";
import { useCallback } from "react";
import { ipcInvoke } from "./ipc";

/**
 * 检查更新（主进程实现在 electron/services/updater.ts）
 *
 *  - 「有没有新版本」一律走 GitHub Releases API（updateResultAtom）：
 *    mac 的 Sparkle 引擎发现更新即自动下载、拦不住，所以 Sparkle 的检查
 *    只在用户确认更新（downloadUpdate）后才发起；
 *  - 用户确认后进入下载（mac Sparkle 引擎）：进度经 updates:event 推来
 *    （sparkleAtom），进度弹窗可关，关了下载照常、下载完只浮窗提示；
 *  - 下载完成后的安装时机：「立即重启安装」或「退出时自动安装」
 *    （后者下次打开应用即新版本），设置页也常驻「重启并安装」入口；
 *  - 其他平台 / 开发模式 / 引擎不可用：提醒后跳 release 页手动下载。
 */

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

/** 与 electron/services/updater.ts 的 ISparkleState 对齐 */
export interface ISparkleState {
    engine: "none" | "sparkle";
    stage: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
    version: string | null;
    progress: number | null;
    transferred: number | null;
    total: number | null;
    error: string | null;
}

interface IUpdateStatus {
    currentVersion: string;
    autoCheck: boolean;
    lastResult: IUpdateCheckResult | null;
    sparkle: ISparkleState;
}

const store = getDefaultStore();
export const updateResultAtom = atom<IUpdateCheckResult | null>(null);
export const autoCheckAtom = atom<boolean>(true);
export const sparkleAtom = atom<ISparkleState>({
    engine: "none",
    stage: "idle",
    version: null,
    progress: null,
    transferred: null,
    total: null,
    error: null,
});

/** 手动检查进行中（按钮转圈/防连点；启动自动检查不占这个标志） */
export const checkingAtom = atom<boolean>(false);

/**
 * 更新确认弹窗（发现新版本，用户选「更新 / 取消」）的展示状态。
 * 注意 Sparkle 引擎不可用的平台弹「更新」只会退跳下载页，所以引擎不在时
 * 弹窗不提供「更新」按钮（调用方见 UpdateDialogHost）。
 */
export const updateAvailableDialogAtom = atom<boolean>(false);

/**
 * 下载进度弹窗的展示状态：仅控制弹窗显隐，关掉后下载照常
 * （downloading / downloaded 阶段都能重开，见 setDownloadDialogVisible）。
 */
export const downloadDialogAtom = atom<boolean>(false);

let eventSubscribed = false;

/** 订阅主进程 Sparkle 状态推送（幂等，App 挂载时调用一次） */
function subscribeUpdateEvents() {
    if (eventSubscribed || !window.mfp.onUpdateEvent) {
        return;
    }
    eventSubscribed = true;
    window.mfp.onUpdateEvent((state) => store.set(sparkleAtom, state));
}

/** 应用挂载时调用：读状态、订事件推送、按设置自动查一次 */
export async function initUpdater() {
    subscribeUpdateEvents();
    try {
        const status = await ipcInvoke<IUpdateStatus>("app:updates:getStatus");
        if (status) {
            store.set(autoCheckAtom, status.autoCheck !== false);
            if (status.lastResult) {
                store.set(updateResultAtom, status.lastResult);
            }
            if (status.sparkle) {
                store.set(sparkleAtom, status.sparkle);
            }
        }
    } catch {
        // 主进程没起来（极端情况）：更新功能静默不可用
        return;
    }
    // 自动检查：失败/未开启/开发模式都拿 null，静默不提示
    try {
        const result = await ipcInvoke<IUpdateCheckResult | null>(
            "app:updates:startupCheck",
        );
        if (result) {
            store.set(updateResultAtom, result);
            // 启动检查发现新版本：弹确认弹窗（更新已在路上/已就绪则不弹）
            const stage = store.get(sparkleAtom).stage;
            if (result.updateAvailable && stage !== "downloading" && stage !== "downloaded") {
                store.set(updateAvailableDialogAtom, true);
            }
        }
    } catch {
        // 网络不通就当没有更新
    }
}

/**
 * 手动检查（设置页「检查更新」/启动检查共用）：只查不下载。
 * 返回本次检查结果（失败时 error 字段有值）。
 */
export async function checkForUpdate(): Promise<IUpdateCheckResult> {
    if (store.get(checkingAtom)) {
        return store.get(updateResultAtom) ?? emptyResult("检查已在进行中");
    }
    store.set(checkingAtom, true);
    try {
        const res = await ipcInvoke<IUpdateCheckResult & { success?: boolean }>(
            "app:updates:checkNow",
        );
        const { success: _success, ...result } = res ?? ({} as IUpdateCheckResult);
        store.set(updateResultAtom, result);
        return result;
    } catch (e: any) {
        const result = emptyResult(e?.message ?? String(e));
        store.set(updateResultAtom, result);
        return result;
    } finally {
        store.set(checkingAtom, false);
    }
}

function emptyResult(error: string): IUpdateCheckResult {
    return {
        updateAvailable: false,
        currentVersion: "",
        latestVersion: null,
        name: null,
        notes: null,
        url: null,
        publishedAt: null,
        checkedAt: Date.now(),
        error,
    };
}

/**
 * 检查并弹确认弹窗（有新版本时）：手动检查的入口。
 * 启动检查的弹窗逻辑在 initUpdater 里，那条路径失败静默不弹窗。
 */
export async function checkAndAskToUpdate(): Promise<IUpdateCheckResult> {
    const result = await checkForUpdate();
    if (result.updateAvailable && !result.error) {
        const stage = store.get(sparkleAtom).stage;
        // 已在下载/已下载完成：更新流程已在路上，不用再问一遍
        if (stage !== "downloading" && stage !== "downloaded") {
            store.set(updateAvailableDialogAtom, true);
        }
    }
    return result;
}

/**
 * 弹窗里点了「更新」：mac Sparkle 就绪时开始应用内下载（返回 true），
 * 否则返回 false（调用方退跳 release 页手动下载）。
 */
export async function downloadUpdate(): Promise<boolean> {
    store.set(updateAvailableDialogAtom, false);
    const ok = await ipcInvoke<boolean>("app:updates:downloadNow");
    if (ok) {
        store.set(downloadDialogAtom, true);
    }
    return ok === true;
}

/** 弹窗里点了「取消」/关掉弹窗 */
export function declineUpdate() {
    store.set(updateAvailableDialogAtom, false);
}

/** 用户取消后改主意 / 从设置页再次发起：重开确认弹窗 */
export function reaskUpdate() {
    store.set(updateAvailableDialogAtom, true);
}

/** 打开/关闭下载进度弹窗（关闭不影响后台下载） */
export function setDownloadDialogVisible(visible: boolean) {
    store.set(downloadDialogAtom, visible);
}

/** 切换「启动时自动检查」设置 */
export async function setAutoCheck(enabled: boolean) {
    store.set(autoCheckAtom, enabled);
    await ipcInvoke("app:updates:setAutoCheck", enabled);
}

/**
 * 安装已下载的更新（mac Sparkle 专用）：应用退出并安装新版后自动重启。
 * 返回 false 表示引擎不可用，调用方退跳 release 下载页
 */
export async function installUpdateNow(): Promise<boolean> {
    return (await ipcInvoke<boolean>("app:updates:installNow")) === true;
}

/**
 * 不打断使用，应用这次退出时自动安装已下载的更新（下次打开即新版本）。
 * 返回 false 表示引擎不可用。
 */
export async function installUpdateOnQuit(): Promise<boolean> {
    return (await ipcInvoke<boolean>("app:updates:installOnQuit")) === true;
}

/** 打开 GitHub release 页面 */
export function openReleasePage(url?: string) {
    void ipcInvoke("app:updates:openPage", url);
}

/** 供组件读取共享更新状态；check() 返回本次检查结果 */
export function useUpdateStatus() {
    const result = useAtomValue(updateResultAtom);
    const autoCheck = useAtomValue(autoCheckAtom);
    const checking = useAtomValue(checkingAtom);
    const sparkle = useAtomValue(sparkleAtom);
    const check = useCallback(() => checkForUpdate(), []);
    return { result, autoCheck, checking, sparkle, check };
}
