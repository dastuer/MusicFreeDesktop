import React, { useEffect, useState } from "react";
import Cover from "@/components/base/Cover";
import Icon from "@/components/base/Icon";
import { getPluginsForAbility, tryPluginMethod } from "@/core/pluginUtils";
import { navigate } from "@/core/router";

/**
 * 排行榜页：
 * 页面头部 + 分组榜单网格（方形封面 + 底部渐变角标）
 * 默认音源优先，逐个降级尝试 + 超时 + 骨架屏 + 重试
 */

function SkeletonGrid() {
    return (
        <div className="card-grid">
            {Array.from({ length: 8 }).map((_, i) => (
                <div className="skeleton-card" key={i}>
                    <div className="square-cover" />
                    <div className="skeleton-line" />
                    <div className="skeleton-line short" />
                </div>
            ))}
        </div>
    );
}

export default function TopListPage() {
    const [groups, setGroups] = useState<IMusic.IMusicSheetGroupItem[]>([]);
    const [sourceName, setSourceName] = useState("");
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [noSource, setNoSource] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setFailed(false);
            setNoSource(false);
            const plugins = await getPluginsForAbility("getTopLists");
            if (cancelled) {
                return;
            }
            if (!plugins.length) {
                setNoSource(true);
                setLoading(false);
                return;
            }
            const result = await tryPluginMethod(plugins, "getTopLists");
            if (cancelled) {
                return;
            }
            if (result) {
                setGroups((result.data ?? []).filter((g: any) => g?.data?.length));
                setSourceName(result.pluginName);
            } else {
                setFailed(true);
            }
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [reloadKey]);

    return (
        <div>
            <div className="page-header">
                <div className="page-header-title">排行榜</div>
                <div className="page-header-sub">
                    {sourceName
                        ? `数据来源：${sourceName} · 点击榜单查看完整曲目`
                        : "权威榜单一览，数据来自已启用的音源插件"}
                </div>
            </div>

            {loading && <SkeletonGrid />}

            {!loading && noSource && (
                <div className="empty-hint">
                    没有支持排行榜的插件，安装音源插件后可浏览榜单
                    <div style={{ marginTop: 12 }}>
                        <button
                            className="btn-primary"
                            onClick={() => navigate("pluginManage")}
                        >
                            去安装插件
                        </button>
                    </div>
                </div>
            )}

            {!loading && failed && (
                <div className="empty-hint">
                    榜单加载失败（网络超时或插件不可用）
                    <div style={{ marginTop: 12 }}>
                        <button
                            className="btn-primary"
                            onClick={() => setReloadKey((k) => k + 1)}
                        >
                            <Icon name="forward" size={14} />
                            重新加载
                        </button>
                    </div>
                </div>
            )}

            {groups.map((group, gi) => (
                <section
                    className="home-section"
                    key={group.title || gi}
                >
                    <div className="section-title" style={{ fontSize: 17 }}>
                        {group.title || "榜单"}
                        <span
                            style={{
                                fontSize: 12,
                                fontWeight: 400,
                                color: "var(--text-tertiary)",
                            }}
                        >
                            {group.data.length} 个榜单
                        </span>
                    </div>
                    <div className="card-grid">
                        {group.data.map((item: any, idx: number) => (
                            <div
                                key={item.id}
                                className="media-card"
                                onClick={() =>
                                    navigate("topListDetail", { topListItem: item })
                                }
                            >
                                <div
                                    className="square-cover"
                                    style={{ position: "relative" }}
                                >
                                    <Cover
                                        src={item.artwork}
                                        size="100%"
                                        borderRadius={8}
                                        style={{ width: "100%", height: "100%" }}
                                    />
                                    <div className="toplist-badge">
                                        {item.description || item.updateFrequency || ""}
                                    </div>
                                    {idx < 3 && (
                                        <div
                                            style={{
                                                position: "absolute",
                                                top: 6,
                                                left: 6,
                                                width: 22,
                                                height: 22,
                                                borderRadius: 6,
                                                background: "var(--primary-color)",
                                                color: "#fff",
                                                fontSize: 12,
                                                fontWeight: 700,
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "center",
                                            }}
                                        >
                                            {idx + 1}
                                        </div>
                                    )}
                                </div>
                                <div className="media-card-title">{item.title}</div>
                            </div>
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}
