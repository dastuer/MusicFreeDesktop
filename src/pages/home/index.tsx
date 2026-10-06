import React, {
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import Cover from "@/components/base/Cover";
import Icon from "@/components/base/Icon";
import SourceSwitcher from "@/components/base/SourceSwitcher";
import { uniqueById } from "@/core/collections";
import { SerializedPlugin } from "@/core/ipc";
import {
    ISourceCapability,
    findSourcePlugin,
    getBrowseSource,
    getEnabledPlugins,
    getSourceStatus,
    hasCapability,
    pickCapabilityPlugins,
    pickSourcePlugins,
    setBrowseSource,
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

/** 页面标识：用作快照的键；音源偏好是发现音乐/排行榜共用的一份，见 core/mediaSource */
const PAGE_KEY = "home";

interface ISheetCard {
    id: string;
    platform: string;
    title: string;
    artwork: string;
    playCount?: number;
}

/** 推荐歌单的分类是两级的：分组标题（热门/语种/风格…）+ 组内一串标签 */
interface ITagGroup {
    title: string;
    data: ICommon.IUnique[];
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
    tagGroups: ITagGroup[];
    activeTag: ICommon.IUnique | null;
    sheets: ISheetCard[];
    topLists: IMusic.IMusicSheetGroupItem[];
    tagSource: string;
    topListSource: string;
}

/** 取当前音源下的快照；没有（首次进入或换过音源）就返回 null，按冷启动处理 */
function readSnapshot(): IHomeSnapshot | null {
    return readPageSnapshot<IHomeSnapshot>(PAGE_KEY, getBrowseSource());
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
                {/* 分类是顶部一行胶囊 + 「更多分类」，骨架屏照着摆 */}
                <div className="sheet-tagbar" style={{ margin: "14px 0 16px" }}>
                    {Array.from({ length: 8 }).map((_, i) => (
                        <div
                            key={i}
                            className="skeleton-line"
                            style={{
                                width: 72,
                                height: 32,
                                borderRadius: 16,
                                marginTop: 0,
                                flexShrink: 0,
                            }}
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
    const [sourceHash, setSourceHash] = useState(() => getBrowseSource());
    const [tagGroups, setTagGroups] = useState<ITagGroup[]>(initial?.tagGroups ?? []);
    // 「更多分类」浮窗：打开状态 + 当前看的是哪个一级分组（浮窗是临时的，不进快照）
    const [moreOpen, setMoreOpen] = useState(false);
    const [moreTabIdx, setMoreTabIdx] = useState(0);
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
        // 共用偏好：这里改了，排行榜页（重挂载时）同步生效
        setBrowseSource(hash);
        setSourceHash(hash);
        // 即将展示的是另一个音源的数据，不能沿用当前快照，照常走加载态
        setHasSnapshot(false);
        /**
         * 这一帧必须就把 loading 打上，不能等下面那个 effect 去做。
         * 两个理由：一是少一帧「新音源已选中、屏幕上还是旧音源内容」；
         * 二是快照 effect 在同一个提交里紧接着执行，它读到的 loading 是本次渲染的
         * 闭包值——不为 true 的话它会拿着旧的 tagGroups/topLists/sheets 写进新音源的
         * 快照里，等于串源。
         */
        setLoading(true);
        // 歌单是另一个 effect 拉的，会一直留到新请求返回；不清掉同样会被写进新音源快照
        setSheets([]);
        // 新音源的分组结构完全不同，开着的浮窗直接收掉
        setMoreOpen(false);
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
                const groups = tagResult.data?.data ?? [];
                const pinned = tagResult.data?.pinned ?? [];
                // 分类是两级结构：每个分组的 title 是一级（热门/语种/风格…），组内
                // 标签是二级。以前只取 data[0] 并截到 12 个，后面的分组全部丢失。
                // pinned 与首个分组常有重叠（见 uniqueById 注释），去重后并入首组展示。
                const normalized = groups
                    .filter((g: any) => Array.isArray(g?.data) && g.data.length)
                    .map((g: any, i: number) => ({
                        title: g.title || "热门",
                        // 每组各自去重：组内重复 id 会让 React 报重复 key
                        data:
                            i === 0
                                ? uniqueById([...pinned, ...g.data])
                                : uniqueById(g.data),
                    }));
                // 插件只给了 pinned、没给分组时，pinned 自己成一组，别弄丢
                if (!normalized.length && pinned.length) {
                    normalized.push({ title: "热门", data: uniqueById(pinned) });
                }
                setTagGroups(normalized);
                const firstTag = normalized[0]?.data[0] ?? null;
                setActiveTag(firstTag);
                if (!firstTag) {
                    setSheets([]);
                }
            } else if (!hasSnapshot) {
                // 切换音源后必须清空旧数据，否则会残留上一个音源的结果
                setTagSource("");
                setTagGroups([]);
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
            tagGroups,
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
        tagGroups,
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
    // 只有一个标签时没有可切换的余地，整块连着歌单一起藏起来（与旧版一致）
    const totalTagCount = tagGroups.reduce((acc, g) => acc + g.data.length, 0);
    // 顶部一行：每个分组固定取第一个子类作代表（网易云风格），选中标签恰好是
    // 某组代表时该胶囊高亮。代表之间按 id 去重：不同分组的首个标签可能撞车。
    const topPills = (() => {
        const seen = new Set<string>();
        const pills: ICommon.IUnique[] = [];
        for (const g of tagGroups) {
            const rep = g.data[0];
            if (rep && !seen.has(String(rep.id))) {
                seen.add(String(rep.id));
                pills.push(rep);
            }
        }
        return pills;
    })();
    const topTagIds = new Set(topPills.map((t) => String(t.id)));
    // 浮窗只放没上过顶部行的标签，与顶部互不重复；整组都是代表的分组不出现。
    // sourceIdx 记着它在 tagGroups 里的原位置，打开浮窗时用来落 tab。
    const popoverGroups = tagGroups
        .map((g, gi) => ({
            title: g.title,
            sourceIdx: gi,
            data: g.data.filter((t) => !topTagIds.has(String(t.id))),
        }))
        .filter((g) => g.data.length > 0);
    // 选中的标签不在顶部行 = 它是从浮窗里选的，此时更多分类按钮呈激活态
    const activeOnTop = !!activeTag && topTagIds.has(String(activeTag.id));
    const openMore = () => {
        const gi = tagGroups.findIndex((g) => g.data.some((t) => t.id === activeTag?.id));
        const pi = popoverGroups.findIndex((g) => g.sourceIdx === gi);
        setMoreTabIdx(pi >= 0 ? pi : 0);
        setMoreOpen(true);
    };
    const moreGroup = popoverGroups[Math.min(moreTabIdx, popoverGroups.length - 1)];
    // 浮窗右缘对齐「更多分类」按钮右缘：打开时量按钮位置算出 right 偏移与宽度
    //（左缘顶到内容区左边）。按钮位置只取决于它前面的胶囊数量，开着的期间不变，
    // 只有窗口缩放需要重算。
    const moreBtnRef = useRef<HTMLButtonElement>(null);
    const tagbarWrapRef = useRef<HTMLDivElement>(null);
    const [morePos, setMorePos] = useState<{ right: number; width: number } | null>(null);
    useLayoutEffect(() => {
        if (!moreOpen) {
            return;
        }
        const measure = () => {
            const btn = moreBtnRef.current;
            const wrap = tagbarWrapRef.current;
            if (!btn || !wrap) {
                return;
            }
            const btnRect = btn.getBoundingClientRect();
            const wrapRect = wrap.getBoundingClientRect();
            setMorePos({
                right: wrapRect.right - btnRect.right,
                width: Math.max(420, Math.round(btnRect.right - wrapRect.left)),
            });
        };
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
    }, [moreOpen]);
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
                                ? `已指定音源「${sourcePlugin.name}」，发现音乐与排行榜均仅使用该音源`
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

            {showContent && (totalTagCount > 1 || sheetNote) && (
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
                            {/* 顶部一行：每个分组固定一个代表标签（组内第一个），
                                行尾「更多分类」打开浮窗——一级分组做 tab，组内除代表
                                外的全部标签平铺（与顶部不重复），点选即换歌单并收起。
                                选中标签不在顶部行时（从浮窗选的），按钮呈激活态 */}
                            <div className="sheet-tagbar-wrap" ref={tagbarWrapRef}>
                                <div className="sheet-tagbar">
                                    {topPills.map((tag) => (
                                        <button
                                            key={tag.id}
                                            className={`sheet-tag-pill${activeTag?.id === tag.id ? " active" : ""}`}
                                            onClick={() => setActiveTag(tag)}
                                        >
                                            {(tag as any).title}
                                        </button>
                                    ))}
                                    {popoverGroups.length > 0 && (
                                        <button
                                            ref={moreBtnRef}
                                            className={`sheet-tag-pill sheet-tag-more${activeTag && !activeOnTop ? " active" : ""}`}
                                            onClick={openMore}
                                        >
                                            更多分类
                                            <Icon
                                                name="chevronDown"
                                                size={14}
                                                style={
                                                    moreOpen
                                                      ? { transform: "rotate(180deg)" }
                                                      : undefined
                                                }
                                            />
                                        </button>
                                    )}
                                </div>
                                {moreOpen && (
                                    <>
                                        <div
                                            className="sheet-tag-popover-mask"
                                            onClick={() => setMoreOpen(false)}
                                        />
                                        <div
                                            className="sheet-tag-popover"
                                            style={
                                                morePos
                                                  ? { right: morePos.right, width: morePos.width }
                                                  : undefined
                                            }
                                        >
                                            <div className="sheet-tag-popover-tabs">
                                                {popoverGroups.map((group, gi) => (
                                                    <button
                                                        key={`${group.title}-${group.sourceIdx}`}
                                                        className={`sheet-tag-popover-tab${gi === moreTabIdx ? " active" : ""}`}
                                                        onClick={() => setMoreTabIdx(gi)}
                                                    >
                                                        {group.title}
                                                    </button>
                                                ))}
                                            </div>
                                            <div className="sheet-tag-popover-pills">
                                                {(moreGroup?.data ?? []).map((tag) => (
                                                    <button
                                                        key={tag.id}
                                                        className={`sheet-tag-popover-pill${activeTag?.id === tag.id ? " active" : ""}`}
                                                        onClick={() => {
                                                            setActiveTag(tag);
                                                            setMoreOpen(false);
                                                        }}
                                                    >
                                                        {(tag as any).title}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    </>
                                )}
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
