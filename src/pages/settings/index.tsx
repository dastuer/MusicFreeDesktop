import React, { useEffect, useState } from "react";
import { setTheme, useThemeType } from "@/core/theme";
import { getQuality, setQuality } from "@/core/appConfig";
import { ipcInvoke } from "@/core/ipc";

/**
 * 设置页：外观 / 播放 / 关于
 */

const qualityLabels: Record<IMusic.IQualityKey, string> = {
    low: "低品质",
    standard: "标准",
    high: "高品质",
    super: "无损",
};

export default function SettingsPage() {
    const themeType = useThemeType();
    const [quality, setQualityState] = useState<IMusic.IQualityKey>(getQuality());
    const [appInfo, setAppInfo] = useState<any>(null);

    useEffect(() => {
        ipcInvoke("app:getInfo").then(setAppInfo);
    }, []);

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
                                className={`segment-item${
                                    (mode === "auto" && localStorage.getItem("theme") === "auto") ||
                                    themeType === mode
                                        ? " active"
                                        : ""
                                }`}
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
            </div>

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
