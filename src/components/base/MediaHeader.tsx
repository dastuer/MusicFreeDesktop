import React from "react";
import Cover from "./Cover";
import Icon from "./Icon";
import { showAddToSheetPanel } from "./AddToSheetPanel";
import { showContextMenu, IContextMenuItem } from "./ContextMenu";
import { TrackPlayerSingleton } from "@/core/trackPlayer";

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
    /**
     * 「我的歌单」内容页隐藏「收藏全部」。
     * 列表本身就是自己的收藏结果，再「收藏全部」既没意义又容易点错；
     * 插件歌单 / 专辑 / 榜单这些来源列表仍保留，方便一键收下整张。
     */
    hideFavoriteAll?: boolean;
    /** 这份列表的稳定标识，与 `MusicList` 的 `listId` 传同一个值：「播放全部」据此判断队列是否已经是这份列表 */
    listId?: string;
    /** 尾部「…」按钮的下拉菜单项（如「多选」）：传了才显示按钮 */
    moreMenuItems?: IContextMenuItem[];
}) {
    const {
        artwork,
        title,
        meta,
        description,
        musicList,
        extraActions,
        hideFavoriteAll,
        listId,
        moreMenuItems,
    } = props;

    /** 「收藏全部」：和多选「收藏」走同一条路 —— 先选歌单，再把整张收进去 */
    const favoriteAll = () => {
        if (!musicList.length) {
            return;
        }
        showAddToSheetPanel(musicList);
    };

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
                                    TrackPlayerSingleton.pickPlayAllStart(musicList),
                                    musicList,
                                    listId,
                                    // 「播放全部」是明确指令：一律重新铺一遍这份列表
                                    true,
                                );
                            }
                        }}
                    >
                        <Icon name="play" size={14} />
                        播放全部
                    </button>
                    {!hideFavoriteAll && (
                        <button
                            className="btn-ghost"
                            disabled={!musicList.length}
                            onClick={favoriteAll}
                        >
                            <Icon name="heartFilled" size={14} />
                            收藏全部
                        </button>
                    )}
                    {extraActions}
                    {!!moreMenuItems?.length && (
                        <button
                            className="btn-ghost media-header-more"
                            title="更多操作"
                            onClick={(e) => {
                                // 阻止冒泡：context-menu 靠 window 的 click 关闭，不拦的话刚打开就会被这次点击关掉
                                e.stopPropagation();
                                const rect = e.currentTarget.getBoundingClientRect();
                                showContextMenu(rect.left, rect.bottom + 8, moreMenuItems);
                            }}
                        >
                            <Icon name="more" size={16} />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
