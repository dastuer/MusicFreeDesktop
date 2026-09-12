import React, { useEffect, useMemo, useRef, useState } from "react";
import Icon from "../base/Icon";
import Cover from "../base/Cover";
import Slider from "../base/Slider";
import {
    TrackPlayerSingleton,
    useCurrentMusic,
    useCurrentLyric,
    loadCurrentLyric,
    useMusicState,
} from "@/core/trackPlayer";
import { useProgress } from "@/core/trackPlayer";

/**
 * 正在播放页：左侧大封面 / 右侧滚动歌词（网易云风格）
 * 覆盖在主内容区之上，底部播放条保持可见
 */

export default function MusicDetailOverlay(props: { visible: boolean; onClose: () => void }) {
    const { visible, onClose } = props;
    const currentMusic = useCurrentMusic();
    const musicState = useMusicState();
    const progress = useProgress();
    const lyric = useCurrentLyric();
    const lyricRef = useRef<HTMLDivElement>(null);
    const [userScrolled, setUserScrolled] = useState(false);

    useEffect(() => {
        if (visible && currentMusic) {
            loadCurrentLyric(currentMusic);
        }
    }, [visible, currentMusic?.id]);

    // 歌词自动滚动到当前行
    const activeIndex = useMemo(() => {
        let index = -1;
        lyric.forEach((item, i) => {
            if (item.time <= progress.position + 0.2) {
                index = i;
            }
        });
        return index;
    }, [lyric, progress.position]);

    useEffect(() => {
        if (userScrolled || activeIndex < 0 || !lyricRef.current) {
            return;
        }
        const el = lyricRef.current.querySelector(
            `.lyric-line[data-index="${activeIndex}"]`,
        );
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, [activeIndex, userScrolled]);

    if (!visible || !currentMusic) {
        return null;
    }

    return (
        <div
            className="music-detail-overlay"
            style={{ bottom: "var(--playerbar-height)" }}
        >
            {/* 顶部操作栏：避开 macOS 红绿灯区域，收起按钮加大热区 */}
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "52px 24px 0",
                    flexShrink: 0,
                }}
            >
                <button
                    className="titlebar-nav-btn"
                    style={{ width: 36, height: 36 }}
                    onClick={onClose}
                    title="收起"
                >
                    <Icon
                        name="chevronDown"
                        size={22}
                        style={{ color: "var(--text-secondary)" }}
                    />
                </button>
            </div>
            <div className="music-detail-body">
                <div className="music-detail-cover-wrap">
                    <Cover
                        src={currentMusic.artwork}
                        size="100%"
                        borderRadius={12}
                        className="music-detail-cover"
                        style={{ width: "100%", height: "100%" }}
                    />
                </div>
                <div className="music-detail-info">
                    <div className="music-detail-title">{currentMusic.title}</div>
                    <div className="music-detail-artist">
                        {currentMusic.artist}
                        {currentMusic.album ? ` - ${currentMusic.album}` : ""}
                    </div>
                    <div
                        className="music-detail-lyric"
                        ref={lyricRef}
                        onWheel={() => {
                            setUserScrolled(true);
                            clearTimeout((lyricRef.current as any)?._scrollTimer);
                            (lyricRef.current as any)._scrollTimer = setTimeout(
                                () => setUserScrolled(false),
                                3000,
                            );
                        }}
                    >
                        {lyric.length ? (
                            lyric.map((item, index) => (
                                <div
                                    key={index}
                                    data-index={index}
                                    className={`lyric-line${
                                        index === activeIndex ? " active" : ""
                                    }`}
                                >
                                    {item.lrc || "·"}
                                </div>
                            ))
                        ) : (
                            <div className="empty-hint">纯音乐，请欣赏</div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
