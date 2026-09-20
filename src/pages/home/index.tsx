import React, { useEffect, useState } from "react";
import Cover from "@/components/base/Cover";
import Icon from "@/components/base/Icon";
import SourceSwitcher from "@/components/base/SourceSwitcher";
import { uniqueById } from "@/core/collections";
import { SerializedPlugin } from "@/core/ipc";
import {
    ISourceCapability,
    findSourcePlugin,
    getEnabledPlugins,
    getPageSource,
    getSourceStatus,
    hasCapability,
    pickCapabilityPlugins,
    pickSourcePlugins,
    setPageSource,
} from "@/core/mediaSource";
import { readPageSnapshot, writePageSnapshot } from "@/core/pageSnapshot";
import { tryPluginMethod } from "@/core/pluginUtils";
import { navigate } from "@/core/router";

/**
 * 发现音乐（首页）：推荐歌单 + 排行榜
 * 支持切换数据来源（音源插件）：默认「自动」= 默认音源优先，逐个降级尝试 + 超时控制，
 * 指定音源时只用该插件，且能区分「不支持该能力」与「加载失败」两种空态。
 */

const SHEET_TAGS_METHOD = "getRecommendSheetTags";
const SHEET_LIST_METHOD = "getRecommendSheetsByTag";
const TOPLIST_METHOD = "getTopLists";

/** 页面需要的能力（候选音源列表与「不支持 XX」提示都以它为准） */
const CAPABILITIES: ISourceCapability[] = [
    { label: "推荐歌单", methods: [SHEET_TAGS_METHOD, SHEET_LIST_METHOD] },
    { label: "排行榜", methods: [TOPLIST_METHOD] },
];
const SHEET_CAPABILITY = CAPABILITIES[0];
const TOPLIST_CAPABILITY = CAPABILITIES[1];

/** 页面标识：同时用作音源偏好的键与快照的键 */
const PAGE_KEY = "home";

interface ISheetCard {
    id: string;
    platform: string;
    title: string;
    artwork: string;
    playCount?: number;
}

/**
 * 本页要留到模块作用域的展示数据（见 core/pageSnapshot）。
 *
 * 首页是路由表的初始页，从排行榜等页面切回来时组件会按 key 整体重挂载，旧内容
 * 全部丢弃、重新走一遍「加载中…」再等插件请求——主内容区会白闪一下。存一份快照，
 * 重挂载时先用它渲染，请求在后台静默完成后再替换，切换页面不再有空窗期。
 */
interface IHomeSnapshot {
    plugins: SerializedPlugin[];
    tags: ICommon.IUnique[];
    activeTag: ICommon.IUnique | null;
    sheets: ISheetCard[];
    topLists: IMusic.IMusicSheetGroupItem[];
    tagSource: string;
    topListSource: string;
}

/** 取当前音源下的快照；没有（首次进入或换过音源）就返回 null，按冷启动处理 */
function readSnapshot(): IHomeSnapshot | null {
    return readPageSnapshot<IHomeSnapshot>(PAGE_KEY, getPageSource(PAGE_KEY));
}

/** 冷启动（无快照）时的骨架屏：结构对齐真实内容，避免切换过来先看到一大块白 */
function HomeSkeleton() {
    const skeletonGrid = (count: number) => (
        <div className="card-grid">
            {Array.from({ length: count }).map((_, i) => (
                <div className="skeleton-card" key={i}>
                    <div className="square-cover" />
                    <div className="skeleton-line" />
                    <div className="skeleton-line short" />
                </div>
            ))}
        </div>
    );
    return (
        <>
            <section className="home-section">
                <div className="skeleton-line" style={{ width: 96, height: 20, marginTop: 28 }} />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "14px 0 16px" }}>
                    {Array.from({ length: 8 }).map((_, i) => (
                        <div
                            key={i}
                            className="skeleton-line"
                            style={{ width: 52, height: 26, borderRadius: 13, marginTop: 0 }}
                        />
                    ))}
                </div>
                {skeletonGrid(8)}
            </section>
            <section className="home-section">
                <div className="skeleton-line" style={{ width: 128, height: 20, marginTop: 28 }} />
                {skeletonGrid(8)}
            </section>
        </>
    );
}

function SourceNote(props: { children: React.ReactNode }) {
    return <div className="source-note">{props.children}</div>;
}

