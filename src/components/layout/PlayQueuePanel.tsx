import React, { useEffect, useRef, useState } from "react";
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
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        panelListener = () => setVisible(true);
        return () => {
            panelListener = null;
        };
    }, []);

    // Esc 关闭：面板是模态遮罩，键盘也应该能退出
    useEffect(() => {
        if (!visible) {
            return;
        }
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setVisible(false);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [visible]);

    // 打开时把当前播放的那一行滚到可视区中央（队列长时不必自己翻找）
    useEffect(() => {
        if (!visible) {
            return;
        }
        listRef.current
            ?.querySelector(".music-row.playing")
            ?.scrollIntoView({ block: "center" });
    }, [visible]);

    if (!visible) {
        return null;
    }

    return (
        <>
            <div
                className="panel-mask"
                style={{
                    // 遮罩只盖内容区：面板既然停在播放条上方，播放条就该保持可用，
                    // 否则"面板不盖住播放条"只是视觉上的，实际仍被遮罩挡住点不到
                    inset: "0 0 var(--playerbar-height) 0",
                    alignItems: "flex-start",
                    justifyContent: "flex-end",
                }}
                onClick={() => setVisible(false)}
            />
            <div
                className="play-queue-panel"
                style={{
                    position: "fixed",
                    right: 0,
                    top: 0,
                    // 停在底部播放条上方。原来同时写了 top/height/bottom 属于过度约束，
                    // bottom 会被忽略，导致面板盖住播放条无法暂停切歌。
                    // fixed 元素的百分比高度按视口计算，所以这里等价于 100vh - 72px。
                    height: "calc(100% - var(--playerbar-height))",
                    borderTopLeftRadius: "10px",
                    borderBottomLeftRadius: "10px",
                    width: 320,
                    background: "var(--page-bg)",
                    borderLeft: "1px solid var(--divider)",
                    zIndex: 210,
                    display: "flex",
                    flexDirection: "column",
                    boxShadow: "-8px 0 32px rgba(0,0,0,0.12)",
                    // 从右侧滑入，比原来的 slide-up（向上滑）更符合右侧抽屉的动线
                    animation: "slide-in-right 0.2s ease",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "16px 16px 10px",
                        flexShrink: 0,
                    }}
                >
                    <div style={{ fontWeight: 600, fontSize: 15 }}>
                        播放列表（{playList.length}）
                    </div>
                    <div
                        className="play-queue-close"
                        title="关闭播放列表"
                        onClick={() => setVisible(false)}
                    >
                        <Icon name="close" size={15} />
                    </div>
                </div>
                <div
                    ref={listRef}
                    style={{ flex: 1, overflowY: "auto", padding: "0 8px 12px" }}
                >
                    {playList.map((item, index) => {
                        const isCurrent = TrackPlayerSingleton.isCurrentMusic(item);
                        return (
                            <div
                                key={`${item.platform}-${item.id}-${index}`}
                                className={`music-row${isCurrent ? " playing" : ""}`}
                                style={{ gridTemplateColumns: "1fr 24px" }}
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
                                <span
                                    className="music-action-btn"
                                    title="从播放列表移除"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        TrackPlayerSingleton.remove(item);
                                    }}
                                >
                                    <Icon name="close" size={12} />
                                </span>
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
                        alignItems: "center",
                        flexShrink: 0,
                        gap: 12,
                    }}
                >
                    <span
                        style={{
                            fontSize: 12,
                            color: "var(--text-tertiary)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                        title={currentMusic ? currentMusic.title : undefined}
                    >
                        {currentMusic ? `正在播放：${currentMusic.title}` : "未在播放"}
                    </span>
                    <span
                        style={{
                            fontSize: 12,
                            color: "var(--primary-color)",
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                            flexShrink: 0,
                        }}
                        title="清空播放列表"
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
