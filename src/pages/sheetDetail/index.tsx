import React, { useCallback, useEffect, useState } from "react";
import MediaHeader from "@/components/base/MediaHeader";
import MusicList from "@/components/base/MusicList";
import Icon from "@/components/base/Icon";
import { getPluginByMedia, pluginCall } from "@/core/ipc";
import {
    LIKES_SHEET_ID,
    deleteSheet,
    getSheetById,
    removeMusicFromSheet,
    removeMusicFromSheetMany,
    renameSheet,
} from "@/core/musicSheet";
import { showAddToSheetPanel } from "@/components/base/AddToSheetPanel";
import { showDownloadPanel } from "@/components/base/DownloadPanel";
import { showPrompt } from "@/components/base/PromptDialog";
import { showToast } from "@/components/base/Toast";
import { navigate } from "@/core/router";
import { usePagedMusicList } from "@/hooks/usePagedMusicList";

/**
 * 歌单详情页：
 *  - 插件歌单（params.sheetItem）：getMusicSheetInfo 按音源页码加载
 *  - 本地歌单 / 我喜欢的音乐（params.userSheetId）：主进程持久化，支持管理操作
 *
 * 列表按「每页 N 条」展示（默认 40，可在底部切换）。音源的 page 是页码不是条数，
 * 凑不满一页时 usePagedMusicList 会自动继续拉下一页，对用户表现为普通的页码分页。
 */

/** 每页条数偏好按列表分开记忆（与搜索页各存一份） */
const SHEET_PAGE_SIZE_KEY = "pagedList.pageSize.sheetDetail";
const SHEET_DEFAULT_PAGE_SIZE = 40;

interface ISheetDetailPageProps {
    sheetItem?: IMusic.IMusicSheetItem;
    userSheetId?: string;
}

