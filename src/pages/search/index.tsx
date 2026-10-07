import React, { useCallback, useEffect, useRef, useState } from "react";
import MusicList from "@/components/base/MusicList";
import Cover from "@/components/base/Cover";
import { getSortedSearchablePlugins, pluginCall, SerializedPlugin } from "@/core/ipc";
import { getSearchSource, setSearchSource } from "@/core/mediaSource";
import { uniqueById } from "@/core/collections";
import { navigate, onRouteDiscarded, useCurrentRoute } from "@/core/router";
import { IPagedSnapshot, usePagedMusicList } from "@/hooks/usePagedMusicList";
import { showToast } from "@/components/base/Toast";

/**
 * 搜索页：音乐/歌单/专辑/歌手 四个 tab，可切换音源插件
 *
 * - 单曲：走 usePagedMusicList 的无限滚动模式——一次铺一屏的量（每批 40 条，
 *   可按历史偏好），滚到底部自动向音源续拉，不再有点页码的分页器；
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

/**
 * 搜索页现场快照：主内容区按路由条目整体重挂载（见 App.tsx），从歌单/专辑/歌手
 * 详情页返回时组件状态全丢、还会重新联网搜索，滚动位置也因内容空了而恢复不回去。
 * 这里按路由条目 id 把现场存下来，返回时原样还原（滚动位置由 scrollMemory 恢复）；
 * 条目被路由栈截断丢弃时快照跟着清掉（onRouteDiscarded），不会无限增长。
 */
interface ISearchPageSnapshot {
    type: string;
    searchedQuery: string;
    results: any[];
    plugin: SerializedPlugin | null;
    /** 搜索是否已尘埃落定；false = 请求还在半路就离开了，返回时应该重新搜 */
    settled: boolean;
    /** 单曲分页的恢复快照（仅单曲 tab 且不在首屏加载中才有） */
    paged?: IPagedSnapshot<IMusic.IMusicItem>;
}

const snapshots = new Map<number, ISearchPageSnapshot>();
onRouteDiscarded((routeId) => snapshots.delete(routeId));

interface ISearchPageProps {
    query?: string;
    initialType?: string;
    refresh?: number;
}

export default function SearchPage(props: ISearchPageProps) {
    const { query: initialQuery } = props;
    const routeId = useCurrentRoute().id;

    // 只在挂载那一刻读一次快照，之后它对组件行为没有影响
    const restoredRef = useRef<ISearchPageSnapshot | null | undefined>(undefined);
    if (restoredRef.current === undefined) {
        restoredRef.current = snapshots.get(routeId) ?? null;
    }
    const restored = restoredRef.current;

    const [query, setQuery] = useState(initialQuery ?? "");
    /** 已生效的搜索词：单曲分页按它重置，卡片网格按它判断空态 */
    const [searchedQuery, setSearchedQuery] = useState(restored?.searchedQuery ?? "");
    const [type, setType] = useState<string>(restored?.type ?? props.initialType ?? "music");
    const [plugin, setPlugin] = useState<SerializedPlugin | null>(restored?.plugin ?? null);
    const [plugins, setPlugins] = useState<SerializedPlugin[]>([]);
    /** 歌单/专辑/歌手 的卡片结果 */
    const [results, setResults] = useState<any[]>(restored?.results ?? []);
    const [cardLoading, setCardLoading] = useState(false);

    useEffect(() => {
        getSortedSearchablePlugins().then((list: SerializedPlugin[]) => {
            setPlugins(list);
            // 优先级：本页快照还原的插件 > 上次选用的音源（重启后恢复） > 默认音源。
            // 记录里的插件已被卸载/禁用时回落默认音源，并提示一句（与 SourceSwitcher 一致）
            const remembered = getSearchSource();
            const rememberedPlugin = remembered
                ? list.find((p) => p.hash === remembered)
                : undefined;
            setPlugin((prev: SerializedPlugin | null) =>
                prev && list.some((p: SerializedPlugin) => p.hash === prev.hash)
                    ? prev
                    : rememberedPlugin ?? list[0] ?? null,
            );
            if (remembered && !rememberedPlugin) {
                showToast("上次选择的音源已不可用，已改用默认音源");
            }
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
        initial: restored?.paged,
    });

    // 触发搜索：（关键词, 类型, 插件, refresh）任一变化即重新搜索。
    // 从快照还原且离开时搜索已完成的话预填签名——返回不该再拉一遍；
    // 离开时请求还在半路就不预填，让 effect 自然重搜。
    const lastSearchRef = useRef(
        restored?.settled
            ? `${initialQuery}|${restored.type}|${restored.plugin?.hash ?? ""}|${props.refresh ?? 0}`
            : "",
    );
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

    // 每次渲染后把现场写进快照：离开页面（卸载）那一刻快照就是最后一次渲染的状态
    useEffect(() => {
        const paged: IPagedSnapshot<IMusic.IMusicItem> | undefined =
            type === "music" && !musicList.loading
                ? {
                      items: musicList.items,
                      currentPage: musicList.currentPage,
                      pageSize: musicList.pageSize,
                      isEnd: musicList.isEnd,
                      stalled: musicList.stalled,
                      sourcePage: musicList.sourcePage,
                  }
                : undefined;
        snapshots.set(routeId, {
            type,
            searchedQuery,
            results,
            plugin,
            settled: type === "music" ? !musicList.loading : !cardLoading,
            paged,
        });
    });

    const renderResults = () => {
        if (!searchedQuery) {
            return null;
        }
        if (type === "music") {
            return (
                <MusicList
                    musicList={musicList.items}
                    loading={musicList.loading}
                    loadingMore={musicList.loadingMore}
                    autoLoad
                    isEnd={musicList.isEnd}
                    stalled={musicList.stalled}
                    onRetry={musicList.retry}
                    onLoadMore={musicList.loadMore}
                    listId={`search:${searchedQuery}:${plugin?.hash ?? ""}`}
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
                            if (p) {
                                setSearchSource(p.hash);
                            }
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
