import Icon from "./Icon";
import { IMatchSessionView } from "@/core/neteaseMatchSession";

/**
 * 匹配进行中的整体动效面板：与单曲无关，占住列表区域——
 * 旋转唱片（外弧 + 呼吸内圈）+ 流光进度条 + 实时计数，
 * 匹配完成后页面用完整列表一次性替换它（列表侧 fade-in）。
 * loading 阶段（拉曲目）进度条为 0 但唱片照转。
 */
export default function NeteaseMatchingPanel(props: { view: IMatchSessionView }) {
    const { view } = props;
    const pct = view.total ? Math.round((view.done / view.total) * 100) : 0;
    return (
        <div className="netease-matching-panel">
            <div className="netease-matching-disc">
                <Icon name="musicNote" size={26} />
            </div>
            <div className="netease-matching-title">
                {view.status === "loading"
                    ? "正在获取歌单全量曲目…"
                    : "正在用已启用的音源逐首匹配"}
            </div>
            <div className="netease-progress">
                <div style={{ width: `${pct}%` }} />
            </div>
            <div className="netease-matching-sub">
                {view.status === "loading"
                    ? "曲目就绪后自动开始匹配"
                    : `${view.cachedCount > 0 ? `缓存命中 ${view.cachedCount} · ` : ""}已处理 ${view.done}/${view.total}，命中 ${view.matchedCount}`}
            </div>
        </div>
    );
}
