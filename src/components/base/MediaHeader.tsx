import React from "react";
import Cover from "./Cover";
import Icon from "./Icon";
import { TrackPlayerSingleton } from "@/core/trackPlayer";
import { showToast } from "./Toast";

/**
 * 详情页公共头部：封面 + 标题 + 元信息 + 操作按钮
 */

export default function MediaHeader(props: {
    artwork?: string;
    title: string;
    meta?: string[];
    description?: string;
    musicList: IMusic.IMusicItem[];
    extraActions?: React.ReactNode;
}) {
    const { artwork, title, meta, description, musicList, extraActions } = props;

    return (
        <div className="media-header">
            <Cover src={artwork} size={180} borderRadius={10} className="media-header-artwork" />
            <div className="media-header-info">
                <div className="media-header-title">{title}</div>
                {meta?.map((m, i) => (
                    <div className="media-header-meta" key={i}>
                        {m}
                    </div>
                ))}
                {description && <div className="media-header-desc">{description}</div>}
                <div className="media-header-actions">
                    <button
                        className="btn-primary"
                        disabled={!musicList.length}
                        onClick={() => {
                            if (musicList.length) {
                                TrackPlayerSingleton.playWithReplacePlayList(
                                    musicList[0],
                                    musicList,
                                );
                            }
                        }}
                    >
                        <Icon name="play" size={14} />
                        播放全部
                    </button>
                    <button
                        className="btn-ghost"
                        disabled={!musicList.length}
                        onClick={() => {
                            TrackPlayerSingleton.addAll(musicList);
                            showToast(`已添加 ${musicList.length} 首歌曲到播放列表`);
                        }}
                    >
                        <Icon name="plus" size={14} />
                        收藏全部
                    </button>
                    {extraActions}
                </div>
            </div>
        </div>
    );
}