export default function HomePage() {
    // 有快照就直接从快照起手：loading 初值为 false，首帧就是内容而不是加载态
    const [initial] = useState(readSnapshot);
    const [hasSnapshot, setHasSnapshot] = useState(!!initial);
    const [plugins, setPlugins] = useState<SerializedPlugin[]>(initial?.plugins ?? []);
    const [sourceHash, setSourceHash] = useState(() => getPageSource(PAGE_KEY));
    const [tags, setTags] = useState<ICommon.IUnique[]>(initial?.tags ?? []);
    const [activeTag, setActiveTag] = useState<ICommon.IUnique | null>(
        initial?.activeTag ?? null,
    );
    const [sheets, setSheets] = useState<ISheetCard[]>(initial?.sheets ?? []);
    const [topLists, setTopLists] = useState<IMusic.IMusicSheetGroupItem[]>(
        initial?.topLists ?? [],
    );
    const [loading, setLoading] = useState(!initial);
    const [failed, setFailed] = useState(false);
    const [sheetFailed, setSheetFailed] = useState(false);
    const [topListFailed, setTopListFailed] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [tagSource, setTagSource] = useState(initial?.tagSource ?? "");
    const [topListSource, setTopListSource] = useState(initial?.topListSource ?? "");

    const changeSource = (hash: string) => {
        setPageSource(PAGE_KEY, hash);
        setSourceHash(hash);
        // 即将展示的是另一个音源的数据，不能沿用当前快照，照常走加载态
        setHasSnapshot(false);
        /**
         * 这一帧必须就把 loading 打上，不能等下面那个 effect 去做。
         * 两个理由：一是少一帧「新音源已选中、屏幕上还是旧音源内容」；
         * 二是快照 effect 在同一个提交里紧接着执行，它读到的 loading 是本次渲染的
         * 闭包值——不为 true 的话它会拿着旧的 tags/topLists/sheets 写进新音源的
         * 快照里，等于串源。
         */
        setLoading(true);
        // 歌单是另一个 effect 拉的，会一直留到新请求返回；不清掉同样会被写进新音源快照
        setSheets([]);
    };

    useEffect(() => {
        let cancelled = false;
        (async () => {
            // 有快照时这一轮是「后台刷新」：不切加载态、不清空已有内容。
            // 否则每次回到首页都要先空屏等插件请求，从内容页切回来就会白闪一下。
            if (!hasSnapshot) {
                setLoading(true);
                setFailed(false);
                setSheetFailed(false);
                setTopListFailed(false);
            }

            const all = await getEnabledPlugins();
            if (cancelled) {
                return;
            }
            setPlugins(all);

            const sheetPlugins = pickSourcePlugins(all, SHEET_TAGS_METHOD, sourceHash);
            const sheetCapable = pickCapabilityPlugins(all, SHEET_CAPABILITY, sourceHash);
            const topListPlugins = pickSourcePlugins(all, TOPLIST_METHOD, sourceHash);

            // 两个区块并行加载
            const [tagResult, topListResult] = await Promise.all([
                sheetPlugins.length
                    ? tryPluginMethod(sheetPlugins, SHEET_TAGS_METHOD)
                    : Promise.resolve(null),
                topListPlugins.length
                    ? tryPluginMethod(topListPlugins, TOPLIST_METHOD)
                    : Promise.resolve(null),
            ]);
            if (cancelled) {
                return;
            }

            if (tagResult) {
                setTagSource(tagResult.pluginName);
                const data = tagResult.data?.data ?? [];
                const pinned = tagResult.data?.pinned ?? [];
                // pinned 与首个分组常有重叠（见 uniqueById 注释），必须去重后再用
                const merged = uniqueById([...pinned, ...(data[0]?.data ?? [])]).slice(0, 12);
                setTags(merged);
                setActiveTag(merged.length ? merged[0] : null);
                if (!merged.length) {
                    setSheets([]);
                }
            } else if (!hasSnapshot) {
                // 切换音源后必须清空旧数据，否则会残留上一个音源的结果
                setTagSource("");
                setTags([]);
                setActiveTag(null);
                setSheets([]);
            }

            if (topListResult) {
                setTopListSource(topListResult.pluginName);
                setTopLists((topListResult.data ?? []).slice(0, 2));
            } else if (!hasSnapshot) {
                setTopListSource("");
                setTopLists([]);
            }

            // 刷新失败时沿用快照内容：数据是好的、只是没拿到最新的，不该闪成错误态
            if (!hasSnapshot) {
                setSheetFailed(!tagResult && sheetCapable.length > 0);
                setTopListFailed(!topListResult && topListPlugins.length > 0);
                setFailed(
                    !tagResult &&
                        !topListResult &&
                        (sheetCapable.length > 0 || topListPlugins.length > 0),
                );
            }
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [reloadKey, sourceHash]);

    useEffect(() => {
        if (!activeTag) {
            return;
        }
        let cancelled = false;
        (async () => {
            const all = await getEnabledPlugins();
            const sheetPlugins = pickSourcePlugins(all, SHEET_LIST_METHOD, sourceHash);
            if (cancelled) {
                return;
            }
            if (!sheetPlugins.length) {
                setSheets([]);
                return;
            }
            const result = await tryPluginMethod(
                sheetPlugins,
                SHEET_LIST_METHOD,
                12000,
                activeTag,
                1,
            );
            if (cancelled) {
                return;
            }
            // 请求失败时保留当前列表：切回页面时首屏就是快照里的歌单，
            // 这时候清空会让内容闪没一下，与本次要修的白闪是同一种现象
            if (result) {
                setTagSource(result.pluginName);
                setSheets(
                    uniqueById((result?.data?.data ?? []) as ISheetCard[]).slice(0, 18),
                );
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [activeTag?.id, sourceHash]);

    // 内容每次变化都同步一份到模块级快照：下次挂载（切回本页）直接渲染，不白屏。
    // 加载中与失败态不记——失败时保留上一次的好快照，没有快照就让下次重新冷启动并照常报错。
    // 两个区块都空也不记：空快照会让下次既没有骨架屏、也没有内容，比冷启动更糟。
    useEffect(() => {
        if (loading || failed) {
            return;
        }
        if (!sheets.length && !topLists.length) {
            return;
        }
        writePageSnapshot<IHomeSnapshot>(PAGE_KEY, sourceHash, {
            plugins,
            tags,
            activeTag,
            sheets,
            topLists,
            tagSource,
            topListSource,
        });
    }, [
        loading,
        failed,
        sourceHash,
        plugins,
        tags,
        activeTag,
        sheets,
        topLists,
        tagSource,
        topListSource,
    ]);

    const sourcePlugin = findSourcePlugin(plugins, sourceHash);
    const sourceName = sourcePlugin?.name ?? "";
    const sheetStatus = getSourceStatus(plugins, SHEET_CAPABILITY, sourceHash);
    const topListStatus = getSourceStatus(plugins, TOPLIST_CAPABILITY, sourceHash);
    const sheetCapableCount = plugins.filter((p) => hasCapability(p, SHEET_CAPABILITY)).length;
    const topListCapableCount = plugins.filter((p) => hasCapability(p, TOPLIST_CAPABILITY)).length;
    const noSource = !loading && !sheetCapableCount && !topListCapableCount;
    // 有快照时音源可能刚好被卸载：这时不能把旧内容和「没有音源」的提示一起渲染
    const showContent = !loading && !failed && !noSource;

    const sheetNote =
        sheetStatus === "unsupported"
            ? `当前音源「${sourceName}」不支持推荐歌单，可在上方切换其他音源`
            : sheetFailed
              ? `「${sourceName || "当前音源"}」推荐歌单加载失败，可重新加载或切换音源`
              : null;
    const topListNote =
        topListStatus === "unsupported"
            ? `当前音源「${sourceName}」不支持排行榜，可在上方切换其他音源`
            : topListFailed
              ? `「${sourceName || "当前音源"}」排行榜加载失败，可重新加载或切换音源`
              : null;

    return (
        <div>
            <div className="page-header">
                <div className="page-header-row">
                    <div>
                        <div className="page-header-title">发现音乐</div>
                        <div className="page-header-sub">
                            {sourcePlugin
                                ? `已指定音源「${sourcePlugin.name}」，本页数据仅来自该音源`
                                : "推荐歌单与排行榜：按默认音源优先自动选择"}
                        </div>
                    </div>
                    <SourceSwitcher
                        plugins={plugins}
                        capabilities={CAPABILITIES}
                        value={sourceHash}
                        onChange={changeSource}
                    />
                </div>
            </div>

            {noSource && !loading && (
                <div className="empty-hint">
                    {plugins.length
                        ? "已启用的音源都不支持推荐歌单和排行榜，可在「音源插件」中安装其他音源"
                        : "尚未安装音源插件，请前往「音源插件」安装后体验完整功能"}
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

            {loading && <HomeSkeleton />}

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

            {showContent && (tags.length > 1 || sheetNote) && (
                <section className="home-section">
                    <div className="section-title">
                        推荐歌单
                        {tagSource && (
                            <span className="section-source">数据来源：{tagSource}</span>
                        )}
                    </div>
                    {sheetNote ? (
                        <SourceNote>{sheetNote}</SourceNote>
                    ) : (
                        <>
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
                                            <div className="media-card-title">
                                                {sheet.title}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </section>
            )}

            {showContent && !topLists.length && topListNote && (
                <section className="home-section">
                    <div className="section-title">排行榜</div>
                    <SourceNote>{topListNote}</SourceNote>
                </section>
            )}

            {showContent &&
                topLists.map((group, gi) => (
                        <section
                            className="home-section"
                            /* 分组标题可能重复，补上序号保证同级 key 唯一 */
                            key={`${group.title || group.data?.[0]?.id || "toplist"}-${gi}`}
                        >
                            <div className="section-title">
                                排行榜{group.title ? ` · ${group.title}` : ""}
                                {topListSource && (
                                    <span className="section-source">
                                        数据来源：{topListSource}
                                    </span>
                                )}
                            </div>
                            <div className="card-grid">
                                {uniqueById(group.data)
                                    .slice(0, 8)
                                    .map((item: any) => (
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
