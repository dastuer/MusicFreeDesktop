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

const SOURCE_PAGE_KEY = "home";

interface ISheetCard {
    id: string;
    platform: string;
    title: string;
    artwork: string;
    playCount?: number;
}

function SourceNote(props: { children: React.ReactNode }) {
    return <div className="source-note">{props.children}</div>;
}

export default function HomePage() {
    const [plugins, setPlugins] = useState<SerializedPlugin[]>([]);
    const [sourceHash, setSourceHash] = useState(() => getPageSource(SOURCE_PAGE_KEY));
    const [tags, setTags] = useState<ICommon.IUnique[]>([]);
    const [activeTag, setActiveTag] = useState<ICommon.IUnique | null>(null);
    const [sheets, setSheets] = useState<ISheetCard[]>([]);
    const [topLists, setTopLists] = useState<IMusic.IMusicSheetGroupItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [sheetFailed, setSheetFailed] = useState(false);
    const [topListFailed, setTopListFailed] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [tagSource, setTagSource] = useState("");
    const [topListSource, setTopListSource] = useState("");

    const changeSource = (hash: string) => {
        setPageSource(SOURCE_PAGE_KEY, hash);
        setSourceHash(hash);
    };

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setFailed(false);
            setSheetFailed(false);
            setTopListFailed(false);

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
            } else {
                // 切换音源后必须清空旧数据，否则会残留上一个音源的结果
                setTagSource("");
                setTags([]);
                setActiveTag(null);
                setSheets([]);
            }

            if (topListResult) {
                setTopListSource(topListResult.pluginName);
                setTopLists((topListResult.data ?? []).slice(0, 2));
            } else {
                setTopListSource("");
                setTopLists([]);
            }

            setSheetFailed(!tagResult && sheetCapable.length > 0);
            setTopListFailed(!topListResult && topListPlugins.length > 0);
            setFailed(
                !tagResult &&
                    !topListResult &&
                    (sheetCapable.length > 0 || topListPlugins.length > 0),
            );
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
            if (result) {
                setTagSource(result.pluginName);
            }
            setSheets(
                uniqueById((result?.data?.data ?? []) as ISheetCard[]).slice(0, 18),
            );
        })();
        return () => {
            cancelled = true;
        };
    }, [activeTag?.id, sourceHash]);

    const sourcePlugin = findSourcePlugin(plugins, sourceHash);
    const sourceName = sourcePlugin?.name ?? "";
    const sheetStatus = getSourceStatus(plugins, SHEET_CAPABILITY, sourceHash);
    const topListStatus = getSourceStatus(plugins, TOPLIST_CAPABILITY, sourceHash);
    const sheetCapableCount = plugins.filter((p) => hasCapability(p, SHEET_CAPABILITY)).length;
    const topListCapableCount = plugins.filter((p) => hasCapability(p, TOPLIST_CAPABILITY)).length;
    const noSource = !loading && !sheetCapableCount && !topListCapableCount;

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

            {!loading && !failed && (tags.length > 1 || sheetNote) && (
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

            {!loading && !failed && !topLists.length && topListNote && (
                <section className="home-section">
                    <div className="section-title">排行榜</div>
                    <SourceNote>{topListNote}</SourceNote>
                </section>
            )}

            {!loading &&
                !failed &&
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
