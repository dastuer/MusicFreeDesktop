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
import { ipcInvoke } from "@/core/ipc";
import { showToast } from "./Toast";

/**
 * 歌曲列表（桌面端表格形态）：多选框 / 序号 / 封面+标题 / 歌手 / 专辑 / 操作+时长
 * 支持单击播放、双击播放、右键菜单、多选批量下载/收藏
 */

/** 首屏渲染行数 / 每次追加行数 */
const INITIAL_ROWS = 150;
const ROWS_PER_STEP = 150;

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
    /** 本地音乐模式：行内显示「在访达中打开/删除」，多选操作栏用删除替代下载 */
    localMode?: boolean;
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
        localMode = false,
        onRemove,
        onMusicChanged,
    } = props;
    const currentMusic = useCurrentMusic();
    const likesVersion = useAtomValue(likesVersionAtom);
    const downloadTasks = useAtomValue(downloadTasksAtom);
    useDownloadSetup();

    const [likedKeys, setLikedKeys] = useState<Set<string>>(new Set());
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
    /** 多选模式：默认关闭，进入后才显示选择框 */
    const [selectMode, setSelectMode] = useState(false);
    /**
     * 分片渲染：本地音乐动辄上千首，一次性铺满 DOM 会让切页卡住。
     * 首屏只渲染前 150 行，滚到底部哨兵再追加 150 行。
     * （不做真正的窗口化，是为了不引入滚动高度/吸顶表头错位的问题）
     */
    const [visibleCount, setVisibleCount] = useState(INITIAL_ROWS);
    const sentinelRef = React.useRef<HTMLDivElement | null>(null);

    // 换了列表就回到首屏行数（按长度判断，避免父组件每次渲染传新数组导致反复重置）
    useEffect(() => {
        setVisibleCount(INITIAL_ROWS);
    }, [musicList.length]);

    // 哨兵进入视口 → 追加一批
    useEffect(() => {
        const el = sentinelRef.current;
        if (!el) {
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setVisibleCount((count) => count + ROWS_PER_STEP);
                }
            },
            // 提前 600px 触发，滚动时感觉不到分批
            { rootMargin: "600px 0px" },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [visibleCount, musicList.length]);

    const visibleList =
        musicList.length > visibleCount ? musicList.slice(0, visibleCount) : musicList;

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

    const exitSelectMode = () => {
        clearSelection();
        setSelectMode(false);
    };

    const downloadSelected = () => {
        if (!selectedItems.length) {
            showToast("请先选择歌曲");
            return;
        }
        showDownloadPanel(selectedItems);
        clearSelection();
    };

    const likeSelected = async (like: boolean) => {
        if (!selectedItems.length) {
            showToast("请先选择歌曲");
            return;
        }
        await batchSetLike(selectedItems, like);
        showToast(like ? `已收藏 ${selectedItems.length} 首歌曲` : `已取消收藏 ${selectedItems.length} 首歌曲`);
        clearSelection();
        onMusicChanged?.();
    };

    const openInFinder = (musicItem: IMusic.IMusicItem) => {
        if (!musicItem.localPath) {
            showToast("该歌曲没有本地文件");
            return;
        }
        ipcInvoke("localMusic:openInFinder", musicItem.localPath);
    };

    const deleteLocalMusic = async (items: IMusic.IMusicItem[]) => {
        const paths = items.map((it) => it.localPath).filter(Boolean);
        if (!paths.length) {
            showToast("没有可删除的本地文件");
            return;
        }
        // 正在播放/在播放队列中的歌曲先清理播放状态，避免删除后播放异常
        for (const it of items) {
            if (TrackPlayerSingleton.isCurrentMusic(it)) {
                await TrackPlayerSingleton.clearPlayList();
            } else {
                await TrackPlayerSingleton.remove(it);
            }
        }
        const result = await ipcInvoke("localMusic:delete", paths);
        if (result?.success) {
            showToast(`已删除 ${result.data ?? paths.length} 首本地音乐`);
            clearSelection();
            onMusicChanged?.();
        } else if (!result?.canceled) {
            showToast(`删除失败：${result?.message ?? "未知错误"}`);
        }
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
        ];

        if (localMode) {
            items.push(
                {
                    title: "在访达中打开",
                    icon: "open",
                    onClick: () => openInFinder(musicItem),
                },
                {
                    title: "删除音乐",
                    icon: "trash",
                    danger: true,
                    onClick: () => deleteLocalMusic([musicItem]),
                },
            );
        } else {
            items.push({
                title: "下载",
                icon: "download",
                onClick: () => showDownloadPanel([musicItem]),
            });
        }

        if (onRemove) {
            items.push({
                title: "从歌单中移除",
                icon: "close",
                danger: true,
                onClick: () => onRemove(musicItem),
            });
        }

        if (!localMode && musicItem.album) {
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
        if (localMode) {
            return null;
        }
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
        <div className={`music-list ${selectable && selectMode ? "selecting" : ""} ${className ?? ""}`}>
            {selectable && (
                <div className="music-list-toolbar">
                    <button
                        className="btn-ghost"
                        onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
                    >
                        <Icon name={selectMode ? "close" : "check"} size={13} />
                        {selectMode ? "退出多选" : "多选"}
                    </button>
                </div>
            )}
            <div className="music-list-header">
                {selectable && selectMode && (
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
            {visibleList.map((musicItem, index) => {
                const playing = TrackPlayerSingleton.isCurrentMusic(musicItem);
                const k = keyOf(musicItem, index);
                const checked = selectMode && selectedKeys.has(k);
                const liked = likedKeys.has(k);
                return (
                    <div
                        key={`${k}-${index}`}
                        className={`music-row${playing ? " playing" : ""}`}
                        onDoubleClick={() => TrackPlayerSingleton.play(musicItem, true)}
                        onClick={() => TrackPlayerSingleton.play(musicItem)}
                        onContextMenu={(e) => openMenu(e, musicItem)}
                    >
                        {selectMode && (
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
                            {localMode ? (
                                <>
                                    <span
                                        className="music-action-btn"
                                        title="在访达中打开"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            openInFinder(musicItem);
                                        }}
                                    >
                                        <Icon name="open" size={15} />
                                    </span>
                                    <span
                                        className="music-action-btn danger"
                                        title="删除音乐"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            deleteLocalMusic([musicItem]);
                                        }}
                                    >
                                        <Icon name="trash" size={15} />
                                    </span>
                                </>
                            ) : (
                                renderDownloadAction(musicItem)
                            )}
                            <span className="music-row-duration">
                                {formatDuration(musicItem.duration)}
                            </span>
                        </div>
                    </div>
                );
            })}
            {visibleCount < musicList.length && (
                <div ref={sentinelRef} className="music-list-sentinel" />
            )}
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
            {selectable && selectMode && (
                <div className="music-selection-bar">
                    <span className="music-selection-count">
                        已选 {selectedKeys.size} 首
                    </span>
                    <button className="btn-ghost" onClick={toggleSelectAll}>
                        {allSelected ? "取消全选" : "全选"}
                    </button>
                    {localMode ? (
                        <button className="btn-ghost danger" onClick={() => deleteLocalMusic(selectedItems)}>
                            <Icon name="trash" size={14} />
                            删除
                        </button>
                    ) : (
                        <button className="btn-ghost" onClick={downloadSelected}>
                            <Icon name="download" size={14} />
                            下载
                        </button>
                    )}
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
                        清除选择
                    </button>
                    <button className="btn-primary" onClick={exitSelectMode}>
                        完成
                    </button>
                </div>
            )}
        </div>
    );
}
