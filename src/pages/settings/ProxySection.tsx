import React, { useEffect, useState } from "react";
import { ipcInvoke } from "@/core/ipc";
import { showToast } from "@/components/base/Toast";

/**
 * 设置页「网络代理」区块：
 * 开关 + 地址输入 + 测试连接。代理存主进程 configStore，保存后即时生效
 * （axios 全局 agent + Chromium session setProxy），无需重启。
 */

interface ProxyConfig {
    enabled: boolean;
    url: string;
}

/** 主进程持久化的草稿（保存前的输入值单独放 state，避免打字过程被回显覆盖） */
export default function ProxySection() {
    const [config, setConfig] = useState<ProxyConfig | null>(null);
    const [urlDraft, setUrlDraft] = useState("");
    const [testing, setTesting] = useState(false);
    const [lastTest, setLastTest] = useState<string | null>(null);

    useEffect(() => {
        ipcInvoke<ProxyConfig>("proxy:get").then((cfg) => {
            setConfig(cfg ?? { enabled: false, url: "" });
            setUrlDraft(cfg?.url ?? "");
        });
    }, []);

    const save = async (next: { enabled?: boolean; url?: string }) => {
        const res = await ipcInvoke<{ success: boolean; message?: string; config?: ProxyConfig }>(
            "proxy:set",
            next,
        );
        if (!res?.success) {
            showToast(res?.message ?? "保存失败");
            return;
        }
        if (res.config) {
            setConfig(res.config);
            setUrlDraft(res.config.url);
        }
        setLastTest(null);
        showToast(
            res.config?.enabled
                ? "代理已开启并即时生效"
                : "代理已关闭，恢复直连",
        );
    };

    const testConnection = async () => {
        setTesting(true);
        setLastTest(null);
        try {
            const res = await ipcInvoke<{
                success: boolean;
                status?: number;
                ms?: number;
                message?: string;
            }>("proxy:test");
            if (!res) {
                setLastTest("测试失败：无响应");
            } else if (res.success) {
                setLastTest(`连接正常（${res.ms ?? "?"} ms）`);
            } else {
                setLastTest(`连接失败：${res.message ?? `HTTP ${res.status ?? "?"}`}`);
            }
        } finally {
            setTesting(false);
        }
    };

    if (!config) {
        return null;
    }

    return (
        <div className="settings-group">
            <div className="settings-group-title">网络代理</div>
            <div className="settings-item">
                <div>
                    <div className="settings-item-label">启用网络代理</div>
                    <div className="settings-item-desc">
                        开启后音乐播放、音源搜索、网易云接口、检查更新、备份同步都经代理访问；
                        本地与内网地址始终直连。保存后即时生效
                    </div>
                </div>
                <div className="segment">
                    <button
                        className={`segment-item${config.enabled ? " active" : ""}`}
                        onClick={() => save({ enabled: true })}
                    >
                        开
                    </button>
                    <button
                        className={`segment-item${!config.enabled ? " active" : ""}`}
                        onClick={() => save({ enabled: false })}
                    >
                        关
                    </button>
                </div>
            </div>
            <div className="settings-item">
                <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="settings-item-label">代理服务器</div>
                    <div className="settings-item-desc">
                        支持 HTTP 与 SOCKS 代理，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
                    </div>
                </div>
            </div>
            <div className="backup-form" style={{ marginTop: -8 }}>
                <div className="backup-field">
                    <div className="backup-field-label">代理地址</div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input
                            className="text-input"
                            style={{ flex: 1 }}
                            placeholder="http://127.0.0.1:7890"
                            value={urlDraft}
                            onChange={(e) => setUrlDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    void save({ url: urlDraft });
                                }
                            }}
                        />
                        <button
                            className="btn-ghost"
                            style={{ flexShrink: 0 }}
                            disabled={testing}
                            onClick={testConnection}
                        >
                            {testing ? "测试中…" : "测试连接"}
                        </button>
                        <button
                            className="btn-primary"
                            style={{ flexShrink: 0 }}
                            onClick={() => save({ url: urlDraft })}
                        >
                            保存
                        </button>
                    </div>
                    {lastTest ? (
                        <div className="settings-item-desc" style={{ marginTop: 4 }}>
                            {lastTest}
                        </div>
                    ) : null}
                </div>
            </div>
            <div className="settings-item">
                <div>
                    <div className="settings-item-label">macOS 应用内更新</div>
                    <div className="settings-item-desc">
                        Sparkle 更新引擎走系统网络栈，跟随系统代理设置，不使用此处的代理配置
                    </div>
                </div>
            </div>
        </div>
    );
}
