import React, { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import Icon from "../base/Icon";
import Cover from "../base/Cover";
import Marquee from "../base/Marquee";
import Slider from "../base/Slider";
import {
    DEFAULT_VOLUME,
    TrackPlayerSingleton,
    playListAddedAtom,
    useCurrentMusic,
    useMusicState,
    useProgress,
    useRepeatMode,
    useVolume,
} from "@/core/trackPlayer";
import { isLiked, likesVersionAtom, toggleLike } from "@/core/musicSheet";
import { showAddToSheetPanel } from "../base/AddToSheetPanel";
import { showDownloadPanel } from "../base/DownloadPanel";
import { showToast } from "../base/Toast";
import { showPlayQueuePanel } from "./PlayQueuePanel";

const repeatModeMeta: Record<string, { icon: string; label: string }> = {
    off: { icon: "repeatOff", label: "列表循环" },
    queue: { icon: "repeatQueue", label: "随机播放" },
    single: { icon: "repeatSingle", label: "单曲循环" },
};

function formatTime(s: number) {
    const sec = Math.floor(s % 60);
    const min = Math.floor(s / 60);
    return `${min}:${sec.toString().padStart(2, "0")}`;
}

export default function PlayerBar(props: { onOpenDetail?: () => void }) {
    const { onOpenDetail } = props;
    const currentMusic = useCurrentMusic();
    const musicState = useMusicState();
    const progress = useProgress();
    const repeatMode = useRepeatMode();
    const volume = useVolume();
    const muted = volume === 0;
    const [liked, setLiked] = useState(false);
    const likesVersion = useAtomValue(likesVersionAtom);
    /** 队列一进歌就在歌单入口图标上弹一次提示，两秒后自己收回去 */
    const playListAddedSeq = useAtomValue(playListAddedAtom);
    const [queueHintVisible, setQueueHintVisible] = useState(false);

    useEffect(() => {
        if (!playListAddedSeq) {
            return;
        }
        setQueueHintVisible(true);
        const timer = setTimeout(() => setQueueHintVisible(false), 2000);
        return () => clearTimeout(timer);
    }, [playListAddedSeq]);

    // 订阅喜欢状态版本号：列表/播放栏任何位置切换喜欢后同步刷新
    useEffect(() => {
        if (currentMusic) {
            isLiked(currentMusic).then(setLiked);
        } else {
            setLiked(false);
        }
    }, [currentMusic?.id, currentMusic?.platform, likesVersion]);

    const handleToggleLike = async () => {
        if (!currentMusic) {
            return;
        }
        const next = await toggleLike(currentMusic);
        setLiked(next);
        showToast(next ? "已添加到我喜欢的音乐" : "已取消喜欢");
    };

    const playing = musicState === "playing";
    const loading = musicState === "loading";

    return (
        <div className="app-playerbar">
            {/* 进度条贴着状态栏顶边，不直接展示时间；悬浮/拖动时条变粗并在滑块上方冒出时间气泡 */}
            <div className="playerbar-progress-row">
                <Slider
                    className="playerbar-progress"
                    value={progress.position}
                    max={progress.duration || currentMusic?.duration || 0}
                    commitOnRelease
                    onCommit={(v) => TrackPlayerSingleton.seekTo(v)}
                    onChange={() => undefined}
                    tooltip={(v) => (
                        <span className="playerbar-time-bubble">
                            {/* 斜杠两侧用细空格，比常规空格更紧凑 */}
                            {formatTime(v) + "\u2009/\u2009" + formatTime(progress.duration || currentMusic?.duration || 0)}
                        </span>
                    )}
                />
            </div>

            <div className="playerbar-main-row">
                {/* 左：封面 + 标题 */}
                <div
                    className="playerbar-left"
                    style={{ cursor: currentMusic ? "pointer" : "default" }}
                    onClick={() => currentMusic && onOpenDetail?.()}
                >
                    <div className={`playerbar-disc${playing ? " playing" : ""}`}>
                        <Cover
                            src={currentMusic?.artwork}
                            size={42}
                            borderRadius={21}
                            className="playerbar-cover"
                        />
                    </div>
                    <div className="playerbar-info">
                        <Marquee
                            className="playerbar-title"
                            text={currentMusic?.title ?? "MusicFree Desktop"}
                        />
                        <div className="playerbar-artist">
                            {currentMusic?.artist ?? "点击列表中的歌曲开始播放"}
                        </div>
                    </div>
                </div>

                {/* 中：播放模式 / 上一首 / 播放暂停 / 下一首 / 播放列表 */}
                <div className="playerbar-center">
                    <button
                        className="playerbar-control-btn"
                        title={repeatModeMeta[repeatMode].label}
                        onClick={() => TrackPlayerSingleton.toggleRepeatMode()}
                    >
                        <Icon name={repeatModeMeta[repeatMode].icon} size={16} />
                    </button>
                    <button
                        className="playerbar-control-btn"
                        onClick={() => TrackPlayerSingleton.skipToPrevious()}
                        title="上一首 (←)"
                    >
                        <Icon name="prev" size={20} />
                    </button>
                    <button
                        className="playerbar-play-btn"
                        onClick={() => TrackPlayerSingleton.togglePlay()}
                        title={loading ? "取消加载 (空格)" : playing ? "暂停 (空格)" : "播放 (空格)"}
                    >
                        {loading ? (
                            <span className="playerbar-spinner" />
                        ) : (
                            <Icon name={playing ? "pause" : "play"} size={16} />
                        )}
                    </button>
                    <button
                        className="playerbar-control-btn"
                        onClick={() => TrackPlayerSingleton.skipToNext()}
                        title="下一首 (→)"
                    >
                        <Icon name="next" size={20} />
                    </button>
                    <div className="playerbar-queue-entry">
                        <button
                            className="playerbar-control-btn"
                            title="播放列表"
                            onClick={() => showPlayQueuePanel()}
                        >
                            <Icon name="playQueue" size={16} />
                        </button>
                        {queueHintVisible && (
                            <span className="playerbar-queue-hint">已添加到歌单列表</span>
                        )}
                    </div>
                </div>

                {/* 右：下载 / 喜欢 / 收藏到歌单 / 音量 */}
                <div className="playerbar-right">
                    {currentMusic && (
                        <button
                            className="playerbar-control-btn"
                            title="下载当前歌曲"
                            onClick={() => showDownloadPanel([currentMusic])}
                        >
                            <Icon name="download" size={16} />
                        </button>
                    )}
                    {currentMusic && (
                        <button
                            className="playerbar-control-btn"
                            title={liked ? "取消喜欢" : "喜欢"}
                            onClick={handleToggleLike}
                        >
                            <Icon
                                name={liked ? "heartFilled" : "heart"}
                                size={17}
                                style={{
                                    color: liked ? "var(--primary-color)" : "var(--text-color)",
                                }}
                            />
                        </button>
                    )}
                    {currentMusic && (
                        <button
                            className="playerbar-control-btn"
                            title="收藏到歌单"
                            onClick={() => showAddToSheetPanel(currentMusic)}
                        >
                            <Icon name="addToSheet" size={16} />
                        </button>
                    )}
                    <button
                        className="playerbar-control-btn"
                        title={muted ? "取消静音" : "静音"}
                        onClick={() => TrackPlayerSingleton.setVolume(muted ? DEFAULT_VOLUME : 0)}
                    >
                        <Icon name={muted ? "volumeMute" : "volume"} size={16} />
                    </button>
                    <Slider
                        value={volume}
                        max={1}
                        onChange={(v) => TrackPlayerSingleton.setVolume(v)}
                    />
                </div>
            </div>
        </div>
    );
}
