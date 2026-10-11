import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { navigateToArtist } from "@/utils/artistNav";
import { showToast } from "./Toast";
import { useListSearch } from "@/hooks/useListSearch";
import type { TSheetFixMode } from "@/core/sheetSourceFix";

/**
 * 歌曲列表（桌面端表格形态）：多选框 / 序号 / 封面+歌名+歌手两行主列 / 专辑 / 操作+时长
 * 支持单击播放（整个列表换进播放列表）、右键菜单、多选批量下载/收藏；
 * 数据统一走无限滚动：滚到底部（提前 600px）自动向数据源续拉，尾部展示加载中。
 */

/** 首屏渲染行数 / 每次追加行数 */
const INITIAL_ROWS = 150;
const ROWS_PER_STEP = 150;

/** 骨架屏占位行的宽度模式：逐行变化比整齐划一更像真实列表 */
const SKELETON_WIDTHS = [
    { title: "62%", sub: "34%", album: "72%" },
    { title: "78%", sub: "44%", album: "52%" },
    { title: "46%", sub: "28%", album: "64%" },
    { title: "70%", sub: "38%", album: "78%" },
    { title: "54%", sub: "30%", album: "46%" },
    { title: "84%", sub: "46%", album: "66%" },
    { title: "50%", sub: "32%", album: "56%" },
    { title: "66%", sub: "36%", album: "74%" },
];

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
    /** 列表数据；纯骨架占位（loading 且无数据）时可省略 */
    musicList?: IMusic.IMusicItem[];
    /** 是否显示封面列（网格行样式） */
    showIndex?: boolean;
    /** 滚动到底部（提前 600px）时自动调用，向数据源续拉下一批 */
    onLoadMore?: () => void;
    /** 没有更多了：停止续拉，并在尾部显示「没有更多了」 */
    isEnd?: boolean;
    /** 续拉被「卡住」：插件原地踏步或连续失败熔断。显示手动重试入口 */
    stalled?: boolean;
    /** stalled 时点击重试（不传则按「没有更多了」收尾） */
    onRetry?: () => void;
    /** 首屏 / 重置加载（配合骨架屏） */
    loading?: boolean;
    /** 骨架屏占位行数（默认 8）：匹配等已知曲目总数的场景传入，让骨架高度贴近最终列表 */
    skeletonRows?: number;
    /** 追加加载中：列表尾部显示转圈 +「加载中…」 */
    loadingMore?: boolean;
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
     * 另外「我的歌单」里的歌是从各个音源搜索收藏进来的、来源不统一，标题后会挂音源标识徽标；
     * 插件歌单 / 专辑 / 榜单整份列表同源，不需要标。
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
     * 音源管理入口（「我的歌单」详情页传入）：
     *  - 右键单首时以 [musicItem] 调用，多选工具条以选中集合调用；
     *  - mode: repair 修复音源（探测失效的才配）/ rematch 重新匹配（全部重配）/
     *    replacer 替换音源（指定一个音源查找并替换）。
     * 传入后右键菜单与多选工具条才展示这些入口。
     */
    onSourceFix?: (mode: TSheetFixMode, musicItems: IMusic.IMusicItem[]) => void;
    /**
     * 这份列表的稳定标识（歌单 / 专辑 / 榜单 / 本地音乐…各给各的）。
     * 点行播放时带进播放队列，队列已经是这份列表就不再重复整队替换、也不重复提示。
     * 不传则每次点都重新整队替换。
     */
    listId?: string;
    /** 在工具条上显示搜索框：按标题 / 歌手 / 专辑过滤已加载的歌曲 */
    searchable?: boolean;
    /**
     * 多选模式受控：传入 `onSelectModeChange` 后，工具条不再显示「多选」按钮，
     * 入口交给外部（如头部「更多」菜单），开关状态由页面持有。
     */
    selectMode?: boolean;
    onSelectModeChange?: (selectMode: boolean) => void;
}

