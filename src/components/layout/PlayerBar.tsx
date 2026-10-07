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
    usePlayingQuality,
    useProgress,
    useQuality,
    useQualitySwapping,
    useRate,
    useRepeatMode,
    useVolume,
} from "@/core/trackPlayer";
import { isLiked, likesVersionAtom, toggleLike } from "@/core/musicSheet";
import {
    toggleDesktopLyrics,
    useDesktopLyricsVisible,
} from "@/core/desktopLyrics";
import {
    toggleLyricTranslation,
    useLyricTranslationOn,
} from "@/core/trackPlayer";
import { showAddToSheetPanel } from "../base/AddToSheetPanel";
import { showDownloadPanel } from "../base/DownloadPanel";
import { showContextMenu } from "../base/ContextMenu";
import { showToast } from "../base/Toast";
import { showPlayQueuePanel } from "./PlayQueuePanel";

const repeatModeMeta: Record<string, { icon: string; label: string }> = {
    off: { icon: "repeatOff", label: "列表循环" },
    queue: { icon: "repeatQueue", label: "随机播放" },
    single: { icon: "repeatSingle", label: "单曲循环" },
};

/** 倍速菜单的档位（低→高） */
const RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** 倍速显示：整数档补一位小数（1→1.0x、2→2.0x），非整数原样（0.75x） */
function formatRate(r: number) {
    return `${Math.abs(r % 1) < 1e-9 ? r.toFixed(1) : String(r)}x`;
}

