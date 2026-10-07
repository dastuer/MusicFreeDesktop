import React, { useEffect, useRef, useState } from "react";
import Draggable from "react-draggable";
import Icon from "../base/Icon";
import Cover from "../base/Cover";
import { showContextMenu } from "../base/ContextMenu";
import { showAddToSheetPanel } from "../base/AddToSheetPanel";
import { showDownloadPanel } from "../base/DownloadPanel";
import { navigate } from "@/core/router";
import { navigateToArtist } from "@/utils/artistNav";
import { TrackPlayerSingleton, useCurrentMusic, usePlayList } from "@/core/trackPlayer";

/**
 * 播放列表面板（右侧抽屉）：
 *  - 单击播放、整行拖拽排序（与侧边栏歌单同一套 react-draggable 档位让位交互）；
 *  - 行右键：下一首播放 / 收藏 / 下载 / 查看专辑 / 查看歌手 / 从列表移除；
 *  - 底部「收藏全部」把整份队列收进歌单（走收藏面板）；清空要确认（一按就没的不能是误触）。
 * 顺序是权威状态：TrackPlayer.reorderInQueue 落盘，重启后原样还原。
 */

let panelListener: (() => void) | null = null;

export function showPlayQueuePanel() {
    panelListener?.();
}

/** 一次拖动会话；dragRef 是权威，drag state 只是渲染镜像（与 Sidebar 同一模式） */
interface DragState {
    key: string;
    startIndex: number;
    /** 自拖拽起点累计的指针位移（px） */
    y: number;
    targetIndex: number;
    /** 超过 3px 才算真拖了，普通点击不触发抬起效果与 click 抑制 */
    moved: boolean;
}

function formatDuration(seconds?: number) {
    if (!seconds || !Number.isFinite(seconds)) {
        return "-:--";
    }
    const min = Math.floor(seconds / 60);
    const sec = Math.round(seconds % 60);
    return `${min}:${sec.toString().padStart(2, "0")}`;
}

/** 队列行高 = 40 封面 + 上下 padding 8；行距由列表容器 gap 固定，档位据此算 */
const ROW_PITCH = 48;

/** 行右键菜单：与列表页歌曲行的口径对齐，但操作对象是「队列里的这一行」。
 * onClosePanel：查看专辑/歌手这类跳页的操作先把面板收起——路由栈里叠着详情页，
 * 面板浮在新页面之上没有意义；收藏/下载弹窗层级已压在面板之上，不必关。 */
function openRowMenu(
    e: React.MouseEvent,
    musicItem: IMusic.IMusicItem,
    onClosePanel: () => void,
) {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(
        e.clientX,
        e.clientY,
        [
            {
                title: "下一首播放",
                icon: "forward",
                onClick: () => TrackPlayerSingleton.addNext(musicItem),
            },
            {
                title: "收藏到歌单",
                icon: "addToSheet",
                onClick: () => showAddToSheetPanel(musicItem),
            },
            ...(musicItem.localPath
                ? []
                : [
                      {
                          title: "下载",
                          icon: "download",
                          onClick: () => showDownloadPanel([musicItem]),
                      },
                  ]),
            ...(musicItem.album && !musicItem.localPath
                ? [
                      {
                          title: "查看专辑",
                          icon: "musicNote",
                          onClick: () => {
                              onClosePanel();
                              navigate("albumDetail", { albumItem: musicItem as any });
                          },
                      },
                  ]
                : []),
            ...(musicItem.artist
                ? [
                      {
                          title: "查看歌手",
                          icon: "search",
                          onClick: () => {
                              onClosePanel();
                              void navigateToArtist(musicItem);
                          },
                      },
                  ]
                : []),
            {
                title: "从播放列表移除",
                icon: "close",
                danger: true,
                onClick: () => void TrackPlayerSingleton.remove(musicItem),
            },
        ],
    );
}

