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
 * 支持单击播放（整个列表换进播放列表）、右键菜单、多选批量下载/收藏
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

/** 分页器里的一项：页码 / 中间省略 / 末尾还有更多 */
type PageItem = number | "gap" | "more";

/**
 * 页码列表：页数不多就全列出来，多则只给「首页 + 当前页附近 + 末页」。
 * `hasMore` 表示音源还有更多页（总数未知时用），末尾补一个省略号。
 */
function buildPageItems(current: number, total: number, hasMore: boolean): PageItem[] {
    const items: PageItem[] = [];
    if (total <= 7) {
        for (let p = 1; p <= total; p++) {
            items.push(p);
        }
    } else {
        items.push(1);
        const from = Math.max(2, current - 1);
        const to = Math.min(total - 1, current + 1);
        if (from > 2) {
            items.push("gap");
        }
        for (let p = from; p <= to; p++) {
            items.push(p);
        }
        if (to < total - 1) {
            items.push("gap");
        }
        items.push(total);
    }
    if (hasMore) {
        items.push("more");
    }
    return items;
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
    /**
     * 当前列表是「我的歌单」内容（用户歌单 / 我喜欢的音乐）。
     * 只有在这里才提供「取消收藏」——它对应「把选中的歌从当前歌单里拿掉」；
     * 插件歌单 / 专辑 / 排行榜 / 搜索这些来源列表里的歌本来就不在自己的歌单里，批量取消没有意义。
     */
    userSheetMode?: boolean;
    /** 当前列表所属歌单的 id：收藏到歌单时把当前歌单从候选里去掉 */
    currentSheetId?: string;
    /** 传入后在右键菜单中出现「从歌单中移除」 */
    onRemove?: (musicItem: IMusic.IMusicItem) => void;
    /** 批量从当前歌单移除（userSheetMode 下「取消收藏」用它，缺省退回取消喜欢） */
    onRemoveMany?: (musicItems: IMusic.IMusicItem[]) => void | Promise<void>;
    /** 喜欢/移除等操作后的回调（页面刷新用） */
    onMusicChanged?: () => void;
    /**
     * 传入即启用「每页 N 条」分页模式：只渲染当前页，底部换成页码分页器。
     * 不传时保持老行为（首屏 150 行的分片渲染 + 手动「加载更多」）。
     */
    pagination?: IMusicListPagination;
    /**
     * 这份列表的稳定标识（歌单 / 专辑 / 榜单 / 本地音乐…各给各的）。
     * 点行播放时带进播放队列，队列已经是这份列表就不再重复整队替换、也不重复提示。
     * 不传则每次点都重新整队替换。
     */
    listId?: string;
}

export interface IMusicListPagination {
    currentPage: number;
    totalPages: number;
    pageSize: number;
    pageSizeOptions: number[];
    /** 音源还有更多，下一页可能还要联网拉 */
    hasMore: boolean;
    /** 只是拉不到新数据而停下（不是音源说没有），此时不能宣称「共 N 首」 */
    stalled?: boolean;
    loadingMore: boolean;
    /**
     * 音源声明的总条数（歌单侧是 `sheetItem.worksNum`）。
     * 插件协议里搜索返回**没有**总数字段，此时传 undefined：
     * 页数显示成 `1 / 2+`（+ 表示后面还有），条数显示成「已加载 N 首」而不是假的「共 N 首」。
     */
    expectedTotal?: number;
    onPageChange: (page: number) => void;
    onPageSizeChange: (size: number) => void;
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
        userSheetMode = false,
        currentSheetId,
        onRemove,
        onRemoveMany,
        onMusicChanged,
        pagination,
        listId,
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

    /**
     * 分页模式：只把当前页交给渲染，序号仍按全量列表连续编号。
     * 此时不走 visibleCount 分片（一页最多 200 行，不需要再切）。
     */
    const pageStart = pagination ? (pagination.currentPage - 1) * pagination.pageSize : 0;
    const rowList = pagination
        ? musicList.slice(pageStart, pageStart + pagination.pageSize)
        : visibleList;
    const rowOffset = pagination ? pageStart : 0;

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

