import Icon from "./Icon";
import { IMatchSessionView } from "@/core/neteaseMatchSession";

/**
 * 匹配进行中的紧凑状态条：贴在列表骨架屏上方，替换掉原来的居中大面板——
 * 大面板完成时被整个列表替换会上下顶开页面，紧凑条 + 等高骨架行让
 * 「骨架 → 真实列表」原地切换、页面高度基本不动。
 * loading 阶段（拉曲目）进度为 0 但转圈照转。
 */
export default function NeteaseMatchingPanel(props: { view: IMatchSessionView }) {
    const { view } = props;
    const pct = view.total ? Math.round((view.done / view.total) * 100) : 0;
    const loading = view.status === "loading";
    return (
        <div className="netease-matching-strip" role="status">
            <span className={`netease-matching-spin${loading ? " slow" : ""}`} aria-hidden>
                <Icon name="musicNote" size={13} />
            </span>
            <div className="netease-matching-text">
                <span className="netease-matching-title">
                    {loading ? "正在获取曲目…" : "正在用已启用的音源逐首匹配"}
                </span>
                <span className="netease-matching-sub">
                    {loading
                        ? "曲目就绪后自动开始匹配"
                        : view.cachedCount > 0
                          ? `缓存命中 ${view.cachedCount} · 已处理 ${view.done}/${view.total}，命中 ${view.matchedCount}`
                          : `已处理 ${view.done}/${view.total}，命中 ${view.matchedCount}`}
                </span>
            </div>
            <div className="netease-progress">
                <div style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}
