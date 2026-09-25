import React, { useEffect, useState } from "react";
import MediaHeader from "@/components/base/MediaHeader";
import MusicList from "@/components/base/MusicList";
import Icon from "@/components/base/Icon";
import { clearMusicHistory, getMusicHistory } from "@/core/musicHistory";

/**
 * 最近播放（播放历史）
 */

export default function HistoryPage() {
    const [musicList, setMusicList] = useState<IMusic.IMusicItem[]>([]);

    const refresh = () => {
        getMusicHistory().then(setMusicList);
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
                extraActions={
                    musicList.length ? (
                        <button
                            className="btn-ghost"
                            onClick={async () => {
                                await clearMusicHistory();
                                setMusicList([]);
                            }}
                        >
                            <Icon name="close" size={13} />
                            清空历史
                        </button>
                    ) : null
                }
            />
            <MusicList musicList={musicList} isEnd listId="history" />
        </div>
    );
}
