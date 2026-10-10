import React, { useEffect } from "react";
import { useAtomValue } from "jotai";
import { showToast } from "@/components/base/Toast";
import {
    downloadUpdate,
    declineUpdate,
    installUpdateNow,
    installUpdateOnQuit,
    openReleasePage,
    setDownloadDialogVisible,
    downloadDialogAtom,
    sparkleAtom,
    updateAvailableDialogAtom,
    updateResultAtom,
} from "@/core/updater";

/**
 * 检查更新弹窗宿主（挂 App 常驻）：
 *  1. 确认弹窗：发现新版本时弹「更新 / 取消」；引擎不可用的平台只给「前往下载」；
 *  2. 进度弹窗：下载中展示进度条与已下载/总大小，可关闭（后台继续下载），
 *     下载完成后变成「立即重启安装 / 退出时自动安装」的收尾弹窗。
 */

/** 字节数 → 人类可读大小 */
function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n < 0) {
        return "—";
    }
    if (n < 1024) {
        return `${n} B`;
    }
    const units = ["KB", "MB", "GB"];
    let v = n;
    let i = -1;
    do {
        v /= 1024;
        i += 1;
    } while (v >= 1024 && i < units.length - 1);
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export default function UpdateDialogHost() {
    const askVisible = useAtomValue(updateAvailableDialogAtom);
    const progressVisible = useAtomValue(downloadDialogAtom);
    const result = useAtomValue(updateResultAtom);
    const sparkle = useAtomValue(sparkleAtom);

    // 确认弹窗打开期间 Esc 关闭 = 取消
    useEffect(() => {
        if (!askVisible) {
            return;
        }
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                declineUpdate();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [askVisible]);

    if (askVisible) {
        const canInAppUpdate = sparkle.engine === "sparkle";
        return (
            <div className="panel-mask" style={{ alignItems: "center" }}>
                <div
                    className="panel-body"
                    style={{ width: 360, maxHeight: "none", marginBottom: 0, borderRadius: 12 }}
                >
                    <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
                        发现新版本
                    </div>
                    <div
                        style={{
                            fontSize: 13,
                            color: "var(--text-secondary, var(--text-color))",
                            lineHeight: 1.7,
                            marginBottom: 18,
                            wordBreak: "break-all",
                        }}
                    >
                        检测到新版本 v{result?.latestVersion ?? result?.name ?? ""}
                        （当前 v{result?.currentVersion ?? "?"}）。
                        {canInAppUpdate
                            ? "现在更新吗？下载完成后可选择立即重启安装或退出时自动安装。"
                            : "请前往下载页手动获取新版本。"}
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                        <button className="btn-ghost" onClick={declineUpdate}>
                            取消
                        </button>
                        {canInAppUpdate && (
                            <button
                                className="btn-primary"
                                onClick={async () => {
                                    const ok = await downloadUpdate();
                                    if (!ok) {
                                        openReleasePage(result?.url ?? undefined);
                                    }
                                }}
                            >
                                更新
                            </button>
                        )}
                        {!canInAppUpdate && (
                            <button
                                className="btn-primary"
                                onClick={() => {
                                    declineUpdate();
                                    openReleasePage(result?.url ?? undefined);
                                }}
                            >
                                前往下载
                            </button>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    // 进度/收尾弹窗：下载中可关（后台继续），下载完成后有明确的收尾动作。
    // 没有可展示的阶段（如刚点完「更新」又立刻手动检查完返回 idle）就当用户关掉了。
    if (progressVisible) {
        const downloading = sparkle.stage === "downloading" || sparkle.stage === "checking";
        if (!downloading && sparkle.stage !== "downloaded" && sparkle.stage !== "error") {
            return null;
        }
        const pct = Math.min(100, Math.max(0, sparkle.progress ?? 0));
        return (
            <div className="panel-mask" style={{ alignItems: "center" }}>
                <div
                    className="panel-body"
                    style={{ width: 380, maxHeight: "none", marginBottom: 0, borderRadius: 12 }}
                >
                    {downloading && (
                        <>
                            <div
                                style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "baseline",
                                    marginBottom: 10,
                                }}
                            >
                                <div style={{ fontSize: 15, fontWeight: 600 }}>
                                    正在下载 v{sparkle.version ?? result?.latestVersion ?? "新版本"}
                                </div>
                                <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                                    {Math.round(pct)}%
                                </div>
                            </div>
                            <div className="update-progress-track" style={{ marginTop: 0 }}>
                                <div
                                    className="update-progress-bar"
                                    style={{ width: `${pct}%` }}
                                />
                            </div>
                            <div
                                style={{
                                    marginTop: 8,
                                    fontSize: 12,
                                    color: "var(--text-tertiary)",
                                    fontVariantNumeric: "tabular-nums",
                                }}
                            >
                                {sparkle.total
                                    ? `${formatBytes(sparkle.transferred ?? 0)} / ${formatBytes(sparkle.total)}`
                                    : sparkle.transferred
                                      ? `已下载 ${formatBytes(sparkle.transferred)}`
                                      : "正在连接…"}
                            </div>
                            <div
                                style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    marginTop: 18,
                                }}
                            >
                                <span
                                    style={{
                                        fontSize: 12,
                                        color: "var(--text-tertiary)",
                                    }}
                                >
                                    关闭窗口后下载仍会继续
                                </span>
                                <button
                                    className="btn-ghost"
                                    onClick={() => setDownloadDialogVisible(false)}
                                >
                                    关闭
                                </button>
                            </div>
                        </>
                    )}
                    {sparkle.stage === "downloaded" && (
                        <>
                            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
                                v{sparkle.version ?? result?.latestVersion ?? "新版本"} 下载完成
                            </div>
                            <div
                                style={{
                                    fontSize: 13,
                                    color: "var(--text-secondary, var(--text-color))",
                                    lineHeight: 1.7,
                                    marginBottom: 18,
                                }}
                            >
                                立即重启将安装新版本（播放进度不会丢失）；也可以稍后在设置中重启安装，或退出应用时自动安装。
                            </div>
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                                <button
                                    className="btn-ghost"
                                    onClick={async () => {
                                        setDownloadDialogVisible(false);
                                        const ok = await installUpdateOnQuit();
                                        if (ok) {
                                            showToast("已设为退出时自动安装，重启应用即完成更新");
                                        }
                                    }}
                                >
                                    退出时安装
                                </button>
                                <button
                                    className="btn-primary"
                                    onClick={async () => {
                                        const ok = await installUpdateNow();
                                        if (!ok) {
                                            openReleasePage();
                                        }
                                    }}
                                >
                                    立即重启安装
                                </button>
                            </div>
                        </>
                    )}
                    {sparkle.stage === "error" && (
                        <>
                            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
                                更新下载失败
                            </div>
                            <div
                                style={{
                                    fontSize: 13,
                                    color: "var(--text-secondary, var(--text-color))",
                                    lineHeight: 1.7,
                                    marginBottom: 18,
                                    wordBreak: "break-all",
                                }}
                            >
                                {sparkle.error ?? "未知错误"}。可前往下载页手动获取新版本。
                            </div>
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                                <button
                                    className="btn-ghost"
                                    onClick={() => setDownloadDialogVisible(false)}
                                >
                                    关闭
                                </button>
                                <button
                                    className="btn-primary"
                                    onClick={() => openReleasePage(result?.url ?? undefined)}
                                >
                                    前往下载
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        );
    }

    return null;
}
