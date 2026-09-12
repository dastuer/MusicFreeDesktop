import React, { useEffect, useRef, useState } from "react";
import MusicList from "@/components/base/MusicList";
import Cover from "@/components/base/Cover";
import {
    getSortedPluginsWithAbility,
    getSortedSearchablePlugins,
    pluginCall,
    SerializedPlugin,
} from "@/core/ipc";
import { navigate } from "@/core/router";
import { TrackPlayerSingleton } from "@/core/trackPlayer";

/**
 * 搜索页：音乐/歌单/专辑/歌手 四个 tab，可切换音源插件
 */

const searchTabs: { key: string; label: string }[] = [
    { key: "music", label: "单曲" },
    { key: "sheet", label: "歌单" },
    { key: "album", label: "专辑" },
    { key: "artist", label: "歌手" },
];

interface ISearchPageProps {
    query?: string;
    initialType?: string;
    refresh?: number;
}

export default function SearchPage(props: ISearchPageProps) {
    const { query: initialQuery } = props;
    const [query, setQuery] = useState(initialQuery ?? "");
    const [searchedQuery, setSearchedQuery] = useState("");
    const [type, setType] = useState<string>(props.initialType ?? "music");
    const [plugin, setPlugin] = useState<SerializedPlugin | null>(null);
    const [plugins, setPlugins] = useState<SerializedPlugin[]>([]);
    const [results, setResults] = useState<any[]>([]);
    const [page, setPage] = useState(1);
    const [isEnd, setIsEnd] = useState(true);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        getSortedSearchablePlugins().then((list: SerializedPlugin[]) => {
            setPlugins(list);
            setPlugin((prev: SerializedPlugin | null) =>
                prev && list.some((p: SerializedPlugin) => p.hash === prev.hash)
                    ? prev
                    : list[0] ?? null,
            );
        });
    }, []);

    const doSearch = async (q: string, searchType: string, searchPage: number, append: boolean) => {
        if (!q.trim() || !plugin) {
            return;
        }
        setLoading(true);
        try {
            const result = await pluginCall(plugin.hash, "search", q, searchPage, searchType);
            const data = result?.data ?? [];
            setResults((prev) => (append ? [...prev, ...data] : data));
            setIsEnd(result?.isEnd ?? true);
            setPage(searchPage);
            setSearchedQuery(q);
        } catch (e: any) {
            if (!append) {
                setResults([]);
            }
            console.warn("[search]", e?.message);
        }
        setLoading(false);
    };

    // 触发搜索：（关键词, 类型, 插件, refresh）任一变化即重新搜索
    const lastSearchRef = useRef("");
    useEffect(() => {
        const q = initialQuery;
        if (!q || !plugin) {
            return;
        }
        const sig = `${q}|${type}|${plugin.hash}|${props.refresh ?? 0}`;
        if (sig === lastSearchRef.current) {
            return;
        }
        lastSearchRef.current = sig;
        setQuery(q);
        setResults([]);
        setIsEnd(true);
        doSearch(q, type, 1, false);
    }, [initialQuery, type, plugin?.hash, props.refresh]);

    const renderResults = () => {
        if (loading && !results.length) {
            return <div className="loading-hint">搜索中…</div>;
        }
        if (type === "music") {
            return (
                <MusicList
                    musicList={results as IMusic.IMusicItem[]}
                    isEnd={isEnd}
                    loading={loading}
                    onLoadMore={() => doSearch(searchedQuery, type, page + 1, true)}
                />
            );
        }
        if (type === "sheet" || type === "album") {
            return (
                <div className="card-grid">
                    {results.map((item: any) => (
                        <div
                            key={item.id}
                            className="media-card"
                            onClick={() =>
                                item.platform !== undefined &&
                                navigate(
                                    type === "sheet" ? "sheetDetail" : "albumDetail",
                                    type === "sheet"
                                        ? { sheetItem: item }
                                        : { albumItem: item },
                                )
                            }
                        >
                            <Cover src={item.artwork} size="100%" borderRadius={8} />
                            <div className="media-card-title">{item.title}</div>
                        </div>
                    ))}
                    {!results.length && !loading && searchedQuery && (
                        <div className="empty-hint">没有找到相关内容</div>
                    )}
                </div>
            );
        }
        // artist
        return (
            <div className="card-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))" }}>
                {results.map((item: any) => (
                    <div
                        key={item.id}
                        className="media-card"
                        style={{ textAlign: "center" }}
                        onClick={() => navigate("artistDetail", { artistItem: item })}
                    >
                        <Cover
                            src={item.avatar}
                            size="100%"
                            borderRadius="50%"
                            style={{ aspectRatio: "1" }}
                        />
                        <div className="media-card-title" style={{ textAlign: "center" }}>
                            {item.name}
                        </div>
                    </div>
                ))}
                {!results.length && !loading && searchedQuery && (
                    <div className="empty-hint">没有找到相关内容</div>
                )}
            </div>
        );
    };

    return (
        <div>
            <div className="section-title" style={{ marginTop: 8 }}>
                搜索
                {plugins.length > 0 && (
                    <select
                        className="segment"
                        style={{ border: "none", outline: "none", color: "var(--text-color)" }}
                        value={plugin?.hash ?? ""}
                        onChange={(e) => {
                            const p = plugins.find((it) => it.hash === e.target.value);
                            setPlugin(p ?? null);
                            setResults([]);
                            setIsEnd(true);
                            if (searchedQuery) {
                                setSearchedQuery("");
                            }
                        }}
                    >
                        {plugins.map((p) => (
                            <option key={p.hash} value={p.hash} style={{ color: "#333" }}>
                                {p.name}
                            </option>
                        ))}
                    </select>
                )}
            </div>

            <div className="search-tabs">
                {searchTabs.map((tab) => (
                    <button
                        key={tab.key}
                        className={`search-tab${type === tab.key ? " active" : ""}`}
                        onClick={() => {
                            setType(tab.key);
                            setResults([]);
                            setIsEnd(true);
                            if (searchedQuery) {
                                doSearch(searchedQuery, tab.key, 1, false);
                            }
                        }}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            {!searchedQuery && (
                <div className="empty-hint">
                    {plugins.length
                        ? "在上方搜索框输入关键词开始搜索"
                        : "没有可用的搜索插件，请先在「音源插件」中安装并启用"}
                </div>
            )}
            {renderResults()}
        </div>
    );
}
