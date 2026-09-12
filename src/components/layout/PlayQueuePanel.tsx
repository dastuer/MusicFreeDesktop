import React, { useEffect, useState } from "react";
import Icon from "../base/Icon";
import {
    TrackPlayerSingleton,
    useCurrentMusic,
    usePlayList,
} from "@/core/trackPlayer";

/**
 * 播放列表面板（右侧抽屉风格）
 */

let panelListener: (() => void) | null = null;

export function showPlayQueuePanel() {
    panelListener?.();
}

export default function PlayQueuePanelHost() {
    const [visible, setVisible] = useState(false);
    const playList = usePlayList();
    const currentMusic = useCurrentMusic();

    useEffect(() => {
        panelListener = () => setVisible(true);
        return () => {
            panelListener = null;
        };
    }, []);

    if (!visible) {
        return null;
    }

    return (
        <>
            <div
                className="panel-mask"
                style={{ alignItems: "flex-start", justifyContent: "flex-end" }}
                onClick={() => setVisible(false)}
            />
            <div
                style={{
                    position: "fixed",
                    right: 0,
                    top: 0,
                    bottom: 72,
                    width: 320,
                    background: "var(--page-bg)",
                    borderLeft: "1px solid var(--divider)",
                    zIndex: 210,
                    display: "flex",
                    flexDirection: "column",
                    boxShadow: "-8px 0 32px rgba(0,0,0,0.12)",
                    animation: "slide-up 0.2s ease",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "16px 16px 10px",
                    }}
                >
                    <div style={{ fontWeight: 600, fontSize: 15 }}>
                        播放列表（{playList.length}）
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                        <Icon
                            name="close"
                            size={15}
                            style={{ cursor: "pointer" }}
                        />
                    </div>
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 12px" }}>
                    {playList.map((item, index) => {
                        const isCurrent = TrackPlayerSingleton.isCurrentMusic(item);
                        return (
                            <div
                                key={`${item.platform}-${item.id}-${index}`}
                                className={`music-row${isCurrent ? " playing" : ""}`}
                                style={{ gridTemplateColumns: "1fr 16px" }}
                                onClick={() => TrackPlayerSingleton.play(item)}
                            >
                                <div style={{ minWidth: 0 }}>
                                    <div
                                        className="music-row-title"
                                        style={{ fontSize: 13 }}
                                    >
                                        {item.title}
                                    </div>
                                    <div
                                        className="music-row-artist"
                                        style={{ fontSize: 12 }}
                                    >
                                        {item.artist}
                                    </div>
                                </div>
                                <Icon
                                    name="close"
                                    size={12}
                                    style={{ color: "var(--text-tertiary)" }}
                                    onClick={(e: any) => {
                                        e?.stopPropagation?.();
                                        TrackPlayerSingleton.remove(item);
                                    }}
                                />
                            </div>
                        );
                    })}
                    {!playList.length && (
                        <div className="empty-hint">播放列表为空</div>
                    )}
                </div>
                <div
                    style={{
                        padding: "10px 16px",
                        borderTop: "1px solid var(--divider)",
                        display: "flex",
                        justifyContent: "space-between",
                    }}
                >
                    <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                        {currentMusic ? `正在播放：${currentMusic.title}` : "未在播放"}
                    </span>
                    <span
                        style={{
                            fontSize: 12,
                            color: "var(--primary-color)",
                            cursor: "pointer",
                        }}
                        onClick={async () => {
                            await TrackPlayerSingleton.clearPlayList();
                            setVisible(false);
                        }}
                    >
                        清空
                    </span>
                </div>
            </div>
        </>
    );
}
