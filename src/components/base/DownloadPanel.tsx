import React, { useEffect, useState } from "react";
import Icon from "./Icon";
import { startDownload } from "@/core/downloadManager";
import { getQuality } from "@/core/appConfig";
import { showToast } from "./Toast";

/**
 * 下载音质选择弹窗：选择音质后开始下载
 */

const qualityOptions: { key: IMusic.IQualityKey; label: string; desc: string }[] = [
    { key: "standard", label: "标准品质", desc: "文件较小，音质一般" },
    { key: "high", label: "高清品质", desc: "320kbps，音质较好" },
    { key: "super", label: "无损品质", desc: "FLAC 无损，文件较大" },
    { key: "low", label: "低品质", desc: "省流量" },
];

let panelListener: ((items: IMusic.IMusicItem[]) => void) | null = null;

export function showDownloadPanel(items: IMusic.IMusicItem[]) {
    panelListener?.(items);
}

export default function DownloadPanelHost() {
    const [items, setItems] = useState<IMusic.IMusicItem[] | null>(null);
    const [quality, setQuality] = useState<IMusic.IQualityKey>(getQuality());

    useEffect(() => {
        panelListener = (it) => {
            setItems(it);
            setQuality(getQuality());
        };
        return () => {
            panelListener = null;
        };
    }, []);

    if (!items?.length) {
        return null;
    }

    const close = () => setItems(null);

    const confirm = async () => {
        const added = await startDownload(items, quality);
        showToast(
            added > 0
                ? `已添加 ${added} 首歌曲到下载队列（${quality}）`
                : "所选歌曲已在下载列表中",
        );
        close();
    };

    return (
        <div className="panel-mask" onClick={close}>
            <div
                className="panel-body"
                style={{ width: 400 }}
                onClick={(e) => e.stopPropagation()}
            >
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 14,
                    }}
                >
                    <div style={{ fontSize: 16, fontWeight: 600 }}>
                        下载 {items.length} 首歌曲
                    </div>
                    <Icon
                        name="close"
                        size={16}
                        style={{ cursor: "pointer" }}
                        onClick={close}
                    />
                </div>

                <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 10 }}>
                    选择下载音质
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
                    {qualityOptions.map((opt) => (
                        <div
                            key={opt.key}
                            className="settings-item"
                            style={{
                                marginBottom: 0,
                                cursor: "pointer",
                                background:
                                    quality === opt.key ? "var(--hover-bg)" : undefined,
                            }}
                            onClick={() => setQuality(opt.key)}
                        >
                            <div>
                                <div className="settings-item-label">
                                    {opt.label}
                                    {opt.key === getQuality() && (
                                        <span className="tag">默认</span>
                                    )}
                                </div>
                                <div className="settings-item-desc">{opt.desc}</div>
                            </div>
                            {quality === opt.key && (
                                <Icon
                                    name="play"
                                    size={14}
                                    style={{ color: "var(--primary-color)" }}
                                />
                            )}
                        </div>
                    ))}
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    <button className="btn-ghost" onClick={close}>
                        取消
                    </button>
                    <button className="btn-primary" onClick={confirm}>
                        <Icon name="download" size={14} />
                        开始下载
                    </button>
                </div>
            </div>
        </div>
    );
}
