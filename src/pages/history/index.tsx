import React, { useEffect, useState } from "react";
import MediaHeader from "@/components/base/MediaHeader";
import MusicList from "@/components/base/MusicList";
import { clearMusicHistory, getMusicHistory } from "@/core/musicHistory";

/**
 * 最近播放（播放历史）
 */

export default function HistoryPage() {
    const [musicList, setMusicList] = useState<IMusic.IMusicItem[]>([]);
    /** 多选模式：入口在头部「…」更多菜单里，状态由 MediaHeader 和 MusicList 共享（同歌单/榜单详情页） */
    const [selectMode, setSelectMode] = useState(false);

    const refresh = () => {
        getMusicHistory().then(setMusicList);
    };

    const handleClear = async () => {
        await clearMusicHistory();
        setMusicList([]);
    };

    useEffect(() => {
        refresh();
        const timer = setInterval(refresh, 5000);
        return () => clearInterval(timer);
    }, []);

    return (
        <div>
            <MediaHeader
                artwork={musicList[0]?.artwork}
                title="最近播放"
                musicList={musicList}
                meta={[musicList.length ? `共 ${musicList.length} 首` : ""].filter(Boolean)}
                listId="history"
                moreMenuItems={
                    musicList.length
                        ? [
                              {
                                  title: "多选",
                                  icon: "check",
                                  onClick: () => setSelectMode(true),
                              },
                              {
                                  title: "清空历史",
                                  icon: "close",
                                  danger: true,
                                  onClick: handleClear,
                              },
                          ]
                        : []
                }
                extraActions={null}
            />
            <MusicList
                musicList={musicList}
                isEnd
                searchable
                listId="history"
                selectMode={selectMode}
                onSelectModeChange={setSelectMode}
            />
        </div>
    );
}
