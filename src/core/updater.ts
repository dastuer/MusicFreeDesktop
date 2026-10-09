import { atom, getDefaultStore, useAtomValue } from "jotai";
import { useCallback } from "react";
import { ipcInvoke } from "./ipc";

/**
 * 检查更新（主进程实现在 electron/services/updater.ts）
 *
 *  - macOS（已打包）：Sparkle 2 引擎——检查/下载/安装全在主进程完成，
 *    实时状态经 updates:event 推来（sparkleAtom），下载完点「重启并安装」即可；
 *  - 其他平台 / 开发模式：GitHub Releases API 检查（updateResultAtom），
 *    提醒后跳 release 页手动下载；
 *  - 两份数据并存：sparkleAtom 是引擎实时状态，updateResult 是
 *    fallback 检查/上次结果，设置页同时展示两边的有效信息。
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
    error: null,
});
/** 手动检查进行中（按钮转圈/防连点；启动自动检查不占这个标志） */
export const checkingAtom = atom<boolean>(false);

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
        }
    } catch {
        // 网络不通就当没有更新
    }
}

/**
 * 手动检查：设置页「检查更新」按钮。
 * mac Sparkle 就绪时结果经 sparkleAtom 事件流回来（返回 null 表示走的是引擎路径）；
 * 否则走 GitHub API，返回本次检查的完整结果（失败时 error 字段有值）
 */
export async function checkForUpdate(): Promise<IUpdateCheckResult | null> {
    if (store.get(checkingAtom)) {
        return store.get(updateResultAtom);
    }
    const sparkle = store.get(sparkleAtom);
    if (sparkle.engine === "sparkle") {
        // 引擎路径：检查结果异步经 onUpdateEvent 推来，这里不占 checking
        await ipcInvoke("app:updates:checkNow");
        return null;
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

/** 等待 Sparkle 状态离开 checking（检查完成/出错/开始下载），最长 5s 兜底 */
export async function waitForSparkleSettled(): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (store.get(sparkleAtom).stage !== "checking") {
            return;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
}

/** 取 Sparkle 当前 stage（waitForSparkleSettled 之后用） */
export function getSparkleStage(): ISparkleState["stage"] {
    return store.get(sparkleAtom).stage;
}

export function getSparkleVersion(): string | null {
    return store.get(sparkleAtom).version;
}

export function getSparkleError(): string | null {
    return store.get(sparkleAtom).error;
}

/** 打开 GitHub release 页面 */
export function openReleasePage(url?: string) {
    void ipcInvoke("app:updates:openPage", url);
}

/** 供组件读取共享更新状态；check() 返回本次检查结果（引擎路径返回 null） */
export function useUpdateStatus() {
    const result = useAtomValue(updateResultAtom);
    const autoCheck = useAtomValue(autoCheckAtom);
    const checking = useAtomValue(checkingAtom);
    const sparkle = useAtomValue(sparkleAtom);
    const check = useCallback(() => checkForUpdate(), []);
    return { result, autoCheck, checking, sparkle, check };
}
