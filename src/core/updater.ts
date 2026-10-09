import { atom, getDefaultStore, useAtomValue } from "jotai";
import { useCallback } from "react";
import { ipcInvoke } from "./ipc";

/**
 * 检查更新（GitHub Releases 渠道，主进程实现在 electron/services/updater.ts）
 *
 *  - 版本比较与 release 拉取都在主进程：渲染层只拿结果做展示；
 *  - 一次检查的结果全应用共享（updateResultAtom），App 挂载时自动查一次，
 *    设置页「关于」节直接复用这份数据，手动「检查更新」两边触发的是同一个请求；
 *  - 自动检查只在启动时查一次（main 侧有会话内去重），失败静默；手动检查展示失败原因。
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

interface IUpdateStatus {
    currentVersion: string;
    autoCheck: boolean;
    lastResult: IUpdateCheckResult | null;
}

const store = getDefaultStore();
export const updateResultAtom = atom<IUpdateCheckResult | null>(null);
export const autoCheckAtom = atom<boolean>(true);
/** 手动检查进行中（按钮转圈/防连点；启动自动检查不占这个标志） */
export const checkingAtom = atom<boolean>(false);

/** 应用挂载时调用：拿一次状态、按设置自动查一次（结果写进共享 atom） */
export async function initUpdater() {
    try {
        const status = await ipcInvoke<IUpdateStatus>("app:updates:getStatus");
        if (!status) {
            return;
        }
        store.set(autoCheckAtom, status.autoCheck !== false);
        if (status.lastResult) {
            store.set(updateResultAtom, status.lastResult);
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
 * 返回本次检查的完整结果（失败时 error 字段有值），调用方据此提示
 */
export async function checkForUpdate(): Promise<IUpdateCheckResult> {
    if (store.get(checkingAtom)) {
        return store.get(updateResultAtom) ?? emptyResult("正在检查中，请稍候");
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

/** 打开 GitHub release 页面 */
export function openReleasePage(url?: string) {
    void ipcInvoke("app:updates:openPage", url);
}

/** 供组件读取共享更新状态；check() 返回本次检查结果（含失败原因） */
export function useUpdateStatus() {
    const result = useAtomValue(updateResultAtom);
    const autoCheck = useAtomValue(autoCheckAtom);
    const checking = useAtomValue(checkingAtom);
    const check = useCallback(() => checkForUpdate(), []);
    return { result, autoCheck, checking, check };
}
