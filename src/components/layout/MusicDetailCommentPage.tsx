import React from "react";
import Icon from "../base/Icon";
import Cover from "../base/Cover";
import CommentsPanel from "./CommentsPanel";
import { useCurrentMusic } from "@/core/trackPlayer";

/**
 * 播放详情页·评论页：顶栏（收起 + 居中歌曲胶囊切回歌词）+ 整页评论区。
 * 与歌词页并列放在 MusicDetailOverlay 的 .music-detail-views 里，
 * 由容器的 view 状态驱动上下滑动切换。
 */

export default function MusicDetailCommentPage(props: {
    visible: boolean;
    active: boolean;
    onBackToLyric: () => void;
    onClose: () => void;
}) {
    const { visible, active, onBackToLyric, onClose } = props;
    const currentMusic = useCurrentMusic();

    if (!currentMusic) {
        return null;
    }

    return (
        <div className={`music-detail-view comment${active ? " current" : ""}`}>
            <div className="music-detail-topbar">
                <button
                    className="titlebar-nav-btn"
                    style={{ width: 36, height: 36, flexShrink: 0 }}
                    onClick={onClose}
                    title="收起"
                >
                    <Icon
                        name="chevronDown"
                        size={22}
                        style={{ color: "var(--text-secondary)" }}
                    />
                </button>
                <div
                    className="music-detail-pill"
                    title="回到歌词"
                    onClick={onBackToLyric}
                >
                    <Cover src={currentMusic.artwork} size={26} borderRadius="50%" />
                    <span className="music-detail-pill-title">
                        {currentMusic.title} - {currentMusic.artist}
                    </span>
                    <Icon
                        name="chevronDown"
                        size={14}
                        style={{ color: "var(--text-secondary)", flexShrink: 0 }}
                    />
                </div>
                <div style={{ width: 36, height: 36, flexShrink: 0 }} />
            </div>
            <CommentsPanel
                key={`${currentMusic.platform}:${currentMusic.id}`}
                music={currentMusic}
                active={visible && active}
            />
        </div>
    );
}
