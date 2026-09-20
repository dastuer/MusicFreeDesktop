import React, { useEffect, useState } from "react";
import Cover from "@/components/base/Cover";
import Icon from "@/components/base/Icon";
import SourceSwitcher from "@/components/base/SourceSwitcher";
import { uniqueById } from "@/core/collections";
import { SerializedPlugin } from "@/core/ipc";
import {
    AUTO_SOURCE,
    ISourceCapability,
    findSourcePlugin,
    getEnabledPlugins,
    getPageSource,
    getSourceStatus,
    pickSourcePlugins,
    setPageSource,
} from "@/core/mediaSource";
import { readPageSnapshot, writePageSnapshot } from "@/core/pageSnapshot";
import { tryPluginMethod } from "@/core/pluginUtils";
import { navigate } from "@/core/router";

/**
 * 排行榜页：
 * 页面头部 + 分组榜单网格（方形封面 + 底部渐变角标）
 * 默认「自动」= 默认音源优先，逐个降级尝试 + 超时 + 骨架屏 + 重试；
 * 也可在上方直接指定音源（只调该插件，并能区分「不支持」与「加载失败」）。
 */

const TOPLIST_METHOD = "getTopLists";
const CAPABILITIES: ISourceCapability[] = [
    { label: "排行榜", methods: [TOPLIST_METHOD] },
];
const TOPLIST_CAPABILITY = CAPABILITIES[0];

/** 页面标识：同时用作音源偏好的键与快照的键 */
const PAGE_KEY = "topList";

/**
 * 本页要留到模块作用域的展示数据（见 core/pageSnapshot）。
 *
 * 切页时组件按 key 整体重挂载，若每次都从空数组 + loading 开始，就会走
 * 「内容 → 骨架屏 → 内容」两次整屏替换（从发现音乐切过来的闪烁就是这么来的）。
 * 存一份快照，重挂载时先用它渲染首帧，插件请求在后台静默刷新。
 */
interface ITopListSnapshot {
    plugins: SerializedPlugin[];
    groups: IMusic.IMusicSheetGroupItem[];
    sourceName: string;
}