export default function PlayQueuePanelHost() {
    const [visible, setVisible] = useState(false);
    const [confirmClear, setConfirmClear] = useState(false);
    const playList = usePlayList();
    const currentMusic = useCurrentMusic();
    const listRef = useRef<HTMLDivElement>(null);

    // ---------- 拖拽排序 ----------
    const dragRef = useRef<DragState | null>(null);
    const [drag, setDrag] = useState<DragState | null>(null);
    // 拖完松手紧跟着的那次 click 是拖拽的收尾，不是「播放这首歌」
    const suppressClickUntilRef = useRef(0);

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
            ?.querySelector(".queue-row.playing")
            ?.scrollIntoView({ block: "center" });
    }, [visible]);

    const keyOf = (it: IMusic.IMusicItem, index: number) =>
        it.id != null ? `${it.platform}-${it.id}` : `queue-row-${index}`;

    const handleDragStart = (key: string, startIndex: number) => {
        dragRef.current = { key, startIndex, y: 0, targetIndex: startIndex, moved: false };
        setDrag(dragRef.current);
    };

    const handleDragMove = (deltaY: number) => {
        const cur = dragRef.current;
        if (!cur) {
            return;
        }
        const y = cur.y + deltaY;
        const targetIndex = Math.max(
            0,
            Math.min(playList.length - 1, cur.startIndex + Math.round(y / ROW_PITCH)),
        );
        dragRef.current = { ...cur, y, targetIndex, moved: cur.moved || Math.abs(y) > 3 };
        setDrag(dragRef.current);
    };

    const handleDragStop = () => {
        const d = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (!d || !d.moved || d.targetIndex === d.startIndex) {
            return;
        }
        suppressClickUntilRef.current = Date.now() + 400;
        TrackPlayerSingleton.reorderInQueue(d.startIndex, d.targetIndex);
    };

    const handleRowClick = (item: IMusic.IMusicItem) => {
        if (Date.now() < suppressClickUntilRef.current) {
            return;
        }
        void TrackPlayerSingleton.play(item);
    };

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
                    // 全局 .panel-mask 已提到 220（收藏/下载弹窗压在队列面板之上）；
                    // 本遮罩是面板自己的底衬，必须压回 200，否则盖住自家面板和弹窗
                    zIndex: 200,
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
                    style={{
                        flex: 1,
                        overflowY: "auto",
                        padding: "0 8px 12px",
                        display: "flex",
                        flexDirection: "column",
                        gap: ROW_PITCH - 40,
                    }}
                >
                    {playList.map((item, index) => {
                        const isCurrent = TrackPlayerSingleton.isCurrentMusic(item);
                        const k = keyOf(item, index);
                        const draggingSelf = drag?.key === k && drag.moved;
                        // 其余行给被拖行让位：跨过一个档位就补上 48px 过渡位移
                        let shiftY = 0;
                        if (drag?.moved && drag.key !== k) {
                            if (index > drag.startIndex && index <= drag.targetIndex) {
                                shiftY = -ROW_PITCH;
                            } else if (index < drag.startIndex && index >= drag.targetIndex) {
                                shiftY = ROW_PITCH;
                            }
                        }
                        return (
                            <QueueDraggable
                                key={`${k}-${index}`}
                                dragging={!!draggingSelf}
                                offsetY={drag?.key === k ? drag.y : 0}
                                shiftY={shiftY}
                                onStart={() => handleDragStart(k, index)}
                                onMove={handleDragMove}
                                onStop={handleDragStop}
                            >
                                <div
                                    className={`queue-row${isCurrent ? " playing" : ""}${
                                        draggingSelf ? " dragging" : ""
                                    }`}
                                    style={{
                                        transform:
                                            !draggingSelf && shiftY
                                                ? `translateY(${shiftY}px)`
                                                : undefined,
                                        transition: draggingSelf ? "none" : "transform 160ms ease",
                                    }}
                                    onClick={() => handleRowClick(item)}
                                    onContextMenu={(e) =>
                                        openRowMenu(e, item, () => setVisible(false))
                                    }
                                >
                                    <span className="queue-row-index">
                                        {isCurrent ? (
                                            <Icon
                                                name="musicNote"
                                                size={13}
                                                style={{ color: "var(--primary-color)" }}
                                            />
                                        ) : (
                                            index + 1
                                        )}
                                    </span>
                                    <Cover src={item.artwork} size={40} borderRadius={5} />
                                    <div className="queue-row-info">
                                        <div className="queue-row-title">{item.title}</div>
                                        <div className="queue-row-artist">{item.artist}</div>
                                    </div>
                                    <span className="queue-row-duration">
                                        {formatDuration(item.duration)}
                                    </span>
                                    <span
                                        className="music-action-btn"
                                        title="从播放列表移除"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            void TrackPlayerSingleton.remove(item);
                                        }}
                                    >
                                        <Icon name="close" size={12} />
                                    </span>
                                </div>
                            </QueueDraggable>
                        );
                    })}
                    {!playList.length && <div className="empty-hint">播放列表为空</div>}
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
                            flex: 1,
                            minWidth: 0,
                        }}
                        title={currentMusic ? currentMusic.title : undefined}
                    >
                        {currentMusic ? `正在播放：${currentMusic.title}` : "未在播放"}
                    </span>
                    {playList.length > 0 && (
                        <span
                            style={{
                                fontSize: 12,
                                color: "var(--text-secondary)",
                                cursor: "pointer",
                                whiteSpace: "nowrap",
                                flexShrink: 0,
                            }}
                            title="把当前播放列表整份收藏进歌单（可选已有歌单或新建）"
                            onClick={() => showAddToSheetPanel([...playList])}
                        >
                            收藏全部
                        </span>
                    )}
                    {confirmClear ? (
                        <span style={{ display: "flex", gap: 8, flexShrink: 0, fontSize: 12 }}>
                            <span
                                style={{ color: "var(--primary-color)", cursor: "pointer" }}
                                onClick={async () => {
                                    await TrackPlayerSingleton.clearPlayList();
                                    setConfirmClear(false);
                                    setVisible(false);
                                }}
                            >
                                确认清空
                            </span>
                            <span
                                style={{ color: "var(--text-tertiary)", cursor: "pointer" }}
                                onClick={() => setConfirmClear(false)}
                            >
                                取消
                            </span>
                        </span>
                    ) : (
                        playList.length > 0 && (
                            <span
                                style={{
                                    fontSize: 12,
                                    color: "var(--primary-color)",
                                    cursor: "pointer",
                                    whiteSpace: "nowrap",
                                    flexShrink: 0,
                                }}
                                title="清空播放列表（当前这首继续播）"
                                onClick={() => setConfirmClear(true)}
                            >
                                清空
                            </span>
                        )
                    )}
                </div>
            </div>
        </>
    );
}

/**
 * 队列行的拖拽外壳（与侧边栏 SheetDraggable 同一分层方案）：
 * 外层 transform 由 Draggable 接管（被拖行跟随指针），
 * 内层 .queue-row 的 transform 留给「让位」过渡动画——
 * 两者必须分层，否则 Draggable 写入的 translate 会把让位位移覆盖掉。
 */
function QueueDraggable(props: {
    dragging: boolean;
    offsetY: number;
    shiftY: number;
    onStart: () => void;
    onMove: (deltaY: number) => void;
    onStop: () => void;
    children: React.ReactNode;
}) {
    const nodeRef = useRef<HTMLDivElement>(null);
    return (
        <Draggable
            nodeRef={nodeRef}
            axis="y"
            position={{ x: 0, y: props.offsetY }}
            onStart={props.onStart}
            onDrag={(_, data) => props.onMove(data.deltaY)}
            onStop={props.onStop}
        >
            <div
                ref={nodeRef}
                style={{ position: "relative", zIndex: props.dragging ? 10 : undefined }}
            >
                {props.children}
            </div>
        </Draggable>
    );
}
