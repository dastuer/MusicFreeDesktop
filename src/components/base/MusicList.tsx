import React, { useMemo } from "react";
import Cover from "./Cover";
import Icon from "./Icon";
import { showContextMenu } from "./ContextMenu";
import { showAddToSheetPanel } from "./AddToSheetPanel";
import { showDownloadPanel } from "./DownloadPanel";
import { TrackPlayerSingleton, useCurrentMusic } from "@/core/trackPlayer";
import { navigate } from "@/core/router";
import { isLiked, toggleLike } from "@/core/musicSheet";
import { showToast } from "./Toast";

/**
 * 歌曲列表（桌面端表格形态）：序号 / 封面+标题 / 歌手 / 专辑 / 时长
 * 支持双击播放、右键菜单
 */

function formatDuration(seconds?: number) {
    if (!seconds || !Number.isFinite(seconds)) {
        return "-:--";
    }
    const min = Math.floor(seconds / 60);
    const sec = Math.round(seconds % 60);
    return `${min}:${sec.toString().padStart(2, "0")}`;
}

interface IMusicListProps {
    musicList: IMusic.IMusicItem[];
    /** 是否显示封面列（网格行样式） */
    showIndex?: boolean;
    onLoadMore?: () => void;
    isEnd?: boolean;
    loading?: boolean;
    className?: string;
    renderHeader?: React.ReactNode;
    /** 传入后在右键菜单中出现「从歌单中移除」 */
    onRemove?: (musicItem: IMusic.IMusicItem) => void;
    /** 喜欢/移除等操作后的回调（页面刷新用） */
    onMusicChanged?: () => void;
}

export default function MusicList(props: IMusicListProps) {
    const {
        musicList,
        onLoadMore,
        isEnd = true,
        loading = false,
        className,
        onRemove,
        onMusicChanged,
    } = props;
    const currentMusic = useCurrentMusic();

    const openMenu = async (e: React.MouseEvent, musicItem: IMusic.IMusicItem) => {
        e.preventDefault();
        e.stopPropagation();
        const items: {
            title: string;
            icon?: string;
            danger?: boolean;
            onClick: () => void | Promise<void>;
        }[] = [
            {
                title: (await isLiked(musicItem)) ? "取消喜欢" : "喜欢",
                icon: "heart",
                onClick: async () => {
                    const liked = await toggleLike(musicItem);
                    showToast(liked ? "已添加到我喜欢的音乐" : "已取消喜欢");
                    onMusicChanged?.();
                },
            },
            {
                title: "下一首播放",
                icon: "forward",
                onClick: () => {
                    TrackPlayerSingleton.addNext(musicItem);
                    showToast("已添加到下一首播放");
                },
            },
            {
                title: "添加到播放列表",
                icon: "plus",
                onClick: () => {
                    TrackPlayerSingleton.add(musicItem);
                    showToast("已添加到播放列表");
                },
            },
            {
                title: "收藏到歌单",
                icon: "playQueue",
                onClick: () => showAddToSheetPanel(musicItem),
            },
            {
                title: "下载",
                icon: "download",
                onClick: () => showDownloadPanel([musicItem]),
            },
        ];

        if (onRemove) {
            items.push({
                title: "从歌单中移除",
                icon: "close",
                danger: true,
                onClick: () => onRemove(musicItem),
            });
        }

        if (musicItem.album) {
            items.push({
                title: "查看专辑",
                icon: "musicNote",
                onClick: () =>
                    navigate("albumDetail", { albumItem: musicItem as any }),
            });
        }
        if (musicItem.localPath) {
            items.push({
                title: "复制文件路径",
                icon: "localMusic",
                onClick: () => {
                    navigator.clipboard.writeText(musicItem.localPath!);
                    showToast("已复制文件路径");
                },
            });
        }
        showContextMenu(e.clientX, e.clientY, items);
    };

    return (
        <div className={`music-list ${className ?? ""}`}>
            <div className="music-list-header">
                <div style={{ textAlign: "center" }}>#</div>
                <div>标题</div>
                <div>歌手</div>
                <div>专辑</div>
                <div style={{ textAlign: "right" }}>时长</div>
            </div>
            {musicList.map((musicItem, index) => {
                const playing = TrackPlayerSingleton.isCurrentMusic(musicItem);
                return (
                    <div
                        key={`${musicItem.platform}-${musicItem.id}-${index}`}
                        className={`music-row${playing ? " playing" : ""}`}
                        onDoubleClick={() => TrackPlayerSingleton.play(musicItem, true)}
                        onClick={() => TrackPlayerSingleton.play(musicItem)}
                        onContextMenu={(e) => openMenu(e, musicItem)}
                    >
                        <div className="music-row-index">
                            {playing ? (
                                <Icon name="musicNote" size={14} style={{ color: "var(--primary-color)" }} />
                            ) : (
                                index + 1
                            )}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                            <Cover src={musicItem.artwork} size={32} borderRadius={4} />
                            <span className="music-row-title">
                                {musicItem.title}
                                {musicItem.alias && (
                                    <span className="music-row-alias">（{musicItem.alias}）</span>
                                )}
                            </span>
                        </div>
                        <div className="music-row-artist">{musicItem.artist}</div>
                        <div className="music-row-album">{musicItem.album}</div>
                        <div className="music-row-duration">
                            {formatDuration(musicItem.duration)}
                        </div>
                    </div>
                );
            })}
            {loading && <div className="loading-hint">加载中…</div>}
            {!loading && !isEnd && onLoadMore && (
                <div
                    className="loading-hint"
                    style={{ cursor: "pointer" }}
                    onClick={onLoadMore}
                >
                    加载更多
                </div>
            )}
            {!loading && !musicList.length && (
                <div className="empty-hint">这里空空如也</div>
            )}
        </div>
    );
}
