import React from "react";
import MusicDetailLyricPage from "./MusicDetailLyricPage";
import MusicDetailCommentPage from "./MusicDetailCommentPage";
import { useCurrentMusic } from "@/core/trackPlayer";

/**
 * 正在播放页容器（网易云桌面端式）：容纳两个独立整页页面——
 * 歌词页（MusicDetailLyricPage）与评论页（MusicDetailCommentPage）。
 *
 * 容器本身只负责堆叠与上下滑动切换（.music-detail-views / .music-detail-view），
 * 页面的内容与内部交互都在各自文件里。顶部歌曲胶囊从评论页切回歌词页，
 * 底部播放条保持可见。
 */
export type MusicDetailView = "lyric" | "comment";

export default function MusicDetailOverlay(props: {
    visible: boolean;
    view: MusicDetailView;
    onViewChange: (view: MusicDetailView) => void;
    onClose: () => void;
}) {
    const { visible, view, onViewChange, onClose } = props;
    const currentMusic = useCurrentMusic();

    // 收起时不卸载：组件常驻挂载，靠 .open 类切换 transform 过渡，
    // 展开/收起才有完整的整页上移/下移动画（卸载式显隐只能做入场）
    if (!currentMusic) {
        return null;
    }

    return (
        <div className={`music-detail-overlay${visible ? " open" : ""}`}>
            <div className="music-detail-views">
                <MusicDetailLyricPage
                    visible={visible}
                    active={view === "lyric"}
                    onClose={onClose}
                />
                <MusicDetailCommentPage
                    visible={visible}
                    active={view === "comment"}
                    onBackToLyric={() => onViewChange("lyric")}
                    onClose={onClose}
                />
            </div>
        </div>
    );
}