/** 音质短标签：徽标和菜单都用它（与下载管理页同一套叫法） */
const qualityMeta: Record<IMusic.IQualityKey, string> = {
    low: "低品",
    standard: "标准",
    high: "高清",
    super: "无损",
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
    const quality = useQuality();
    // 实际命中的音质档：请求了无损但被降级到标准时，徽标要跟着说实话
    const playingQuality = usePlayingQuality();
    // 无缝切换音质中（新音质预缓冲）：播放不受影响，徽标给个呼吸提示
    const qualitySwapping = useQualitySwapping();
    const muted = volume === 0;
    /**
     * 徽标显示的音质：优先用实际命中的档位（解析降级后徽标跟着实话实说）；
     * 解析中 / 还未知时回退显示默认音质；本地文件没有音质概念，不显示徽标。
     */
    const badgeQuality = currentMusic?.localPath ? null : playingQuality ?? quality;
    const lyricsVisible = useDesktopLyricsVisible();
    const translationOn = useLyricTranslationOn();
    const rate = useRate();
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

    const showQualityMenu = (e: React.MouseEvent) => {
        // 阻止冒泡：context-menu 靠 window 的 click 关闭，不拦的话刚打开就会被这次点击关掉
        e.stopPropagation();
        const rect = e.currentTarget.getBoundingClientRect();
        showContextMenu(
            rect.left,
            // y 传「菜单底边」锚点：贴底的播放栏，菜单要向按钮上方展开（参考网易云）
            rect.top - 8,
            (Object.keys(qualityMeta) as IMusic.IQualityKey[]).map((q) => ({
                title: qualityMeta[q],
                // 勾选态与徽标同源：显示的是实际在播的档位（可能已被降级），不是配置值
                checked: q === badgeQuality,
                // 正在播的歌就地换源（进度保留）；没在播就只记设置，下次解析生效
                onClick: () => TrackPlayerSingleton.applyQuality(q),
            })),
            // 四个两字短项：紧凑变体宽度贴内容，不再撑到默认的 160px；勾选与文字间留 20px
            { above: true, compact: true, checkGap: true },
        );
    };

    const showRateMenu = (anchor: { left: number; top: number }) => {
        showContextMenu(
            anchor.left,
            // y 传「菜单底边」锚点：贴底的播放栏，菜单要向按钮上方展开（参考网易云）
            anchor.top - 8,
            RATE_OPTIONS.map((r) => ({
                title: r === 1 ? "1.0x（正常）" : formatRate(r),
                checked: Math.abs(r - rate) < 1e-6,
                onClick: () => TrackPlayerSingleton.setRate(r),
            })),
            { above: true, compact: true, checkGap: true },
        );
    };

    const showMoreMenu = (e: React.MouseEvent) => {
        // 阻止冒泡：context-menu 靠 window 的 click 关闭，不拦的话刚打开就会被这次点击关掉
        e.stopPropagation();
        const music = currentMusic;
        if (!music) {
            return;
        }
        const rect = e.currentTarget.getBoundingClientRect();
        const anchor = { left: rect.left, top: rect.top };
        showContextMenu(
            rect.left,
            rect.top - 8,
            [
                {
                    // 倍速收进这里：图标 + 当前档位（如「» 1.0x」），点开二级菜单就地换速
                    title: formatRate(rate),
                    icon: "forward",
                    onClick: () => showRateMenu(anchor),
                },
                {
                    title: "下载",
                    icon: "download",
                    onClick: () => showDownloadPanel([music]),
                },
                {
                    title: "收藏",
                    icon: "addToSheet",
                    onClick: () => showAddToSheetPanel(music),
                },
            ],
            // 贴底的播放栏：菜单向上展开；两项短文字，宽度贴内容
            { above: true, compact: true },
        );
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
                            size={60}
                            borderRadius={30}
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

                {/* 右：音质 / 喜欢 / 桌面歌词 / 翻译 / 音量 / 更多（倍速、下载、收藏收进更多菜单） */}
                <div className="playerbar-right">
                    {badgeQuality && (
                        <button
                            className={`playerbar-quality${qualitySwapping ? " swapping" : ""}`}
                            title={qualitySwapping ? "正在切换音质，缓冲完成后无缝接管" : "选择音质"}
                            onClick={showQualityMenu}
                        >
                            {qualityMeta[badgeQuality]}
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
                    {/* 桌面歌词开关（参考网易云「词ON」）：文字图标，开启时亮主色 + ON 角标 */}
                    <button
                        className={`playerbar-lyrics-toggle${lyricsVisible ? " on" : ""}`}
                        title={lyricsVisible ? "关闭桌面歌词" : "开启桌面歌词"}
                        onClick={() => toggleDesktopLyrics()}
                    >
                        词
                        {lyricsVisible && <span className="playerbar-lyrics-badge">ON</span>}
                    </button>
                    {/* 歌词翻译开关（与「词」同款）：默认关，开着才在播放详情页显示译文 */}
                    <button
                        className={`playerbar-lyrics-toggle${translationOn ? " on" : ""}`}
                        title={translationOn ? "关闭歌词翻译" : "开启歌词翻译"}
                        onClick={() => toggleLyricTranslation()}
                    >
                        文
                        {translationOn && <span className="playerbar-lyrics-badge">ON</span>}
                    </button>
                    {/* 音量：悬浮图标在上方弹出竖向音量面板（参考网易云）；
                        点击图标本身仍是静音开关，拖竖杆即时调音量 */}
                    <div className="playerbar-volume-entry">
                        <button
                            className="playerbar-control-btn"
                            title={muted ? "取消静音" : "静音"}
                            onClick={() => TrackPlayerSingleton.setVolume(muted ? DEFAULT_VOLUME : 0)}
                        >
                            <Icon name={muted ? "volumeMute" : "volume"} size={16} />
                        </button>
                        <div className="playerbar-volume-pop">
                            <Slider
                                vertical
                                className="playerbar-volume-slider"
                                value={volume}
                                max={1}
                                onChange={(v) => TrackPlayerSingleton.setVolume(v)}
                            />
                            <div className="playerbar-volume-value">
                                {Math.round(volume * 100)}%
                            </div>
                        </div>
                    </div>
                    {currentMusic && (
                        <button
                            className="playerbar-control-btn"
                            title="更多操作"
                            onClick={showMoreMenu}
                        >
                            <Icon name="more" size={16} />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