    /**
     * 「全选」的作用范围：分页模式下只作用于当前页。
     * 否则在第 1 页点全选会连带把后面几十页没看见的歌一起选中，批量下载/删除容易出事。
     * 手选不受影响——已选集合是跨页保留的。
     */
    const selectableList = pagination ? rowList : musicList;
    const allSelected =
        selectableList.length > 0 &&
        selectableList.every((it) => selectedKeys.has(musicKey(it)));

    const toggleSelectAll = () => {
        setSelectedKeys((prev) => {
            const next = new Set(prev);
            selectableList.forEach((it) => {
                const k = musicKey(it);
                if (allSelected) {
                    next.delete(k);
                } else {
                    next.add(k);
                }
            });
            return next;
        });
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

    /**
     * 多选「收藏」：不直接塞进我喜欢的音乐，而是弹出歌单选择面板，
     * 由用户决定收藏到哪个歌单。「我喜欢的音乐」在名单首位，点一下就是原来的红心收藏。
     */
    const collectSelected = () => {
        if (!selectedItems.length) {
            showToast("请先选择歌曲");
            return;
        }
        showAddToSheetPanel(selectedItems, {
            excludeSheetId: currentSheetId,
            onDone: () => {
                clearSelection();
                onMusicChanged?.();
            },
        });
    };

    /**
     * 多选「取消收藏」：在我的歌单里 = 从当前歌单移除；
     * 没给 onRemoveMany 时退回原来的「取消喜欢」。
     */
    const removeSelected = async () => {
        if (!selectedItems.length) {
            showToast("请先选择歌曲");
            return;
        }
        if (onRemoveMany) {
            await onRemoveMany(selectedItems);
            clearSelection();
            return;
        }
        await batchSetLike(selectedItems, false);
        showToast(`已取消收藏 ${selectedItems.length} 首歌曲`);
        clearSelection();
        onMusicChanged?.();
    };

    /**
     * 多选批量追加到当前播放列表（TrackPlayer.add 支持数组，已在队列里的不会重复塞）。
     * 一次操作只出一条反馈，图标提示优先：有歌进队列时歌单入口图标已经提示过了，
     * 这里只在「一首都没进」（图标不会提示）时说一声。
     */
    const addSelectedToPlayList = () => {
        if (!selectedItems.length) {
            showToast("请先选择歌曲");
            return;
        }
        if (!TrackPlayerSingleton.add(selectedItems)) {
            showToast("这些歌曲都已经在播放列表里了");
        }
        clearSelection();
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
                await TrackPlayerSingleton.clearPlayListAndStop();
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
                // 反馈走歌单入口图标上那条提示，不再叠一条顶部 toast
                onClick: () => TrackPlayerSingleton.addNext(musicItem),
            },
            {
                title: "添加到播放列表",
                icon: "plus",
                onClick: () => {
                    // 真进了队列就不弹顶部 toast：歌单入口图标上已经提示「已添加到歌单列表」。
                    // 只有被去重、图标不会提示的情况才在这里说。
                    if (!TrackPlayerSingleton.add(musicItem)) {
                        showToast("这首歌已经在播放列表里了");
                    }
                },
            },
            {
                title: "收藏到歌单",
                icon: "playQueue",
                onClick: () =>
                    showAddToSheetPanel(musicItem, {
                        excludeSheetId: currentSheetId,
                        onDone: onMusicChanged,
                    }),
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
                        title={
                            pagination
                                ? allSelected
                                    ? "取消全选本页"
                                    : "全选本页"
                                : allSelected
                                  ? "取消全选"
                                  : "全选"
                        }
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
            {rowList.map((musicItem, index) => {
                const playing = TrackPlayerSingleton.isCurrentMusic(musicItem);
                const rowIndex = rowOffset + index;
                const k = keyOf(musicItem, rowIndex);
                const checked = selectMode && selectedKeys.has(k);
                const liked = likedKeys.has(k);
                return (
                    <div
                        key={`${k}-${rowIndex}`}
                        className={`music-row${playing ? " playing" : ""}`}
                        onClick={() =>
                            TrackPlayerSingleton.playWithReplacePlayList(
                                musicItem,
                                musicList,
                                listId,
                            )
                        }
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
                                rowIndex + 1
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
            {!pagination && visibleCount < musicList.length && (
                <div ref={sentinelRef} className="music-list-sentinel" />
            )}
            {!pagination && loading && <div className="loading-hint">加载中…</div>}
            {!pagination && !loading && !isEnd && onLoadMore && (
                <div
                    className="loading-hint"
                    style={{ cursor: "pointer" }}
                    onClick={onLoadMore}
                >
                    加载更多
                </div>
            )}
            {pagination && musicList.length > 0 && (
                <div className="music-pager">
                    <div className="music-pager-info">
                        <span className="music-pager-count">
                            {pagination.expectedTotal && pagination.expectedTotal > 0
                                ? `共 ${pagination.expectedTotal} 首`
                                : pagination.hasMore || pagination.stalled
                                  ? // 还有更多、或只是拉不动了：手上这些不一定是全部
                                    `已加载 ${musicList.length} 首`
                                  : `共 ${musicList.length} 首`}
                        </span>
                        <span className="music-pager-dot" />
                        <label className="music-pager-size">
                            <span>每页</span>
                            {/* appearance:none 之后原生箭头会消失，自己补一个 */}
                            <span className="music-pager-select-wrap">
                                <select
                                    className="music-pager-select"
                                    value={pagination.pageSize}
                                    onChange={(e) =>
                                        pagination.onPageSizeChange(Number(e.target.value))
                                    }
                                >
                                    {pagination.pageSizeOptions.map((n) => (
                                        <option key={n} value={n} style={{ color: "#333" }}>
                                            {n}
                                        </option>
                                    ))}
                                </select>
                                <span className="music-pager-caret" aria-hidden />
                            </span>
                            <span>条</span>
                        </label>
                        {pagination.loadingMore && (
                            <span className="music-pager-loading">加载中…</span>
                        )}
                    </div>
                    <div className="music-pager-nav">
                        <button
                            className="pager-btn pager-step"
                            disabled={pagination.currentPage <= 1 || pagination.loadingMore}
                            onClick={(e) => {
                                e.stopPropagation();
                                pagination.onPageChange(pagination.currentPage - 1);
                            }}
                        >
                            <Icon name="back" size={12} />
                            上一页
                        </button>
                        {buildPageItems(
                            pagination.currentPage,
                            pagination.totalPages,
                            pagination.hasMore &&
                                (!pagination.expectedTotal || pagination.expectedTotal <= 0),
                        ).map((item, i) =>
                            item === "gap" ? (
                                <span className="pager-gap" key={`gap-${i}`}>
                                    …
                                </span>
                            ) : item === "more" ? (
                                <span
                                    className="pager-gap"
                                    key="more"
                                    title="还有更多，点「下一页」继续加载"
                                >
                                    …
                                </span>
                            ) : (
                                <button
                                    key={item}
                                    className={`pager-btn pager-num${
                                        item === pagination.currentPage ? " active" : ""
                                    }`}
                                    disabled={pagination.loadingMore}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        pagination.onPageChange(item);
                                    }}
                                >
                                    {item}
                                </button>
                            ),
                        )}
                        <button
                            className="pager-btn pager-step"
                            disabled={
                                pagination.loadingMore ||
                                (pagination.currentPage >= pagination.totalPages &&
                                    !pagination.hasMore)
                            }
                            onClick={(e) => {
                                e.stopPropagation();
                                pagination.onPageChange(pagination.currentPage + 1);
                            }}
                        >
                            下一页
                            <Icon name="forward" size={12} />
                        </button>
                    </div>
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
                        {allSelected
                            ? pagination
                                ? "取消全选本页"
                                : "取消全选"
                            : pagination
                              ? "全选本页"
                              : "全选"}
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
                    <button className="btn-ghost" onClick={collectSelected}>
                        <Icon name="heartFilled" size={14} />
                        收藏
                    </button>
                    {userSheetMode && (
                        <button className="btn-ghost" onClick={removeSelected}>
                            <Icon name="heart" size={14} />
                            取消收藏
                        </button>
                    )}
                    <button className="btn-ghost" onClick={addSelectedToPlayList}>
                        <Icon name="plus" size={14} />
                        添加到播放列表
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
