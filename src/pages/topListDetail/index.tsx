import React, { useEffect, useState } from "react";
import MediaHeader from "@/components/base/MediaHeader";
import MusicList from "@/components/base/MusicList";
import { getPluginByMedia, pluginCall } from "@/core/ipc";

/**
 * 榜单详情页
 */

export default function TopListDetailPage(props: { topListItem?: IMusic.IMusicSheetItem }) {
    const { topListItem } = props;
    const [musicList, setMusicList] = useState<IMusic.IMusicItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [page, setPage] = useState(1);
    const [isEnd, setIsEnd] = useState(true);

    useEffect(() => {
        if (!topListItem) {
            return;
        }
        (async () => {
            setLoading(true);
            const plugin = await getPluginByMedia(topListItem);
            if (plugin?.supportedMethods.includes("getTopListDetail")) {
                try {
                    const result = await pluginCall(
                        plugin.hash,
                        "getTopListDetail",
                        topListItem,
                        1,
                    );
                    setMusicList((result?.musicList ?? []) as IMusic.IMusicItem[]);
                    setIsEnd(result?.isEnd ?? true);
                    setPage(1);
                } catch {
                    setIsEnd(true);
                }
            }
            setLoading(false);
        })();
    }, [topListItem?.id]);

    const loadMore = async () => {
        if (!topListItem || loading) {
            return;
        }
        setLoading(true);
        const plugin = await getPluginByMedia(topListItem);
        if (plugin) {
            try {
                const result = await pluginCall(
                    plugin.hash,
                    "getTopListDetail",
                    topListItem,
                    page + 1,
                );
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

    if (!topListItem) {
        return <div className="empty-hint">榜单信息缺失</div>;
    }

    return (
        <div>
            <MediaHeader
                artwork={topListItem.artwork}
                title={topListItem.title}
                description={topListItem.description}
                musicList={musicList}
                meta={[musicList.length ? `共 ${musicList.length} 首` : ""].filter(Boolean)}
                listId={`topList:${topListItem.platform}/${topListItem.id}`}
            />
            <MusicList
                musicList={musicList}
                loading={loading}
                isEnd={isEnd}
                listId={`topList:${topListItem.platform}/${topListItem.id}`}
                onLoadMore={loadMore}
            />
        </div>
    );
}
