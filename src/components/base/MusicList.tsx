import React, { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import Cover from "./Cover";
import Icon from "./Icon";
import { showContextMenu } from "./ContextMenu";
import { showAddToSheetPanel } from "./AddToSheetPanel";
import { showDownloadPanel } from "./DownloadPanel";
import { TrackPlayerSingleton, useCurrentMusic } from "@/core/trackPlayer";
import { navigate } from "@/core/router";
import {
    batchSetLike,
    getLikedMusicList,
    likesVersionAtom,
    toggleLike,
} from "@/core/musicSheet";
import {
    DownloadStatus,
    IDownloadTask,
    downloadTasksAtom,
    openDownloadInFolder,
    useDownloadSetup,
} from "@/core/downloadManager";
import { showToast } from "./Toast";

/**
 * 歌曲列表（桌面端表格形态）：多选框 / 序号 / 封面+标题 / 歌手 / 专辑 / 操作+时长
 * 支持单击播放、双击播放、右键菜单、多选批量下载/收藏
 */

function formatDuration(seconds?: number) {
    if (!seconds || !Number.isFinite(seconds)) {
        return "-:--";
    }
    const min = Math.floor(seconds / 60);
    const sec = Math.round(seconds % 60);
    return `${min}:${sec.toString().padStart(2, "0")}`;
}

function musicKey(musicItem: IMusic.IMusicItem) {
    return `${musicItem.platform}-${musicItem.id}`;
}

interface IMusicListProps {
    musicList: IMusic.IMusicItem[];
    /** 是否显示封面列（网格行样式） */
    showIndex?: boolean;
    onLoadMore?: () => void;
    isEnd?: boolean;
    loading?: boolean;
    className?: string;
    renderHeader?: React.ReactNode;
    /** 是否启用多选（默认启用） */
    selectable?: boolean;
    /** 传入后在右键菜单中出现「从歌单中移除」 */
    onRemove?: (musicItem: IMusic.IMusicItem) => void;
    /** 喜欢/移除等操作后的回调（页面刷新用） */
    onMusicChanged?: () => void;
}

export default function MusicList(props: IMusicListProps) {
    const {
        musicList,
        onLoadMore,
        isEnd = true,
        loading = false,
        className,
        selectable = true,
        onRemove,
        onMusicChanged,
    } = props;
    const currentMusic = useCurrentMusic();
    const likesVersion = useAtomValue(likesVersionAtom);
    const downloadTasks = useAtomValue(downloadTasksAtom);
    useDownloadSetup();

    const [likedKeys, setLikedKeys] = useState<Set<string>>(new Set());
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

    const keyOf = (musicItem: IMusic.IMusicItem, index?: number) =>
        musicItem.id != null ? musicKey(musicItem) : `row-${index}`;

    // 喜欢状态（任何位置切换喜欢后自动刷新）
    useEffect(() => {
        let cancelled = false;
        getLikedMusicList().then((list) => {
            if (!cancelled) {
                setLikedKeys(new Set(list.map(musicKey)));
            }
        });
        return () => {
            cancelled = true;
        };
    }, [likesVersion]);

    // 下载状态：同一首歌取最新的一条任务
    const downloadStatusMap = useMemo(() => {
        const map: Record<string, { status: DownloadStatus; taskId: string; createdAt: number }> = {};
        for (const task of downloadTasks as IDownloadTask[]) {
            const k = `${task.musicItem.platform}-${task.musicItem.id}`;
            const prev = map[k];
            if (!prev || task.createdAt > prev.createdAt) {
                map[k] = { status: task.status, taskId: task.id, createdAt: task.createdAt };
            }
        }
        return map;
    }, [downloadTasks]);

    // 列表变化后清掉已不存在的选择
    useEffect(() => {
        setSelectedKeys((prev) => {
            const valid = new Set(musicList.map(musicKey));
            const next = new Set([...prev].filter((k) => valid.has(k)));
            return next.size === prev.size ? prev : next;
        });
    }, [musicList]);

    const handleToggleLike = async (musicItem: IMusic.IMusicItem) => {
        const liked = await toggleLike(musicItem);
        showToast(liked ? "已添加到我喜欢的音乐" : "已取消喜欢");
        onMusicChanged?.();
    };

    const toggleSelect = (musicItem: IMusic.IMusicItem) => {
        const k = musicKey(musicItem);
        setSelectedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(k)) {
                next.delete(k);
            } else {
                next.add(k);
            }
            return next;
        });
    };

    const allSelected =
        musicList.length > 0 && musicList.every((it) => selectedKeys.has(musicKey(it)));

    const toggleSelectAll = () => {
        setSelectedKeys(allSelected ? new Set() : new Set(musicList.map(musicKey)));
    };

    const selectedItems = useMemo(
        () => musicList.filter((it) => selectedKeys.has(musicKey(it))),
        [musicList, selectedKeys],
    );

    const clearSelection = () => setSelectedKeys(new Set());

    const downloadSelected = () => {
        showDownloadPanel(selectedItems);
        clearSelection();
    };

    const likeSelected = async (like: boolean) => {
        await batchSetLike(selectedItems, like);
        showToast(like ? `已收藏 ${selectedItems.length} 首歌曲` : `已取消收藏 ${selectedItems.length} 首歌曲`);
        clearSelection();
        onMusicChanged?.();
    };

    const openMenu = async (e: React.MouseEvent, musicItem: IMusic.IMusicItem) => {
        e.preventDefault();
        e.stopPropagation();
        const items: {
            title: string;
            icon?: string;
            danger?: boolean;
            onClick: () => void | Promise<void>;
        }[] = [
            {
                title: likedKeys.has(musicKey(musicItem)) ? "取消喜欢" : "喜欢",
                icon: "heart",
                onClick: () => handleToggleLike(musicItem),
            },
            {
                title: "下一首播放",
                icon: "forward",
                onClick: () => {
                    TrackPlayerSingleton.addNext(musicItem);
                    showToast("已添加到下一首播放");
                },
            },
            {
                title: "添加到播放列表",
                icon: "plus",
                onClick: () => {
                    TrackPlayerSingleton.add(musicItem);
                    showToast("已添加到播放列表");
                },
            },
            {
                title: "收藏到歌单",
                icon: "playQueue",
                onClick: () => showAddToSheetPanel(musicItem),
            },
            {
                title: "下载",
                icon: "download",
                onClick: () => showDownloadPanel([musicItem]),
            },
        ];

        if (onRemove) {
            items.push({
                title: "从歌单中移除",
                icon: "close",
                danger: true,
                onClick: () => onRemove(musicItem),
            });
        }

        if (musicItem.album) {
            items.push({
                title: "查看专辑",
                icon: "musicNote",
                onClick: () =>
                    navigate("albumDetail", { albumItem: musicItem as any }),
            });
        }
        if (musicItem.localPath) {
            items.push({
                title: "复制文件路径",
                icon: "localMusic",
                onClick: () => {
                    navigator.clipboard.writeText(musicItem.localPath!);
                    showToast("已复制文件路径");
                },
            });
        }
        showContextMenu(e.clientX, e.clientY, items);
    };

    const renderDownloadAction = (musicItem: IMusic.IMusicItem) => {
        const dl = downloadStatusMap[musicKey(musicItem)];
        if (dl?.status === "completed") {
            return (
                <span
                    className="music-action-btn done"
                    title="已下载，点击打开所在文件夹"
                    onClick={(e) => {
                        e.stopPropagation();
                        openDownloadInFolder(dl.taskId);
                    }}
                >
                    <Icon name="check" size={15} />
                </span>
            );
        }
        if (dl?.status === "pending" || dl?.status === "running") {
            return (
                <span className="music-action-btn downloading" title="下载中">
                    <Icon name="download" size={15} />
                </span>
            );
        }
        return (
            <span
                className="music-action-btn"
                title="下载"
                onClick={(e) => {
                    e.stopPropagation();
                    showDownloadPanel([musicItem]);
                }}
            >
                <Icon name="download" size={15} />
            </span>
        );
    };

    return (
        <div className={`music-list ${selectable ? "selectable" : ""} ${className ?? ""}`}>
            <div className="music-list-header">
                {selectable && (
                    <div
                        className={`music-row-check header-check${allSelected ? " checked" : ""}`}
                        title={allSelected ? "取消全选" : "全选"}
                        onClick={toggleSelectAll}
                    >
                        {allSelected && <Icon name="check" size={11} />}
                    </div>
                )}
                <div style={{ textAlign: "center" }}>#</div>
                <div>标题</div>
                <div>歌手</div>
                <div>专辑</div>
                <div style={{ textAlign: "right" }}>操作 / 时长</div>
            </div>
            {musicList.map((musicItem, index) => {
                const playing = TrackPlayerSingleton.isCurrentMusic(musicItem);
                const k = keyOf(musicItem, index);
                const checked = selectable && selectedKeys.has(k);
                const liked = likedKeys.has(k);
                return (
                    <div
                        key={`${k}-${index}`}
                        className={`music-row${playing ? " playing" : ""}${checked ? " selected" : ""}`}
                        onDoubleClick={() => TrackPlayerSingleton.play(musicItem, true)}
                        onClick={() => TrackPlayerSingleton.play(musicItem)}
                        onContextMenu={(e) => openMenu(e, musicItem)}
                    >
                        {selectable && (
                            <div
                                className={`music-row-check${checked ? " checked" : ""}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    toggleSelect(musicItem);
                                }}
                            >
                                {checked && <Icon name="check" size={11} />}
                            </div>
                        )}
                        <div className="music-row-index">
                            {playing ? (
                                <Icon name="musicNote" size={14} style={{ color: "var(--primary-color)" }} />
                            ) : (
                                index + 1
                            )}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                            <Cover src={musicItem.artwork} size={32} borderRadius={4} />
                            <span className="music-row-title">
                                {musicItem.title}
                                {musicItem.alias && (
                                    <span className="music-row-alias">（{musicItem.alias}）</span>
                                )}
                            </span>
                        </div>
                        <div className="music-row-artist">{musicItem.artist}</div>
                        <div className="music-row-album">{musicItem.album}</div>
                        <div className="music-row-actions">
                            <span
                                className={`music-action-btn like${liked ? " liked" : ""}`}
                                title={liked ? "取消喜欢" : "喜欢"}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleToggleLike(musicItem);
                                }}
                            >
                                <Icon name={liked ? "heartFilled" : "heart"} size={15} />
                            </span>
                            {renderDownloadAction(musicItem)}
                            <span className="music-row-duration">
                                {formatDuration(musicItem.duration)}
                            </span>
                        </div>
                    </div>
                );
            })}
            {loading && <div className="loading-hint">加载中…</div>}
            {!loading && !isEnd && onLoadMore && (
                <div
                    className="loading-hint"
                    style={{ cursor: "pointer" }}
                    onClick={onLoadMore}
                >
                    加载更多
                </div>
            )}
            {!loading && !musicList.length && (
                <div className="empty-hint">这里空空如也</div>
            )}
            {selectable && selectedKeys.size > 0 && (
                <div className="music-selection-bar">
                    <span className="music-selection-count">
                        已选 {selectedKeys.size} 首
                    </span>
                    <button className="btn-ghost" onClick={toggleSelectAll}>
                        {allSelected ? "取消全选" : "全选"}
                    </button>
                    <button className="btn-ghost" onClick={downloadSelected}>
                        <Icon name="download" size={14} />
                        下载
                    </button>
                    <button className="btn-ghost" onClick={() => likeSelected(true)}>
                        <Icon name="heartFilled" size={14} />
                        收藏
                    </button>
                    <button className="btn-ghost" onClick={() => likeSelected(false)}>
                        <Icon name="heart" size={14} />
                        取消收藏
                    </button>
                    <button className="btn-ghost" onClick={clearSelection}>
                        <Icon name="close" size={13} />
                        取消
                    </button>
                </div>
            )}
        </div>
    );
}
