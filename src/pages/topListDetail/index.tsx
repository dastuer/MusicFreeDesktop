import React, { useCallback, useState } from "react";
import MediaHeader from "@/components/base/MediaHeader";
import MusicList from "@/components/base/MusicList";
import Icon from "@/components/base/Icon";
import { getPluginByMedia, pluginCall } from "@/core/ipc";
import { showDownloadPanel } from "@/components/base/DownloadPanel";
import { showToast } from "@/components/base/Toast";
import { usePagedMusicList } from "@/hooks/usePagedMusicList";

/**
 * 榜单详情页：与歌单详情页同一套交互 ——
 *  - getTopListDetail 按音源页码加载，展示层走 usePagedMusicList 的「每页 N 条」分页
 *  - 头部功能按钮（播放全部 / 收藏全部 / 下载全部 / … 菜单里的多选）
 */

/** 每页条数偏好按列表分开记忆（与歌单 / 搜索页各存一份） */
const TOPLIST_PAGE_SIZE_KEY = "pagedList.pageSize.topListDetail";
const TOPLIST_DEFAULT_PAGE_SIZE = 40;

export default function TopListDetailPage(props: { topListItem?: IMusic.IMusicSheetItem }) {
    const { topListItem } = props;
    const [title, setTitle] = useState(topListItem?.title ?? "榜单");
    const [description, setDescription] = useState(topListItem?.description ?? "");
    const [pluginName, setPluginName] = useState("");
    /**
     * 插件协议的 getTopListDetail 返回没有强制的总数字段，部分插件会在
     * `sheetItem.worksNum` 里带上总数：有就显示真实总数和总页数，没有就退回「已加载 N 首」。
     */
    const [worksNum, setWorksNum] = useState<number | undefined>(undefined);

    /** 这份榜单的稳定标识：按音源 + 榜单 id */
    const listId =
        topListItem?.id != null ? `topList:${topListItem.platform}/${topListItem.id}` : "";

    const fetchPage = useCallback(
        async (page: number) => {
            if (!topListItem) {
                return { items: [] as IMusic.IMusicItem[], isEnd: true };
            }

            const plugin = await getPluginByMedia(topListItem);
            if (!plugin?.supportedMethods.includes("getTopListDetail")) {
                return { items: [] as IMusic.IMusicItem[], isEnd: true };
            }
            setPluginName(plugin.name);

            try {
                const result = await pluginCall(
                    plugin.hash,
                    "getTopListDetail",
                    topListItem,
                    page,
                );
                if (page === 1) {
                    setTitle(result?.sheetItem?.title ?? topListItem.title);
                    setDescription(result?.sheetItem?.description ?? topListItem.description ?? "");
                    const declared = Number(result?.sheetItem?.worksNum);
                    setWorksNum(Number.isFinite(declared) && declared > 0 ? declared : undefined);
                }
                return {
                    items: (result?.musicList ?? []) as IMusic.IMusicItem[],
                    isEnd: result?.isEnd ?? true,
                };
            } catch (e: any) {
                // 抛出去即可：分页层会保留「未到底」，用户可以再点「下一页」重试
                showToast(`加载榜单失败：${e?.message ?? e}`);
                throw e;
            }
        },
        [topListItem],
    );

    const list = usePagedMusicList<IMusic.IMusicItem>({
        fetchPage,
        defaultPageSize: TOPLIST_DEFAULT_PAGE_SIZE,
        storageKey: TOPLIST_PAGE_SIZE_KEY,
        resetKey: `${topListItem?.platform ?? ""}|${topListItem?.id ?? ""}`,
        expectedTotal: worksNum,
    });

    /** 多选模式：入口在头部「…」更多菜单里，状态提到页面这一层，由 MediaHeader 和 MusicList 共享 */
    const [selectMode, setSelectMode] = useState(false);

    if (!topListItem) {
        return <div className="empty-hint">榜单信息缺失</div>;
    }

    return (
        <div>
            <MediaHeader
                artwork={topListItem.artwork}
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
                listId={listId}
                moreMenuItems={
                    list.items.length > 0
                        ? [
                              {
                                  title: "多选",
                                  icon: "check",
                                  onClick: () => setSelectMode(true),
                              },
                          ]
                        : []
                }
                extraActions={
                    list.items.length > 0 ? (
                        <button
                            className="btn-ghost"
                            onClick={() => showDownloadPanel(list.items)}
                        >
                            <Icon name="download" size={14} />
                            下载全部
                        </button>
                    ) : null
                }
            />
            <MusicList
                musicList={list.items}
                loading={list.loading}
                listId={listId}
                searchable
                selectMode={selectMode}
                onSelectModeChange={setSelectMode}
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
