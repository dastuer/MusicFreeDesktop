import React, { useEffect, useState } from "react";
import { setTheme, useThemeSetting } from "@/core/theme";
import { setDefaultQuality, useQuality } from "@/core/trackPlayer";
import {
    clearAllProgress,
    getRememberedProgress,
    isAutoPlayOnLaunchEnabled,
    isRememberProgressEnabled,
    setAutoPlayOnLaunchEnabled,
    setRememberProgressEnabled,
} from "@/core/playProgress";
import { ipcInvoke } from "@/core/ipc";
import { showToast } from "@/components/base/Toast";
import {
    installUpdateNow,
    openReleasePage,
    setAutoCheck,
    useUpdateStatus,
} from "@/core/updater";
import BackupSection from "./BackupSection";
import CacheSection from "./CacheSection";
import NeteaseSection from "./NeteaseSection";

/**
 * 设置页：通用 / 网易云 / 外观 / 播放 / 快捷键 / 下载 / 存储与缓存 / 关于
 */

const qualityLabels: Record<IMusic.IQualityKey, string> = {
    low: "低品质",
    standard: "标准",
    high: "高品质",
    super: "无损",
};

/** 秒 → m:ss（只给这一页展示用；PlayerBar 里有一份同名实现，未导出） */
function formatTime(s: number) {
    const sec = Math.floor(Math.max(s, 0) % 60);
    const min = Math.floor(Math.max(s, 0) / 60);
    return `${min}:${sec.toString().padStart(2, "0")}`;
}

/** 布尔型设置项：用与主题/音质一致的 segment 样式，不额外引入开关组件 */
function ToggleRow(props: {
    label: string;
    desc: string;
    value: boolean;
    onChange: (value: boolean) => void;
}) {
    const { label, desc, value, onChange } = props;
    return (
        <div className="settings-item">
            <div>
                <div className="settings-item-label">{label}</div>
                <div className="settings-item-desc">{desc}</div>
            </div>
            <div className="segment">
                <button
                    className={`segment-item${value ? " active" : ""}`}
                    onClick={() => onChange(true)}
                >
                    开
                </button>
                <button
                    className={`segment-item${!value ? " active" : ""}`}
                    onClick={() => onChange(false)}
                >
                    关
                </button>
            </div>
        </div>
    );
}

