import React, { useEffect, useState } from "react";
import MediaHeader from "@/components/base/MediaHeader";
import MusicList from "@/components/base/MusicList";
import { getPluginByMedia, pluginCall } from "@/core/ipc";
import { showToast } from "@/components/base/Toast";

export default function AlbumDetailPage(props: { albumItem?: IAlbum.IAlbumItem }) {
    const { albumItem } = props;
    const [album, setAlbum] = useState<IAlbum.IAlbumItem | null>(albumItem ?? null);
    const [musicList, setMusicList] = useState<IMusic.IMusicItem[]>([]);
    // 进页面就要拉数据，初始即加载态：否则 effect 首帧置位前会先闪一帧空态
    const [loading, setLoading] = useState(() => !!albumItem);
    /** 追加加载中（滚到底部自动续拉下一页时置位，与首屏 loading 分开） */
    const [loadingMore, setLoadingMore] = useState(false);
    const [page, setPage] = useState(1);
    const [isEnd, setIsEnd] = useState(true);
    /** 多选模式：入口在头部「…」更多菜单里，状态由 MediaHeader 和 MusicList 共享（同歌单/榜单详情页） */
    const [selectMode, setSelectMode] = useState(false);

    useEffect(() => {
        if (!albumItem) {
            return;
        }
        (async () => {
            setLoading(true);
            const plugin = await getPluginByMedia(albumItem);
            if (plugin?.supportedMethods.includes("getAlbumInfo")) {
                try {
                    const result = await pluginCall(plugin.hash, "getAlbumInfo", albumItem, 1);
                    if (result?.albumItem) {
                        setAlbum({ ...albumItem, ...result.albumItem });
                    }
                    setMusicList((result?.musicList ?? []) as IMusic.IMusicItem[]);
                    setIsEnd(result?.isEnd ?? true);
                    setPage(1);
                } catch (e: any) {
                    showToast(`加载专辑失败：${e?.message ?? e}`);
                }
            }
            setLoading(false);
        })();
    }, [albumItem?.id]);

    /** 无限滚动：滚到底部哨兵触发，向音源续拉下一页 */
    const loadMore = async () => {
        if (!albumItem || loading || loadingMore || isEnd) {
            return;
        }
        setLoadingMore(true);
        const plugin = await getPluginByMedia(albumItem);
        if (plugin) {
            try {
                const result = await pluginCall(plugin.hash, "getAlbumInfo", albumItem, page + 1);
                setMusicList((prev) => [
                    ...prev,
                    ...((result?.musicList ?? []) as IMusic.IMusicItem[]),
                ]);
                setIsEnd(result?.isEnd ?? true);
                setPage((p) => p + 1);
            } catch {
                // 一次失败不锁死列表：哨兵会重新进视口再触发重试
            }
        }
        setLoadingMore(false);
    };

    if (!album) {
        return <div className="empty-hint">专辑信息缺失</div>;
    }

    return (
        <div>
            <MediaHeader
                artwork={album.artwork}
                title={album.title}
                description={album.description}
                musicList={musicList}
                meta={[
                    album.artist ? `歌手：${album.artist}` : "",
                    album.date ? `发行时间：${album.date}` : "",
                    album.company ? `发行公司：${album.company}` : "",
                    musicList.length ? `共 ${musicList.length} 首` : "",
                ].filter(Boolean)}
                listId={`album:${album.platform}/${album.id}`}
                moreMenuItems={
                    musicList.length > 0
                        ? [
                              {
                                  title: "多选",
                                  icon: "check",
                                  onClick: () => setSelectMode(true),
                              },
                          ]
                        : []
                }
            />
            <MusicList
                musicList={musicList}
                loading={loading}
                loadingMore={loadingMore}
                isEnd={isEnd}
                searchable
                listId={`album:${album.platform}/${album.id}`}
                selectMode={selectMode}
                onSelectModeChange={setSelectMode}
                onLoadMore={loadMore}
            />
        </div>
    );
}