/** 取当前音源下的快照；没有（首次进入或换过音源）就返回 null，按冷启动处理 */
function readSnapshot(): ITopListSnapshot | null {
    return readPageSnapshot<ITopListSnapshot>(PAGE_KEY, getPageSource(PAGE_KEY));
}

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
    // 有快照就直接从快照起手：loading 初值为 false，首帧就是内容而不是骨架屏
    const [initial] = useState(readSnapshot);
    const [hasSnapshot, setHasSnapshot] = useState(!!initial);
    const [plugins, setPlugins] = useState<SerializedPlugin[]>(initial?.plugins ?? []);
    const [sourceHash, setSourceHash] = useState(() => getPageSource(PAGE_KEY));
    const [groups, setGroups] = useState<IMusic.IMusicSheetGroupItem[]>(initial?.groups ?? []);
    const [sourceName, setSourceName] = useState(initial?.sourceName ?? "");
    const [loading, setLoading] = useState(!initial);
    const [failed, setFailed] = useState(false);
    const [noSource, setNoSource] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);

    const changeSource = (hash: string) => {
        setPageSource(PAGE_KEY, hash);
        setSourceHash(hash);
        // 即将展示的是另一个音源的数据，不能沿用当前快照，照常走加载态
        setHasSnapshot(false);
    };

    useEffect(() => {
        let cancelled = false;
        (async () => {
            // 有快照时这一轮是「后台刷新」：不切加载态、不清空已有内容。
            // 否则每次切回本页都要先空屏等插件请求，就是那个闪烁。
            if (!hasSnapshot) {
                setLoading(true);
                setFailed(false);
                setNoSource(false);
                setGroups([]);
                setSourceName("");
            }

            const all = await getEnabledPlugins();
            if (cancelled) {
                return;
            }
            setPlugins(all);

            const capable = all.filter((p) => p.supportedMethods.includes(TOPLIST_METHOD));
            if (!all.length || !capable.length) {
                // 一个支持排行榜的音源都没有
                setNoSource(true);
                setLoading(false);
                return;
            }

            const candidates = pickSourcePlugins(all, TOPLIST_METHOD, sourceHash);
            if (!candidates.length) {
                // 指定音源不支持排行榜（或已被禁用）→ 由页面给出精确提示，不请求
                setLoading(false);
                return;
            }

            const result = await tryPluginMethod(candidates, TOPLIST_METHOD);
            if (cancelled) {
                return;
            }
            if (result) {
                const next = (result.data ?? []).filter((g: any) => g?.data?.length);
                setGroups(next);
                setSourceName(result.pluginName);
                /**
                 * 就地写快照，而不是另开一个 effect 去「看到什么写什么」：
                 * 切音源时那一帧的闭包拿到的还是上一个音源的 groups，写下去就等于把
                 * A 的数据存成了 B 的快照。这里的数据与 sourceHash 来自同一次请求，
                 * 不可能串源。空结果不写——空快照会让下次既没有骨架屏也没有内容。
                 */
                if (next.length) {
                    writePageSnapshot<ITopListSnapshot>(PAGE_KEY, sourceHash, {
                        plugins: all,
                        groups: next,
                        sourceName: result.pluginName,
                    });
                }
            } else if (!hasSnapshot) {
                // 刷新失败时沿用快照内容：数据是好的、只是没拿到最新的，不该闪成错误态
                setFailed(true);
            }
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [reloadKey, sourceHash]);

    const sourcePlugin = findSourcePlugin(plugins, sourceHash);
    const status = getSourceStatus(plugins, TOPLIST_CAPABILITY, sourceHash);
    const unsupported = status === "unsupported" && !loading && !noSource;
    // 有快照时音源可能刚好被卸载：这时不能把旧榜单和「没有音源」的提示一起渲染
    const showContent = !loading && !failed && !noSource && !unsupported;

    return (
        <div>
            <div className="page-header">
                <div className="page-header-row">
                    <div>
                        <div className="page-header-title">排行榜</div>
                        <div className="page-header-sub">
                            {sourcePlugin
                                ? `已指定音源「${sourcePlugin.name}」· 点击榜单查看完整曲目`
                                : sourceName
                                  ? `数据来源：${sourceName}（自动选择）· 点击榜单查看完整曲目`
                                  : "权威榜单一览，数据来自已启用的音源插件"}
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

            {loading && <SkeletonGrid />}

            {!loading && noSource && (
                <div className="empty-hint">
                    {plugins.length
                        ? "已启用的音源都不支持排行榜，可在「音源插件」中安装其他音源"
                        : "没有支持排行榜的插件，安装音源插件后可浏览榜单"}
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

            {unsupported && (
                <div className="empty-hint">
                    当前音源「{sourcePlugin?.name}」不支持排行榜
                    <div style={{ marginTop: 12, display: "flex", gap: 8, justifyContent: "center" }}>
                        <button className="btn-primary" onClick={() => changeSource(AUTO_SOURCE)}>
                            切回自动
                        </button>
                        <button className="btn-ghost" onClick={() => navigate("pluginManage")}>
                            管理音源
                        </button>
                    </div>
                </div>
            )}

            {!loading && failed && (
                <div className="empty-hint">
                    {sourcePlugin
                        ? `音源「${sourcePlugin.name}」榜单加载失败（网络超时或插件不可用）`
                        : "榜单加载失败（网络超时或插件不可用）"}
                    <div style={{ marginTop: 12, display: "flex", gap: 8, justifyContent: "center" }}>
                        <button
                            className="btn-primary"
                            onClick={() => setReloadKey((k) => k + 1)}
                        >
                            <Icon name="forward" size={14} />
                            重新加载
                        </button>
                        {sourcePlugin && (
                            <button
                                className="btn-ghost"
                                onClick={() => changeSource(AUTO_SOURCE)}
                            >
                                切回自动
                            </button>
                        )}
                    </div>
                </div>
            )}

            {showContent &&
                groups.map((group, gi) => {
                // 同一分组里出现重复榜单时只渲染一次（否则 React 会报重复 key）
                const items = uniqueById(group.data);
                return (
                <section
                    className="home-section"
                    /* 分组标题可能重复，补上序号保证同级 key 唯一 */
                    key={`${group.title || "toplist"}-${gi}`}
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
                            {items.length} 个榜单
                        </span>
                    </div>
                    <div className="card-grid">
                        {items.map((item: any, idx: number) => (
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
                );
                })}
        </div>
    );
}