export default function MusicList(props: IMusicListProps) {
    const {
        musicList = [],
        onLoadMore,
        isEnd = true,
        stalled = false,
        onRetry,
        loading = false,
        loadingMore = false,
        skeletonRows,
        className,
        selectable = true,
        localMode = false,
        userSheetMode = false,
        currentSheetId,
        onRemove,
        onRemoveMany,
        onMusicChanged,
        onSourceFix,
        listId,
        searchable = false,
        selectMode: selectModeProp,
        onSelectModeChange,
    } = props;
    const currentMusic = useCurrentMusic();
    const likesVersion = useAtomValue(likesVersionAtom);
    const downloadTasks = useAtomValue(downloadTasksAtom);
    useDownloadSetup();

    const [likedKeys, setLikedKeys] = useState<Set<string>>(new Set());
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
    /** 多选模式：默认关闭，进入后才显示选择框。外部受控时以 props 为准 */
    const [internalSelectMode, setInternalSelectMode] = useState(false);
    const selectModeControlled = onSelectModeChange != null;
    const selectMode = selectModeControlled ? !!selectModeProp : internalSelectMode;
    const changeSelectMode = (next: boolean) => {
        if (selectModeControlled) {
            onSelectModeChange!(next);
        } else {
            setInternalSelectMode(next);
        }
    };
    /**
     * 搜索关键词：按标题 / 歌手 / 专辑过滤当前已加载的歌曲。
     * 输入法拼写（拼音合成）过程中不更新，等候选上屏（compositionEnd）才触发搜索。
     */
    const {
        keyword: searchKeyword,
        appliedKeyword,
        trimmedKeyword,
        isSearching,
        filteredList,
        handleInput: handleSearchInput,
        handleComposition: handleSearchComposition,
        clear: clearSearch,
    } = useListSearch(musicList);
    /**
     * 分片渲染：本地音乐动辄上千首，一次性铺满 DOM 会让切页卡住。
     * 首屏只渲染前 150 行，滚到底部哨兵再追加 150 行。
     * （不做真正的窗口化，是为了不引入滚动高度/吸顶表头错位的问题）
     */
    const [visibleCount, setVisibleCount] = useState(INITIAL_ROWS);
    const sentinelRef = React.useRef<HTMLDivElement | null>(null);
    const loadSentinelRef = React.useRef<HTMLDivElement | null>(null);

    // 换搜索词回到首屏行数。分片渲染的重置只在「列表变短」（重置/清空后重来）时执行：
    // 无限滚动是往尾部追加，若按 length 变化无脑回 150，会把用户已滚出的行塌回去，
    // 内容高度骤减、加载哨兵立刻又进视口 -> 连环触发。按上一次长度判断增删。
    const prevLengthRef = React.useRef(musicList.length);
    useEffect(() => {
        const prev = prevLengthRef.current;
        prevLengthRef.current = musicList.length;
        if (musicList.length >= prev) {
            return;
        }
        setVisibleCount(INITIAL_ROWS);
    }, [musicList.length]);
    useEffect(() => {
        setVisibleCount(INITIAL_ROWS);
    }, [appliedKeyword]);

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
    /** 搜索时在过滤结果里分片渲染；平时渲染已加载条目的前 visibleCount 行 */
    const rowList = isSearching ? filteredList.slice(0, visibleCount) : visibleList;

    /**
     * 骨架屏：有加载在跑、但当前一行都渲染不出来时顶上——
     * 首屏加载（loading）和续拉数据未到（loadingMore 且列表为空）都算。
     * 已有内容时的追加加载仍走底部「加载中…」提示，不闪骨架。
     */
    const showSkeleton =
        !isSearching && rowList.length === 0 && (loading || loadingMore);

    /**
     * 骨架行数：默认 8 行；传入 skeletonRows 时按预期行数撑起骨架，
     * 但不超过真实渲染的分片上限（visibleCount）——否则长列表完成后
     * 行数从骨架回落，反而造成跳动。
     */
    const skeletonCount = Math.min(
        skeletonRows ?? SKELETON_WIDTHS.length,
        visibleCount,
    );

    /**
     * 无限滚动：数据哨兵进入视口 → 向数据源续拉。
     * 只在「空闲、还没有到底/卡住、已加载的行全部渲染完」时挂载——加载中撤掉哨兵，
     * 一轮结束重新挂载时 IntersectionObserver 的初始检测会接着触发：
     * 内容不满一屏就自动续拉直到铺满视口或到底，也不会并发重复请求。
     */
    const allRowsRendered = visibleCount >= musicList.length;
    const canAutoLoad =
        !isSearching &&
        !!onLoadMore &&
        !loading &&
        !loadingMore &&
        !isEnd &&
        !stalled &&
        allRowsRendered;
    useEffect(() => {
        const el = loadSentinelRef.current;
        if (!el) {
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    onLoadMore?.();
                }
            },
            // 与分片哨兵同口径：提前 600px 开始拉，滚到真正底部时数据通常已就位
            { rootMargin: "600px 0px" },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [canAutoLoad, onLoadMore, visibleCount, musicList.length]);

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
     * 「全选」的作用范围：搜索时作用于过滤结果里已渲染的行，平时是整份列表。
     * 手选不受影响——已选集合是跨页保留的。
     */
    const selectableList = isSearching ? rowList : musicList;
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
        changeSelectMode(false);
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

    /** 多选批量音源管理：交给详情页弹音源选择 + 对比确认弹窗 */
    const runSourceFix = (mode: TSheetFixMode) => {
        if (!selectedItems.length) {
            showToast("请先选择歌曲");
            return;
        }
        onSourceFix?.(mode, selectedItems);
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

        // 「我的歌单」里的音源管理：单首修复 / 重配 / 替换音源（详情页传入口才显示）
        if (userSheetMode && onSourceFix) {
            items.push(
                {
                    title: "重新匹配音乐",
                    icon: "refresh",
                    onClick: () => onSourceFix("rematch", [musicItem]),
                },
                {
                    title: "替换音源",
                    icon: "forward",
                    onClick: () => onSourceFix("replacer", [musicItem]),
                },
                {
                    title: "修复音源",
                    icon: "plugin",
                    onClick: () => onSourceFix("repair", [musicItem]),
                },
            );
        }

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
        if (!localMode && musicItem.artist) {
            items.push({
                title: "查看歌手",
                icon: "search",
                onClick: () => void navigateToArtist(musicItem),
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
                    {searchable && (
                        <div className="music-search-box">
                            <Icon name="search" size={14} />
                            <input
                                value={searchKeyword}
                                onChange={(e) => handleSearchInput(e.target.value)}
                                onCompositionStart={(e) =>
                                    handleSearchComposition(e.currentTarget.value, true)
                                }
                                onCompositionEnd={(e) =>
                                    handleSearchComposition(e.currentTarget.value, false)
                                }
                                placeholder="搜索"
                            />
                            {searchKeyword && (
                                <span
                                    className="music-search-clear"
                                    title="清除搜索"
                                    onClick={clearSearch}
                                >
                                    <Icon name="close" size={12} />
                                </span>
                            )}
                        </div>
                    )}
                    {/* 多选入口统一收进页面头部的「…」更多菜单（selectModeControlled 页面自己控制显隐） */}
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
                <div>专辑</div>
                <div style={{ textAlign: "right" }}>操作 / 时长</div>
            </div>
            {rowList.map((musicItem, index) => {
                const playing = TrackPlayerSingleton.isCurrentMusic(musicItem);
                const rowIndex = index;
                const k = keyOf(musicItem, rowIndex);
                const checked = selectMode && selectedKeys.has(k);
                return (
                    <div
                        key={`${k}-${rowIndex}`}
                        className={`music-row${playing ? " playing" : ""}`}
                        onClick={() =>
                            TrackPlayerSingleton.playWithReplacePlayList(
                                musicItem,
                                isSearching ? filteredList : musicList,
                                // 搜索结果和整份列表不是同一份内容，此时不带 listId，避免复用判断拿着旧队列
                                isSearching ? "" : listId,
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
                        <div className="music-row-main">
                            <Cover src={musicItem.artwork} size={40} borderRadius={5} />
                            <div className="music-row-info">
                                <span className="music-row-title">
                                    {musicItem.title}
                                    {musicItem.alias && (
                                        <span className="music-row-alias">（{musicItem.alias}）</span>
                                    )}
                                </span>
                                <div className="music-row-sub">
                                    {userSheetMode && musicItem.platform && (
                                        <span
                                            className="music-row-source"
                                            title={`来源音源：${musicItem.platform}`}
                                        >
                                            {musicItem.platform}
                                        </span>
                                    )}
                                    {/* 歌手可点：本地文件没有对应音源，navigateToArtist 会退回任意搜索音源 */}
                                    <span
                                        className="music-row-artist clickable"
                                        title="查看歌手"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            void navigateToArtist(musicItem);
                                        }}
                                    >
                                        {musicItem.artist}
                                    </span>
                                </div>
                            </div>
                        </div>
                        {/* 专辑列可点进专辑详情（与右键「查看专辑」同一跳转口径） */}
                        <div
                            className={`music-row-album${
                                !localMode && musicItem.album ? " clickable" : ""
                            }`}
                            title={!localMode && musicItem.album ? "查看专辑" : undefined}
                            onClick={
                                !localMode && musicItem.album
                                    ? (e) => {
                                          e.stopPropagation();
                                          navigate("albumDetail", { albumItem: musicItem as any });
                                      }
                                    : undefined
                            }
                        >
                            {musicItem.album}
                        </div>
                        <div className="music-row-actions">
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
            {showSkeleton && (
                <div className="music-skeleton" aria-hidden>
                    {Array.from(
                        { length: skeletonCount },
                        (_, i) => SKELETON_WIDTHS[i % SKELETON_WIDTHS.length],
                    ).map((w, i) => (
                        <div className="music-skeleton-row" key={i}>
                            <div className="music-skeleton-bar music-skeleton-index" />
                            <div className="music-skeleton-main">
                                <div className="music-skeleton-cover" />
                                <div className="music-skeleton-lines">
                                    <div
                                        className="music-skeleton-bar"
                                        style={{ width: w.title }}
                                    />
                                    <div
                                        className="music-skeleton-bar"
                                        style={{ width: w.sub }}
                                    />
                                </div>
                            </div>
                            <div
                                className="music-skeleton-bar"
                                style={{ width: w.album }}
                            />
                            <div className="music-skeleton-bar music-skeleton-actions" />
                        </div>
                    ))}
                </div>
            )}
            {visibleCount < (isSearching ? filteredList.length : musicList.length) && (
                <div ref={sentinelRef} className="music-list-sentinel" />
            )}
            {/* 无限滚动数据哨兵：已加载行全部渲染完、且还能续拉时挂在尾部，进视口即触发续拉 */}
            {canAutoLoad && <div ref={loadSentinelRef} className="music-list-sentinel" />}
            {/* 加载中（续拉，或首屏后仍有内容的加载）：转圈 + 文案 */}
            {(loadingMore || (loading && rowList.length > 0)) && (
                <div className="loading-hint music-list-loading">
                    <span className="music-list-spinner" aria-hidden />
                    加载中…
                </div>
            )}
            {/* 续拉被卡住（插件原地踏步 / 连续失败）：手动重试入口 */}
            {!loading &&
                !loadingMore &&
                stalled &&
                !isEnd &&
                onRetry && (
                    <div
                        className="loading-hint"
                        style={{ cursor: "pointer" }}
                        onClick={onRetry}
                    >
                        加载中断，点击重试
                    </div>
                )}
            {/* 滚动到底：所有已加载行渲染完 + 音源报 isEnd，收尾提示 */}
            {!isSearching &&
                !loading &&
                !loadingMore &&
                isEnd &&
                musicList.length > 0 &&
                allRowsRendered && (
                    <div className="music-list-end">没有更多了</div>
                )}
            {isSearching && (
                <div className="music-search-result">
                    {filteredList.length
                        ? `找到 ${filteredList.length} 首包含「${trimmedKeyword}」的歌曲`
                        : "没有找到匹配的歌曲"}
                </div>
            )}
            {!loading && !isSearching && !musicList.length && (
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
                    {userSheetMode && onSourceFix && (
                        <>
                            <button className="btn-ghost" onClick={() => runSourceFix("rematch")}>
                                <Icon name="refresh" size={14} />
                                重新匹配
                            </button>
                            <button className="btn-ghost" onClick={() => runSourceFix("replacer")}>
                                <Icon name="forward" size={14} />
                                替换音源
                            </button>
                            <button className="btn-ghost" onClick={() => runSourceFix("repair")}>
                                <Icon name="plugin" size={14} />
                                修复音源
                            </button>
                        </>
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
