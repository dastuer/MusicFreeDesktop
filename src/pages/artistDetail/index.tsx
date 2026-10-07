import React, { useEffect, useState } from "react";
import Cover from "@/components/base/Cover";
import MusicList from "@/components/base/MusicList";
import { getPluginByMedia, pluginCall } from "@/core/ipc";
import { navigate } from "@/core/router";
import { IPagedFetchResult, usePagedMusicList } from "@/hooks/usePagedMusicList";

/**
 * 歌手详情页：作品（单曲）/ 专辑 两个 tab
 *
 * 单曲列表走 usePagedMusicList 的无限滚动模式：滚到底部自动续拉（去重、串行、
 * 失败可重试都在 hook 里），不再有点按钮翻页；专辑 tab 仍是整屏卡片 + 手动加载更多。
 */

/** 一次续拉的数据量（音源页条数不定，这里按「缺口 = 60 条」滚动补） */
const ARTIST_LOAD_CHUNK = 60;

export default function ArtistDetailPage(props: { artistItem?: IArtist.IArtistItemBase }) {
    const { artistItem } = props;
    const [type, setType] = useState<"music" | "album">("music");
    const [albums, setAlbums] = useState<IArtist.IAlbumItem[]>([]);
    // 进页面就要拉数据，初始即加载态：否则 effect 首帧置位前会先闪一帧空态
    const [albumLoading, setAlbumLoading] = useState(() => !!artistItem);

    /** 拉音源第 page 页（type 决定取单曲还是专辑） */
    const fetchArtistWorksPage = async (page: number): Promise<IPagedFetchResult<any>> => {
        const plugin = await getPluginByMedia(artistItem!);
        if (!plugin?.supportedMethods.includes("getArtistWorks")) {
            return { items: [], isEnd: true };
        }
        const result = await pluginCall(plugin.hash, "getArtistWorks", artistItem, page, type);
        return {
            items: (result?.data ?? []) as any[],
            isEnd: result?.isEnd ?? true,
        };
    };

    const musicList = usePagedMusicList<IMusic.IMusicItem>({
        fetchPage: (page) =>
            // 只在「单曲」tab 且歌手信息齐全时走 hook 发请求：专辑 tab 的卡片自己拉、
            // 缺歌手信息时（路由参数丢失）不白跑网络
            type === "music" && artistItem
                ? fetchArtistWorksPage(page)
                : Promise.resolve({ items: [] as IMusic.IMusicItem[], isEnd: true }),
        defaultPageSize: ARTIST_LOAD_CHUNK,
        storageKey: "pagedList.pageSize.artistMusic",
        resetKey: `${artistItem?.platform ?? ""}|${artistItem?.id ?? ""}|${type}`,
    });

    useEffect(() => {
        if (!artistItem) {
            return;
        }
        setAlbums([]);
        if (type !== "album") {
            return;
        }
        (async () => {
            setAlbumLoading(true);
            try {
                const first = await fetchArtistWorksPage(1);
                setAlbums(first.items as IArtist.IAlbumItem[]);
            } catch {
                // 失败保持空态，切走再切回 tab 会重拉
            }
            setAlbumLoading(false);
        })();
    }, [artistItem?.id, type]);

    if (!artistItem) {
        return <div className="empty-hint">歌手信息缺失</div>;
    }

    return (
        <div>
            <div className="media-header">
                <Cover
                    src={artistItem.avatar}
                    size={140}
                    borderRadius="50%"
                    className="media-header-artwork"
                />
                <div className="media-header-info">
                    <div className="media-header-title">{artistItem.name}</div>
                    {artistItem.description && (
                        <div className="media-header-desc">{artistItem.description}</div>
                    )}
                </div>
            </div>

            <div className="search-tabs">
                <button
                    className={`search-tab${type === "music" ? " active" : ""}`}
                    onClick={() => setType("music")}
                >
                    单曲
                </button>
                <button
                    className={`search-tab${type === "album" ? " active" : ""}`}
                    onClick={() => setType("album")}
                >
                    专辑
                </button>
            </div>

            {type === "music" ? (
                <MusicList
                    musicList={musicList.items}
                    loading={musicList.loading}
                    loadingMore={musicList.loadingMore}
                    autoLoad
                    isEnd={musicList.isEnd}
                    stalled={musicList.stalled}
                    onRetry={musicList.retry}
                    onLoadMore={musicList.loadMore}
                    listId={`artist:${artistItem?.platform}/${artistItem?.id}`}
                />
            ) : (
                <div className="card-grid">
                    {albums.map((album, index) => (
                        <div
                            key={`${(album as any).platform ?? ""}-${album.id ?? "x"}-${index}`}
                            className="media-card"
                            onClick={() => navigate("albumDetail", { albumItem: album })}
                        >
                            {/* 封面需要有确定高度的容器，否则 size="100%" 的 height 会按网格行高解析 */}
                            <div className="square-cover">
                                <Cover
                                    src={album.artwork}
                                    size="100%"
                                    borderRadius={8}
                                    style={{ width: "100%", height: "100%" }}
                                />
                            </div>
                            <div className="media-card-title">{album.title}</div>
                            {album.date && (
                                <div className="media-card-subtitle">{album.date}</div>
                            )}
                        </div>
                    ))}
                </div>
            )}
            {/* 单曲列表的加载占位由 MusicList 的骨架屏负责，这里的提示只给专辑卡片 tab 用 */}
            {type !== "music" && albumLoading && (
                <div className="loading-hint">加载中…</div>
            )}
        </div>
    );
}
