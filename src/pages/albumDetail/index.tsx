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
    const [page, setPage] = useState(1);
    const [isEnd, setIsEnd] = useState(true);

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
                } catch (e: any) {
                    showToast(`加载专辑失败：${e?.message ?? e}`);
                }
            }
            setLoading(false);
        })();
    }, [albumItem?.id]);

    const loadMore = async () => {
        if (!albumItem || loading) {
            return;
        }
        setLoading(true);
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
                setIsEnd(true);
            }
        }
        setLoading(false);
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
            />
            <MusicList
                musicList={musicList}
                loading={loading}
                isEnd={isEnd}
                listId={`album:${album.platform}/${album.id}`}
                onLoadMore={loadMore}
            />
        </div>
    );
}
