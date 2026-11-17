import React, { useEffect, useState } from "react";
import Icon from "../base/Icon";
import Cover from "../base/Cover";
import CommentsPanel from "./CommentsPanel";
import { useCurrentMusic } from "@/core/trackPlayer";

/**
 * 播放详情页·评论页：顶栏（收起 + 居中歌曲胶囊切回歌词）+ 整页评论区。
 * 与歌词页并列放在 MusicDetailOverlay 的 .music-detail-views 里，
 * 由容器的 view 状态驱动上下滑动切换。
 *
 * 切歌不跟切：进入评论页时把当时的歌「钉住」，之后切歌评论区仍停在原歌，
 * 只浮出「切换到当前歌曲评论」提示条，点了才切——避免正读着的评论被顶走。
 */

const musicKeyOf = (music: IMusic.IMusicItem) => `${music.platform}:${music.id}`;

export default function MusicDetailCommentPage(props: {
    visible: boolean;
    active: boolean;
    onBackToLyric: () => void;
    onClose: () => void;
}) {
    const { visible, active, onBackToLyric, onClose } = props;
    const currentMusic = useCurrentMusic();
    /** 钉住的歌：评论区正在展示的歌曲；null = 跟随当前播放曲 */
    const [pinnedMusic, setPinnedMusic] = useState<IMusic.IMusicItem | null>(null);

    useEffect(() => {
        if (visible && active) {
            // 进入评论页：钉住此刻的歌。切歌时依赖里的 currentMusic 虽会变，
            // 但已有钉住对象就不动，保证读着的评论区不被顶走
            setPinnedMusic((prev) => prev ?? currentMusic);
        } else {
            // 离开评论页（切回歌词/收起）：解除钉住，下次进入再看当时的歌
            setPinnedMusic(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, active, currentMusic]);

    // 实际展示的歌曲：未钉住时跟随当前播放曲；钉住期间切歌，它不变（key 不变即不重载）
    const displayMusic = pinnedMusic ?? currentMusic;
    // 钉住的不是正在播的歌：浮出提示条，点了才切到当前歌的评论
    const showSwitchTip =
        !!pinnedMusic && !!currentMusic && musicKeyOf(pinnedMusic) !== musicKeyOf(currentMusic);

    if (!currentMusic || !displayMusic) {
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
                key={musicKeyOf(displayMusic)}
                music={displayMusic}
                active={visible && active}
            />
            {showSwitchTip && (
                <button
                    className="cmt-switch-tip"
                    title="评论区仍停留在上一首歌"
                    onClick={() => setPinnedMusic(currentMusic)}
                >
                <Icon name="refresh" size={13} style={{ flexShrink: 0 }} />
                <span className="cmt-switch-tip-text">
                    切换到「{currentMusic.title}」的评论
                </span>
                </button>
            )}
        </div>
    );
}
