import React, { useEffect, useRef, useState } from "react";
import Cover from "@/components/base/Cover";
import Icon from "@/components/base/Icon";
import {
    getPluginsForAbility,
    tryPluginMethod,
} from "@/core/pluginUtils";
import { navigate } from "@/core/router";

/**
 * 发现音乐（首页）：推荐歌单 + 排行榜
 * 默认音源优先，逐个降级尝试 + 超时控制，失败可重试，显示数据来源
 */

interface ISheetCard {
    id: string;
    platform: string;
    title: string;
    artwork: string;
    playCount?: number;
}

export default function HomePage() {
    const [tags, setTags] = useState<ICommon.IUnique[]>([]);
    const [activeTag, setActiveTag] = useState<ICommon.IUnique | null>(null);
    const [sheets, setSheets] = useState<ISheetCard[]>([]);
    const [topLists, setTopLists] = useState<IMusic.IMusicSheetGroupItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [hasSource, setHasSource] = useState(true);
    const [reloadKey, setReloadKey] = useState(0);
    const [tagSource, setTagSource] = useState("");
    const [topListSource, setTopListSource] = useState("");
    const activeTagIdRef = useRef<string>("");

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setFailed(false);

            // 两个区块并行加载
            const [sheetPlugins, topListPlugins] = await Promise.all([
                getPluginsForAbility("getRecommendSheetTags"),
                getPluginsForAbility("getTopLists"),
            ]);
            if (cancelled) {
                return;
            }
            setHasSource(sheetPlugins.length > 0 || topListPlugins.length > 0);

            const [tagResult, topListResult] = await Promise.all([
                tryPluginMethod(sheetPlugins, "getRecommendSheetTags"),
                tryPluginMethod(topListPlugins, "getTopLists"),
            ]);
            if (cancelled) {
                return;
            }

            if (tagResult) {
                setTagSource(tagResult.pluginName);
                const data = tagResult.data?.data ?? [];
                const pinned = tagResult.data?.pinned ?? [];
                const firstGroup = data[0]?.data ?? [];
                const merged = [...pinned, ...firstGroup].slice(0, 12);
                setTags(merged);
                if (merged.length) {
                    activeTagIdRef.current = merged[0].id;
                    setActiveTag(merged[0]);
                }
            }
            if (topListResult) {
                setTopListSource(topListResult.pluginName);
                setTopLists((topListResult.data ?? []).slice(0, 2));
            }

            const allFailed = !tagResult && !topListResult;
            setFailed(allFailed && (sheetPlugins.length > 0 || topListPlugins.length > 0));
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [reloadKey]);

    useEffect(() => {
        if (!activeTag) {
            return;
        }
        let cancelled = false;
        (async () => {
            const sheetPlugins = await getPluginsForAbility("getRecommendSheetsByTag");
            if (cancelled) {
                return;
            }
            const result = await tryPluginMethod(
                sheetPlugins,
                "getRecommendSheetsByTag",
                12000,
                activeTag,
                1,
            );
            if (cancelled) {
                return;
            }
            if (result) {
                setTagSource(result.pluginName);
            }
            setSheets((result?.data?.data ?? []).slice(0, 18));
        })();
        return () => {
            cancelled = true;
        };
    }, [activeTag?.id]);

    return (
        <div>
            {!hasSource && !loading && (
                <div className="empty-hint">
                    尚未安装音源插件，请前往「音源插件」安装后体验完整功能
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

            {loading && <div className="loading-hint">加载中…</div>}

            {!loading && failed && (
                <div className="empty-hint">
                    音源加载失败（网络超时或插件不可用）
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

            {!loading && !failed && tags.length > 1 && (
                <section className="home-section">
                    <div className="section-title">
                        推荐歌单
                        {tagSource && (
                            <span
                                style={{
                                    fontSize: 12,
                                    fontWeight: 400,
                                    color: "var(--text-tertiary)",
                                }}
                            >
                                数据来源：{tagSource}
                            </span>
                        )}
                    </div>
                    <div
                        style={{
                            display: "flex",
                            gap: 8,
                            flexWrap: "wrap",
                            margin: "0 0 16px",
                        }}
                    >
                        {tags.map((tag) => (
                            <button
                                key={tag.id}
                                className={`search-tab${activeTag?.id === tag.id ? " active" : ""}`}
                                onClick={() => setActiveTag(tag)}
                            >
                                {(tag as any).title}
                            </button>
                        ))}
                    </div>
                    {sheets.length > 0 && (
                        <div className="card-grid">
                            {sheets.map((sheet) => (
                                <div
                                    key={sheet.id}
                                    className="media-card"
                                    onClick={() =>
                                        navigate("sheetDetail", {
                                            sheetItem: {
                                                ...sheet,
                                                platform: (sheet as any).platform,
                                            },
                                        })
                                    }
                                >
                                    <div className="square-cover">
                                        <Cover
                                            src={sheet.artwork}
                                            size="100%"
                                            borderRadius={8}
                                            style={{ width: "100%", height: "100%" }}
                                        />
                                    </div>
                                    <div className="media-card-title">{sheet.title}</div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            )}

            {!loading &&
                topLists.map((group, gi) => (
                    <section
                        className="home-section"
                        key={group.title || group.data?.[0]?.id || gi}
                    >
                        <div className="section-title">
                            排行榜{group.title ? ` · ${group.title}` : ""}
                            {topListSource && (
                                <span
                                    style={{
                                        fontSize: 12,
                                        fontWeight: 400,
                                        color: "var(--text-tertiary)",
                                    }}
                                >
                                    数据来源：{topListSource}
                                </span>
                            )}
                        </div>
                        <div className="card-grid">
                            {group.data.slice(0, 8).map((item: any) => (
                                <div
                                    key={item.id}
                                    className="media-card"
                                    onClick={() =>
                                        navigate("topListDetail", { topListItem: item })
                                    }
                                >
                                    <div className="square-cover">
                                        <Cover
                                            src={item.artwork}
                                            size="100%"
                                            borderRadius={8}
                                            style={{ width: "100%", height: "100%" }}
                                        />
                                    </div>
                                    <div className="media-card-title">{item.title}</div>
                                    {item.description && (
                                        <div
                                            className="media-card-subtitle"
                                            style={{
                                                overflow: "hidden",
                                                display: "-webkit-box",
                                                WebkitLineClamp: 1,
                                                WebkitBoxOrient: "vertical",
                                            }}
                                        >
                                            {item.description}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </section>
                ))}
        </div>
    );
}
