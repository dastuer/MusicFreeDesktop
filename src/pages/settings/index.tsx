import React, { useEffect, useState } from "react";
import { setTheme, useThemeSetting } from "@/core/theme";
import { getQuality, setQuality } from "@/core/appConfig";
import {
    clearAllProgress,
    getRememberedProgress,
    isRememberProgressEnabled,
    setRememberProgressEnabled,
} from "@/core/playProgress";
import { ipcInvoke } from "@/core/ipc";
import { showToast } from "@/components/base/Toast";
import BackupSection from "./BackupSection";
import CacheSection from "./CacheSection";

/**
 * 设置页：外观 / 播放 / 下载 / 存储与缓存 / 关于
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
    const [quality, setQualityState] = useState<IMusic.IQualityKey>(getQuality());
    const [appInfo, setAppInfo] = useState<any>(null);
    const [downloadDir, setDownloadDir] = useState("");
    const [rememberProgress, setRememberProgressState] = useState(
        () => isRememberProgressEnabled(),
    );
    const [remembered, setRemembered] = useState(() => getRememberedProgress());
    useEffect(() => {
        ipcInvoke("app:getInfo").then(setAppInfo);
        ipcInvoke("download:getDir").then((dir) => setDownloadDir(dir ?? ""));
    }, []);

    const changeDownloadDir = async () => {
        const dir = await ipcInvoke("download:pickDir");
        if (dir) {
            setDownloadDir(dir);
            showToast(`下载目录已更改为 ${dir}`);
        }
    };

    return (
        <div style={{ maxWidth: 640 }}>
            <div className="section-title">设置</div>

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
                                    setQuality(q);
                                    setQualityState(q);
                                }}
                            >
                                {qualityLabels[q]}
                            </button>
                        ))}
                    </div>
                </div>

                <ToggleRow
                    label="记忆播放进度"
                    desc="退出应用时记住当前歌曲听到的位置。下次启动进度条停在这个位置，按播放接着听（不会自动出声）"
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
                    <div>
                        <div className="settings-item-label">插件生态</div                        >
                        <div className="settings-item-desc">
                            与 MusicFree 移动端音源插件（.js）兼容，在「音源插件」页安装
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
