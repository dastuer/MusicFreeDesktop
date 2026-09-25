import React, { useCallback, useEffect, useRef, useState } from "react";
import MusicList from "@/components/base/MusicList";
import Cover from "@/components/base/Cover";
import { getSortedSearchablePlugins, pluginCall, SerializedPlugin } from "@/core/ipc";
import { uniqueById } from "@/core/collections";
import { navigate } from "@/core/router";
import { usePagedMusicList } from "@/hooks/usePagedMusicList";

/**
 * 搜索页：音乐/歌单/专辑/歌手 四个 tab，可切换音源插件
 *
 * - 单曲：走 usePagedMusicList，按「每页 N 条」展示（默认 40，可切换），
 *   翻到还没拉到的页时自动继续向音源要下一页；
 * - 歌单/专辑/歌手：音源一次返回一屏卡片，不分页。
 */

const searchTabs: { key: string; label: string }[] = [
    { key: "music", label: "单曲" },
    { key: "sheet", label: "歌单" },
    { key: "album", label: "专辑" },
    { key: "artist", label: "歌手" },
];

/** 每页条数偏好按列表分开记忆（与歌单详情各存一份） */
const SEARCH_PAGE_SIZE_KEY = "pagedList.pageSize.searchMusic";
const SEARCH_DEFAULT_PAGE_SIZE = 40;

interface ISearchPageProps {
    query?: string;
    initialType?: string;
    refresh?: number;
}

export default function SearchPage(props: ISearchPageProps) {
    const { query: initialQuery } = props;
    const [query, setQuery] = useState(initialQuery ?? "");
    /** 已生效的搜索词：单曲分页按它重置，卡片网格按它判断空态 */
    const [searchedQuery, setSearchedQuery] = useState("");
    const [type, setType] = useState<string>(props.initialType ?? "music");
    const [plugin, setPlugin] = useState<SerializedPlugin | null>(null);
    const [plugins, setPlugins] = useState<SerializedPlugin[]>([]);
    /** 歌单/专辑/歌手 的卡片结果 */
    const [results, setResults] = useState<any[]>([]);
    const [cardLoading, setCardLoading] = useState(false);

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

    const doCardSearch = useCallback(
        async (q: string, searchType: string) => {
            if (!q.trim() || !plugin) {
                return;
            }
            setCardLoading(true);
            try {
                const result = await pluginCall(plugin.hash, "search", q, 1, searchType);
                setResults(result?.data ?? []);
            } catch (e: any) {
                setResults([]);
                console.warn("[search]", e?.message);
            }
            setCardLoading(false);
        },
        [plugin],
    );

    /** 单曲分页的数据源：音源的 page 是页码，每页条数由展示层决定 */
    const fetchMusicPage = useCallback(
        async (page: number) => {
            // 只在「单曲」tab 发请求：其它 tab 下 hook 会重置，但不需要联网
            if (type !== "music" || !searchedQuery.trim() || !plugin) {
                return { items: [] as IMusic.IMusicItem[], isEnd: true };
            }
            const result = await pluginCall(
                plugin.hash,
                "search",
                searchedQuery,
                page,
                "music",
            );
            return {
                items: (result?.data ?? []) as IMusic.IMusicItem[],
                isEnd: result?.isEnd ?? true,
            };
        },
        [type, searchedQuery, plugin],
    );

    const musicList = usePagedMusicList<IMusic.IMusicItem>({
        fetchPage: fetchMusicPage,
        defaultPageSize: SEARCH_DEFAULT_PAGE_SIZE,
        storageKey: SEARCH_PAGE_SIZE_KEY,
        resetKey: `${searchedQuery}|${type}|${plugin?.hash ?? ""}|${props.refresh ?? 0}`,
    });

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
        // 单曲列表由 usePagedMusicList 按 searchedQuery / type 重置，这里不用手动拉
        setSearchedQuery(q);
        if (type !== "music") {
            doCardSearch(q, type);
        }
    }, [initialQuery, type, plugin?.hash, props.refresh, doCardSearch]);

    const renderResults = () => {
        if (!searchedQuery) {
            return null;
        }
        if (type === "music") {
            return (
                <MusicList
                    musicList={musicList.items}
                    loading={musicList.loading}
                    listId={`search:${searchedQuery}:${plugin?.hash ?? ""}`}
                    pagination={{
                        currentPage: musicList.currentPage,
                        totalPages: musicList.totalPages,
                        pageSize: musicList.pageSize,
                        pageSizeOptions: musicList.pageSizeOptions,
                        hasMore: musicList.hasMore,
                        stalled: musicList.stalled,
                        loadingMore: musicList.loadingMore,
                        onPageChange: musicList.goToPage,
                        onPageSizeChange: musicList.changePageSize,
                    }}
                />
            );
        }

        if (cardLoading && !results.length) {
            return <div className="loading-hint">搜索中…</div>;
        }

        // 音源返回的卡片列表常带重复条目，先去重，顺带把 React key 变得稳定
        const cards = uniqueById(results);
        // 卡片 key：同一批结果里 id 可能缺失或重复，补上序号兜底
        const cardKey = (item: any, index: number) =>
            `${item.platform ?? ""}-${item.id ?? "x"}-${index}`;

        if (type === "sheet" || type === "album") {
            return (
                <div className="card-grid">
                    {cards.map((item: any, index: number) => (
                        <div
                            key={cardKey(item, index)}
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
                            {/*
                             * 封面必须放在有确定高度的容器里。
                             * `Cover` 的 size="100%" 会同时写上 width/height:100%，而网格项默认被拉伸到
                             * 整行高度，height:100% 于是按「行高」解析 -> 封面被压成非正方的矩形，
                             * 标题再往下排就溢出卡片、盖到下一行的封面上。
                             */}
                            <div className="square-cover">
                                <Cover
                                    src={item.artwork}
                                    size="100%"
                                    borderRadius={8}
                                    style={{ width: "100%", height: "100%" }}
                                />
                            </div>
                            <div className="media-card-title">{item.title}</div>
                        </div>
                    ))}
                    {!results.length && !cardLoading && (
                        <div className="empty-hint">没有找到相关内容</div>
                    )}
                </div>
            );
        }
        // artist
        return (
            <div className="card-grid artist-grid">
                {cards.map((item: any, index: number) => (
                    <div
                        key={cardKey(item, index)}
                        className="media-card artist-card"
                        onClick={() => navigate("artistDetail", { artistItem: item })}
                    >
                        {/* 圆形头像同样需要确定的正方形高度，否则会被行高拉成椭圆 */}
                        <div className="artist-avatar">
                            <Cover
                                src={item.avatar}
                                size="100%"
                                borderRadius="50%"
                                style={{ width: "100%", height: "100%" }}
                            />
                        </div>
                        <div className="media-card-title artist-name">{item.name}</div>
                    </div>
                ))}
                {!results.length && !cardLoading && (
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