export default function SheetDetailPage(props: ISheetDetailPageProps) {
    const { sheetItem, userSheetId } = props;
    const [title, setTitle] = useState(sheetItem?.title ?? "歌单");
    const [artwork, setArtwork] = useState(sheetItem?.artwork ?? "");
    const [description, setDescription] = useState("");
    const [pluginName, setPluginName] = useState("");
    /**
     * 音源声明的总曲目数（`sheetItem.worksNum`）。
     * 插件协议的**搜索**返回只有 `{isEnd, data}`，拿不到总数；但歌单详情的
     * `sheetItem` 带 `worksNum`（实测值：115），所以歌单能一进来就显示真实总数和总页数。
     * 有些插件不填这个字段，那时退回显示「已加载 N 首」。
     */
    const [worksNum, setWorksNum] = useState<number | undefined>(undefined);

    const isUserSheet = !!userSheetId;
    const isLikesSheet = userSheetId === LIKES_SHEET_ID;

    /** 本地歌单的头部信息（标题 / 封面 / 描述） */
    const applyUserSheet = useCallback((sheet: any) => {
        if (!sheet) {
            return;
        }
        setTitle(sheet.title);
        // 歌单封面取第一首歌的封面
        setArtwork(sheet.musicList?.[0]?.artwork ?? "");
        // 本地歌单没有音源声明的总数，本来就一次性全量加载
        setWorksNum(undefined);
        setDescription(
            sheet.id === LIKES_SHEET_ID
                ? "红心喜欢的歌曲都会收藏在这里"
                : `创建于 ${new Date(sheet.createAt).toLocaleDateString("zh-CN")}`,
        );
    }, []);

    const fetchPage = useCallback(
        async (page: number) => {
            // 本地歌单是一次性全量数据，只有第 1 页
            if (userSheetId) {
                const sheet = await getSheetById(userSheetId);
                if (page === 1) {
                    applyUserSheet(sheet);
                }
                return {
                    items: (sheet?.musicList ?? []) as IMusic.IMusicItem[],
                    isEnd: true,
                };
            }

            if (!sheetItem) {
                return { items: [] as IMusic.IMusicItem[], isEnd: true };
            }

            const plugin = await getPluginByMedia(sheetItem);
            if (!plugin?.supportedMethods.includes("getMusicSheetInfo")) {
                return { items: [] as IMusic.IMusicItem[], isEnd: true };
            }
            setPluginName(plugin.name);

            try {
                const result = await pluginCall(
                    plugin.hash,
                    "getMusicSheetInfo",
                    sheetItem,
                    page,
                );
                if (page === 1) {
                    setTitle(result?.sheetItem?.title ?? sheetItem.title);
                    setArtwork(result?.sheetItem?.artwork ?? sheetItem.artwork);
                    setDescription(result?.sheetItem?.description ?? "");
                    const declared = Number(result?.sheetItem?.worksNum);
                    setWorksNum(Number.isFinite(declared) && declared > 0 ? declared : undefined);
                }
                return {
                    items: (result?.musicList ?? []) as IMusic.IMusicItem[],
                    isEnd: result?.isEnd ?? true,
                };
            } catch (e: any) {
                // 抛出去即可：分页层会保留「未到底」，用户可以再点「下一页」重试
                showToast(`加载歌单失败：${e?.message ?? e}`);
                throw e;
            }
        },
        [applyUserSheet, sheetItem, userSheetId],
    );

    const list = usePagedMusicList<IMusic.IMusicItem>({
        fetchPage,
        defaultPageSize: SHEET_DEFAULT_PAGE_SIZE,
        storageKey: SHEET_PAGE_SIZE_KEY,
        resetKey: `${sheetItem?.id ?? ""}|${userSheetId ?? ""}`,
        expectedTotal: worksNum,
    });
    const { replaceAll } = list;

    // 用户歌单：定时刷新（在别处喜欢/收藏的歌能自动出现）。
    // 用 replaceAll 就地替换，避免把用户从第 N 页踢回第 1 页。
    useEffect(() => {
        if (!userSheetId) {
            return;
        }
        const timer = setInterval(async () => {
            const sheet = await getSheetById(userSheetId);
            if (!sheet) {
                return;
            }
            applyUserSheet(sheet);
            replaceAll(sheet.musicList);
        }, 3000);
        return () => clearInterval(timer);
    }, [userSheetId, applyUserSheet, replaceAll]);

    const handleRemove = async (musicItem: IMusic.IMusicItem) => {
        await removeMusicFromSheet(userSheetId!, musicItem);
        showToast("已从歌单移除");
        const sheet = await getSheetById(userSheetId!);
        if (sheet) {
            applyUserSheet(sheet);
            replaceAll(sheet.musicList);
        }
    };

    const refreshUserSheet = async () => {
        if (!userSheetId) {
            return;
        }
        const sheet = await getSheetById(userSheetId);
        if (sheet) {
            applyUserSheet(sheet);
            replaceAll(sheet.musicList);
        }
    };

    /** 多选「取消收藏」：从当前歌单批量移除（一次写盘） */
    const handleRemoveMany = async (musicItems: IMusic.IMusicItem[]) => {
        const removed = await removeMusicFromSheetMany(userSheetId!, musicItems);
        showToast(removed ? `已从歌单移除 ${removed} 首` : "这些歌曲不在当前歌单中");
        await refreshUserSheet();
    };

    const handleRename = () => {
        showPrompt({
            title: "重命名歌单",
            defaultValue: title,
            confirmText: "保存",
            onConfirm: async (newTitle) => {
                await renameSheet(userSheetId!, newTitle);
                setTitle(newTitle);
                showToast("已重命名");
            },
        });
    };

    const handleDelete = async () => {
        await deleteSheet(userSheetId!);
        showToast(`已删除「${title}」`);
        navigate("home");
    };

    return (
        <div>
            <MediaHeader
                artwork={artwork}
                title={title}
                description={description}
                musicList={list.items}
                meta={[
                    pluginName ? `来源：${pluginName}` : "",
                    // 有音源声明的总数就用它；否则只在确实是最后一页时才敢写「共」
                    worksNum
                        ? `共 ${worksNum} 首`
                        : list.items.length
                          ? list.isEnd
                              ? `共 ${list.items.length} 首`
                              : `已加载 ${list.items.length} 首`
                          : "",
                ].filter(Boolean)}
                // 我的歌单里列表就是收藏结果，不再提供「收藏全部」
                hideFavoriteAll={isUserSheet}
                extraActions={
                    <>
                        {list.items.length > 0 && (
                            <button
                                className="btn-ghost"
                                onClick={() => showDownloadPanel(list.items)}
                            >
                                <Icon name="download" size={14} />
                                下载全部
                            </button>
                        )}
                        {isUserSheet && !isLikesSheet ? (
                            <>
                                <button className="btn-ghost" onClick={handleRename}>
                                    <Icon name="settings" size={13} />
                                    重命名
                                </button>
                                <button className="btn-ghost" onClick={handleDelete}>
                                    <Icon name="close" size={13} />
                                    删除歌单
                                </button>
                            </>
                        ) : null}
                    </>
                }
            />
            <MusicList
                musicList={list.items}
                loading={list.loading}
                userSheetMode={isUserSheet}
                currentSheetId={userSheetId}
                onRemove={isUserSheet ? handleRemove : undefined}
                onRemoveMany={isUserSheet ? handleRemoveMany : undefined}
                onMusicChanged={isUserSheet ? refreshUserSheet : undefined}
                pagination={{
                    currentPage: list.currentPage,
                    totalPages: list.totalPages,
                    pageSize: list.pageSize,
                    pageSizeOptions: list.pageSizeOptions,
                    hasMore: list.hasMore,
                    stalled: list.stalled,
                    loadingMore: list.loadingMore,
                    expectedTotal: worksNum,
                    onPageChange: list.goToPage,
                    onPageSizeChange: list.changePageSize,
                }}
            />
        </div>
    );
}