export default function SettingsPage() {
    const themeSetting = useThemeSetting();
    // 与播放栏共享同一份音质状态：两边随便哪边改，另一处都跟着变
    const quality = useQuality();
    const [appInfo, setAppInfo] = useState<any>(null);
    const [downloadDir, setDownloadDir] = useState("");
    const [rememberProgress, setRememberProgressState] = useState(
        () => isRememberProgressEnabled(),
    );
    const [autoPlayOnLaunch, setAutoPlayOnLaunchState] = useState(
        () => isAutoPlayOnLaunchEnabled(),
    );
    const [remembered, setRemembered] = useState(() => getRememberedProgress());
    // null 表示还没从主进程读到系统登录项的真实状态
    const [autoLaunch, setAutoLaunch] = useState<boolean | null>(null);
    // 关闭行为 / 托盘 / 全局快捷键（主进程 config 持有，这边只展示与切换）
    const [closeBehavior, setCloseBehavior] = useState<"minimize" | "quit">("minimize");
    const [trayVisible, setTrayVisible] = useState(true);
    const [globalShortcuts, setGlobalShortcuts] = useState(false);
    // 检查更新（GitHub Releases / macOS Sparkle）：结果与 App 启动检查共享同一份 jotai 状态
    const { result: updateResult, autoCheck, checking, sparkle, check: checkUpdate } = useUpdateStatus();
    useEffect(() => {
        ipcInvoke("app:getInfo").then(setAppInfo);
        ipcInvoke("download:getDir").then((dir) => setDownloadDir(dir ?? ""));
        ipcInvoke("app:getAutoLaunch").then((s) => setAutoLaunch(!!s?.enabled));
        ipcInvoke("app:getCloseBehavior").then((b) => setCloseBehavior(b === "quit" ? "quit" : "minimize"));
        ipcInvoke("config:get", "tray.visible", true).then((v) => setTrayVisible(v !== false));
        ipcInvoke("config:get", "app.globalShortcuts.enabled", false).then((v) => setGlobalShortcuts(v === true));
    }, []);

    const changeCloseBehavior = async (next: "minimize" | "quit") => {
        const applied = await ipcInvoke<string>("app:setCloseBehavior", next);
        setCloseBehavior(applied === "quit" ? "quit" : "minimize");
        showToast(next === "minimize" ? "关闭窗口后将最小化到托盘" : "关闭窗口后将直接退出");
    };

    const changeTrayVisible = async (next: boolean) => {
        const applied = await ipcInvoke<boolean>("system:setTrayVisible", next);
        setTrayVisible(applied !== false);
    };

    const changeGlobalShortcuts = async (next: boolean) => {
        const ok = await ipcInvoke<boolean>("system:setShortcutsEnabled", next);
        setGlobalShortcuts(!!ok);
        if (next && !ok) {
            showToast("注册失败：快捷键可能被其他应用占用");
        }
    };

    const changeAutoLaunch = async (next: boolean) => {
        const res = await ipcInvoke<{ supported: boolean; enabled: boolean }>(
            "app:setAutoLaunch",
            next,
        );
        if (!res?.supported) {
            showToast("开发模式（未打包）下不可用，打包安装后才能开机自启动");
            return;
        }
        setAutoLaunch(res.enabled);
        if (next && !res.enabled) {
            // macOS 13+ 首次注册要等用户在系统设置里批准，先把出路告诉用户
            showToast("未能注册登录项，请在系统设置的「登录项」中允许 MusicFreeDesktop");
        } else {
            showToast(next ? "已开启开机自启动" : "已关闭开机自启动");
        }
    };

    const changeDownloadDir = async () => {
        const dir = await ipcInvoke("download:pickDir");
        if (dir) {
            setDownloadDir(dir);
            showToast(`下载目录已更改为 ${dir}`);
        }
    };

    return (
        <div style={{ maxWidth: 720 }}>
            <div className="section-title">设置</div>

            <div className="settings-group">
                <div className="settings-group-title">通用</div>
                <ToggleRow
                    label="开机自启动"
                    desc={
                        appInfo?.isPackaged === false
                            ? "开发模式（未打包）下不可用，打包安装后生效"
                            : "登录系统后自动启动 MusicFreeDesktop"
                    }
                    value={autoLaunch === true}
                    onChange={changeAutoLaunch}
                />
                <div className="settings-item">
                    <div>
                        <div className="settings-item-label">点击关闭按钮时</div>
                        <div className="settings-item-desc">
                            最小化到托盘：窗口收进系统托盘，音乐继续播；直接退出：关窗即退出应用
                        </div>
                    </div>
                    <div className="segment">
                        <button
                            className={`segment-item${closeBehavior === "minimize" ? " active" : ""}`}
                            onClick={() => changeCloseBehavior("minimize")}
                        >
                            最小化到托盘
                        </button>
                        <button
                            className={`segment-item${closeBehavior === "quit" ? " active" : ""}`}
                            onClick={() => changeCloseBehavior("quit")}
                        >
                            直接退出
                        </button>
                    </div>
                </div>
                <ToggleRow
                    label="显示系统托盘图标"
                    desc="托盘菜单可播放/暂停/切歌/退出；关掉后应用仍按上面的关闭行为工作"
                    value={trayVisible}
                    onChange={changeTrayVisible}
                />
            </div>

            <NeteaseSection />

            <div className="settings-group">
                <div className="settings-group-title">外观</div>
                <div className="settings-item">
                    <div>
                        <div className="settings-item-label">主题</div>
                        <div className="settings-item-desc">跟随系统或手动指定明暗</div>
                    </div>
                    <div className="segment">
                        {(["light", "dark", "auto"] as const).map((mode) => (
                            <button
                                key={mode}
                                className={`segment-item${themeSetting === mode ? " active" : ""}`}
                                onClick={() => setTheme(mode)}
                            >
                                {mode === "light" ? "浅色" : mode === "dark" ? "深色" : "跟随系统"}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            <div className="settings-group">
                <div className="settings-group-title">播放</div>
                <div className="settings-item">
                    <div>
                        <div className="settings-item-label">默认音质</div>
                        <div className="settings-item-desc">获取播放链接时优先使用的音质</div>
                    </div>
                    <div className="segment">
                        {(Object.keys(qualityLabels) as IMusic.IQualityKey[]).map((q) => (
                            <button
                                key={q}
                                className={`segment-item${quality === q ? " active" : ""}`}
                                onClick={() => {
                                    setDefaultQuality(q);
                                }}
                            >
                                {qualityLabels[q]}
                            </button>
                        ))}
                    </div>
                </div>

                <ToggleRow
                    label="记忆播放进度"
                    desc={
                        autoPlayOnLaunch
                            ? "退出应用时记住当前歌曲听到的位置。下次启动自动播放时从这个位置接着听"
                            : "退出应用时记住当前歌曲听到的位置。下次启动进度条停在这个位置，按播放接着听（不会自动出声）"
                    }
                    value={rememberProgress}
                    onChange={(next) => {
                        setRememberProgressEnabled(next);
                        setRememberProgressState(next);
                        // 关的时候会把待写数据落盘，这里顺手刷新下面那行的展示
                        setRemembered(getRememberedProgress());
                    }}
                />

                {rememberProgress && (
                    <div className="settings-item">
                        <div style={{ minWidth: 0 }}>
                            <div className="settings-item-label">已记忆的播放进度</div>
                            <div className="settings-item-desc">
                                {remembered
                                    ? `《${remembered.title || "当前歌曲"}》· 听到 ${formatTime(
                                          remembered.position,
                                      )}`
                                    : "暂无记录，退出应用时会自动记一次"}
                            </div>
                        </div>
                        <button
                            className="btn-ghost progress-clear-btn"
                            style={{ flexShrink: 0 }}
                            disabled={!remembered}
                            onClick={() => {
                                clearAllProgress();
                                setRemembered(null);
                                showToast("已清除记忆的播放进度");
                            }}
                        >
                            清除
                        </button>
                    </div>
                )}

                <ToggleRow
                    label="程序启动时自动播放"
                    desc="打开应用后自动接着播放上次退出时在听的歌；没有在听的歌时，自动播放播放队列的第一首。关闭时启动不出声，要不要播放由你按播放决定"
                    value={autoPlayOnLaunch}
                    onChange={(next) => {
                        setAutoPlayOnLaunchEnabled(next);
                        setAutoPlayOnLaunchState(next);
                    }}
                />
            </div>

            <div className="settings-group">
                <div className="settings-group-title">快捷键</div>
                <ToggleRow
                    label="全局媒体键"
                    desc="媒体键（播放/暂停、上一首、下一首）在应用未聚焦时也可用。macOS 控制中心与 Windows 系统媒体面板默认就生效，此项是独立于它们的系统级兜底"
                    value={globalShortcuts}
                    onChange={changeGlobalShortcuts}
                />
                <div className="settings-item">
                    <div>
                        <div className="settings-item-label">应用内快捷键</div>
                        <div className="settings-item-desc">
                            空格 播放/暂停 · ← 上一首 · → 下一首 · ↑/↓ 音量加减（输入框中不生效）
                        </div>
                    </div>
                </div>
                <div className="settings-item">
                    <div>
                        <div className="settings-item-label">定时关闭</div>
                        <div className="settings-item-desc">
                            播放栏「更多」菜单 → 定时关闭：到点暂停播放，支持倒计时与「播完 N 首」
                        </div>
                    </div>
                </div>
            </div>

            <div className="settings-group">
                <div className="settings-group-title">下载</div>
                <div className="settings-item">
                    <div style={{ minWidth: 0 }}>
                        <div className="settings-item-label">下载目录</div>
                        <div
                            className="settings-item-desc"
                            style={{
                                wordBreak: "break-all",
                                whiteSpace: "normal",
                            }}
                        >
                            {downloadDir || "加载中…"}
                        </div>
                    </div>
                    <button className="btn-ghost" style={{ flexShrink: 0 }} onClick={changeDownloadDir}>
                        修改目录
                    </button>
                </div>
            </div>

            <BackupSection />

            <CacheSection />

            <div className="settings-group">
                <div className="settings-group-title">关于</div>
                <div className="settings-item">
                    <div>
                        <div className="settings-item-label">MusicFree Desktop</div>
                        <div className="settings-item-desc">
                            v{appInfo?.version ?? "1.0.0"} · 基于 Electron{" "}
                            {appInfo?.platform === "darwin" ? "· macOS" : ""} · 数据目录：
                            {appInfo?.userDataPath}
                        </div>
                    </div>
                </div>
                <div className="settings-item">
                    <div style={{ minWidth: 0 }}>
                        <div className="settings-item-label">检查更新</div>
                        <div className="settings-item-desc">
                            {updateDesc(updateResult, sparkle, appInfo?.version)}
                        </div>
                    </div>
                    <button
                        className="btn-ghost"
                        style={{ flexShrink: 0 }}
                        disabled={checking || sparkle.stage === "checking" || sparkle.stage === "downloading"}
                        onClick={async () => {
                            // Sparkle 引擎路径返回 null（结果经状态推送更新到 sparkle stage）；
                            // GitHub API 路径返回本次结果，直接提示
                            const res = await checkUpdate();
                            if (!res) {
                                return;
                            }
                            if (res.error) {
                                showToast(`检查更新失败：${res.error}`);
                            } else if (res.updateAvailable) {
                                showToast(`发现新版本 v${res.latestVersion}（当前 v${res.currentVersion}）`);
                            } else {
                                showToast(`当前已是最新版本（v${res.currentVersion}）`);
                            }
                        }}
                    >
                        {checking || sparkle.stage === "checking" || sparkle.stage === "downloading"
                            ? "检查中…"
                            : "检查更新"}
                    </button>
                </div>
                {sparkle.stage === "downloading" && (
                    <div className="settings-item">
                        <div style={{ minWidth: 0 }}>
                            <div className="settings-item-label">
                                正在下载 v{sparkle.version ?? "新版本"}
                            </div>
                            <div className="settings-item-desc">
                                下载完成后可一键安装（应用会自动重启进入新版本）
                            </div>
                            <div className="update-progress-track">
                                <div
                                    className="update-progress-bar"
                                    style={{ width: `${Math.min(100, Math.max(0, sparkle.progress ?? 0))}%` }}
                                />
                            </div>
                        </div>
                    </div>
                )}
                {sparkle.stage === "downloaded" && (
                    <div className="settings-item">
                        <div>
                            <div className="settings-item-label">
                                v{sparkle.version ?? "新版本"} 已就绪
                            </div>
                            <div className="settings-item-desc">
                                安装将退出应用并自动重启进入新版本，播放进度不会丢失
                            </div>
                        </div>
                        <button
                            className="btn-primary"
                            style={{ flexShrink: 0 }}
                            onClick={async () => {
                                const ok = await installUpdateNow();
                                if (!ok) {
                                    openReleasePage();
                                }
                            }}
                        >
                            重启并安装
                        </button>
                    </div>
                )}
                {sparkle.stage === "error" && sparkle.error && (
                    <div className="settings-item">
                        <div>
                            <div className="settings-item-label">自动更新出错</div>
                            <div
                                className="settings-item-desc"
                                style={{ wordBreak: "break-all", whiteSpace: "normal" }}
                            >
                                {sparkle.error}。可前往
                                <button
                                    className="btn-ghost"
                                    style={{ margin: "0 4px" }}
                                    onClick={() => openReleasePage()}
                                >
                                    下载页
                                </button>
                                手动获取新版本
                            </div>
                        </div>
                    </div>
                )}
                <ToggleRow
                    label="启动时自动检查更新"
                    desc={
                        sparkle.engine === "sparkle"
                            ? "启动时联网检查新版本；macOS 支持在应用内直接下载并安装，其他平台跳转下载页"
                            : "联网查询 GitHub Releases 上的最新版本，有更新时在界面提醒；不自动下载安装"
                    }
                    value={autoCheck}
                    onChange={(next) => {
                        setAutoCheck(next);
                        showToast(next ? "已开启自动检查更新" : "已关闭自动检查更新");
                    }}
                />
                {updateResult?.updateAvailable && sparkle.stage !== "downloaded" && (
                    <div className="settings-item">
                        <div style={{ minWidth: 0 }}>
                            <div className="settings-item-label">
                                新版本 v{updateResult.latestVersion ?? updateResult.name}
                            </div>
                            <div
                                className="settings-item-desc"
                                style={{
                                    wordBreak: "break-all",
                                    whiteSpace: "normal",
                                }}
                            >
                                {releaseNotesPreview(updateResult.notes) || "暂无更新说明"}
                            </div>
                        </div>
                        <button
                            className="btn-ghost"
                            style={{ flexShrink: 0 }}
                            onClick={() => openReleasePage(updateResult.url ?? undefined)}
                        >
                            前往下载
                        </button>
                    </div>
                )}
                <div className="settings-item">
                    <div>
                        <div className="settings-item-label">插件生态</div>
                        <div className="settings-item-desc">
                            与 MusicFree 移动端音源插件（.js）兼容，在「音源插件」页安装
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

/** 「检查更新」一行 desc：按检查状态给出不同文案（Sparkle 引擎优先展示引擎阶段） */
function updateDesc(
    result: ReturnType<typeof useUpdateStatus>["result"],
    sparkle: ReturnType<typeof useUpdateStatus>["sparkle"],
    fallbackVersion?: string,
) {
    if (sparkle.engine === "sparkle") {
        switch (sparkle.stage) {
            case "available":
                return `发现新版本 v${sparkle.version ?? ""}，正在自动下载`;
            case "downloading":
                return `正在下载 v${sparkle.version ?? "新版本"}（${Math.round(sparkle.progress ?? 0)}%）`;
            case "downloaded":
                return `v${sparkle.version ?? "新版本"} 已下载完成，可安装`;
            case "error":
                return `自动更新出错：${sparkle.error ?? "未知错误"}`;
            default:
                break;
        }
    }
    if (!result) {
        return `当前 v${fallbackVersion ?? "?"} · 更新渠道：GitHub Releases`;
    }
    if (result.error) {
        return `上次检查失败：${result.error}`;
    }
    if (result.updateAvailable) {
        return `发现新版本 ${result.latestVersion}，当前 v${result.currentVersion}`;
    }
    return `当前 v${result.currentVersion}，已是最新版本`;
}

/** 更新说明预览：只取前几行非空文本，Markdown 记号粗略剥掉 */
function releaseNotesPreview(notes: string | null) {
    if (!notes) {
        return "";
    }
    return notes
        .split("\n")
        .map((line) => line.replace(/^[#*\-\s]+/, "").trim())
        .filter(Boolean)
        .slice(0, 4)
        .join("；")
        .slice(0, 120);
}
