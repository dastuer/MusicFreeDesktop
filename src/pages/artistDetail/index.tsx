import React, { useEffect, useState } from "react";
import Cover from "@/components/base/Cover";
import MusicList from "@/components/base/MusicList";
import { getPluginByMedia, pluginCall } from "@/core/ipc";
import { navigate } from "@/core/router";

/**
 * 歌手详情页：作品（单曲）/ 专辑 两个 tab
 */

export default function ArtistDetailPage(props: { artistItem?: IArtist.IArtistItemBase }) {
    const { artistItem } = props;
    const [type, setType] = useState<"music" | "album">("music");
    const [musicList, setMusicList] = useState<IMusic.IMusicItem[]>([]);
    const [albums, setAlbums] = useState<IArtist.IAlbumItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [page, setPage] = useState(1);
    const [isEnd, setIsEnd] = useState(true);

    useEffect(() => {
        if (!artistItem) {
            return;
        }
        (async () => {
            setLoading(true);
            setMusicList([]);
            setAlbums([]);
            const plugin = await getPluginByMedia(artistItem);
            if (plugin?.supportedMethods.includes("getArtistWorks")) {
                try {
                    const result = await pluginCall(
                        plugin.hash,
                        "getArtistWorks",
                        artistItem,
                        1,
                        type,
                    );
                    if (type === "music") {
                        setMusicList((result?.data ?? []) as IMusic.IMusicItem[]);
                    } else {
                        setAlbums((result?.data ?? []) as IArtist.IAlbumItem[]);
                    }
                    setIsEnd(result?.isEnd ?? true);
                    setPage(1);
                } catch {
                    setIsEnd(true);
                }
            }
            setLoading(false);
        })();
    }, [artistItem?.id, type]);

    const loadMore = async () => {
        if (!artistItem || loading) {
            return;
        }
        setLoading(true);
        const plugin = await getPluginByMedia(artistItem);
        if (plugin) {
            try {
                const result = await pluginCall(
                    plugin.hash,
                    "getArtistWorks",
                    artistItem,
                    page + 1,
                    type,
                );
                if (type === "music") {
                    setMusicList((prev) => [...prev, ...((result?.data ?? []) as any[])]);
                } else {
                    setAlbums((prev) => [...prev, ...((result?.data ?? []) as any[])]);
                }
                setIsEnd(result?.isEnd ?? true);
                setPage((p) => p + 1);
            } catch {
                setIsEnd(true);
            }
        }
        setLoading(false);
    };

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
                    musicList={musicList}
                    loading={loading}
                    isEnd={isEnd}
                    listId={`artist:${artistItem?.platform}/${artistItem?.id}`}
                    onLoadMore={loadMore}
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
            {loading && <div className="loading-hint">加载中…</div>}
        </div>
    );
}
