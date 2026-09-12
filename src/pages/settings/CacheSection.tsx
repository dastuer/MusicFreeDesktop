import React, { useCallback, useEffect, useState } from "react";
import {
    CACHE_COLORS,
    CacheInfo,
    CacheKey,
    clearCache,
    formatSize,
    getCacheInfo,
    getMediaCacheLimit,
    MEDIA_CACHE_LIMIT_OPTIONS,
    openCoverCacheDir,
    rebuildLocalCovers,
    setMediaCacheLimit,
} from "@/core/cache";
import { showToast } from "@/components/base/Toast";

/**
 * 设置页「存储与缓存」。
 *
 * 一键清理只动可重建的三类（封面 / 网络 / 临时文件）——
 * 一键操作不该删用户状态，所以「本地存储」必须单独点。
 */

const SAFE_KEYS: CacheKey[] = ["media", "cover", "http", "temp"];

export default function CacheSection() {
    const [info, setInfo] = useState<CacheInfo | null>(null);
    const [calculating, setCalculating] = useState(false);
    /** 正在清理的类别 key，或 "all"（一键清理） */
    const [clearing, setClearing] = useState<string | null>(null);
    const [rebuilding, setRebuilding] = useState(false);
    /** 播放缓存容量上限，null 表示还没读到 */
    const [limit, setLimit] = useState<number | null>(null);
    const [savingLimit, setSavingLimit] = useState(false);
    const busy = calculating || !!clearing || rebuilding;

    const refresh = useCallback(async () => {
        setCalculating(true);
        try {
            setInfo(await getCacheInfo());
        } catch {
            showToast("缓存大小读取失败");
        } finally {
            setCalculating(false);
        }
    }, []);

    useEffect(() => {
        refresh();
        getMediaCacheLimit().then(setLimit).catch(() => setLimit(null));
    }, [refresh]);

    const changeLimit = async (bytes: number) => {
        if (savingLimit) {
            return;
        }
        setSavingLimit(true);
        try {
            setLimit(await setMediaCacheLimit(bytes));
        } finally {
            setSavingLimit(false);
        }
    };

    const handleClear = async (keys: CacheKey[], tag: string) => {
        if (clearing) {
            return;
        }
        setClearing(tag);
        try {
            const res = await clearCache(keys);
            // 用户在原生弹窗里点了取消：什么都不做，也不弹提示
            if (res?.success) {
                const freed = res.freedTotal ?? 0;
                showToast(freed > 0 ? `已释放 ${formatSize(freed)}` : "缓存已清理");
            } else if (res?.empty) {
                showToast("没有需要清理的缓存");
            } else if (res?.message) {
                showToast(`清理失败：${res.message}`);
            }
        } catch (e: any) {
            showToast(`清理失败：${e?.message ?? String(e)}`);
        } finally {
            setClearing(null);
            // 无论成功与否都重新算一遍：清理可能只删掉一部分（文件被占用）
            await refresh();
        }
    };

    const handleRebuild = async () => {
        if (busy) {
            return;
        }
        setRebuilding(true);
        try {
            const res = await rebuildLocalCovers(true);
            if (!res?.success) {
                showToast(`重建失败：${res?.message ?? "未知错误"}`);
                return;
            }
            const { updated, checked, missingFile } = res.data ?? { updated: 0, checked: 0, missingFile: 0 };
            if (checked === 0) {
                showToast("本地音乐封面都还在，无需重建");
            } else {
                showToast(
                    `已重建 ${updated} 张封面` +
                        (missingFile ? `（${missingFile} 首源文件已不在磁盘）` : ""),
                );
            }
        } catch (e: any) {
            showToast(`重建失败：${e?.message ?? String(e)}`);
        } finally {
            setRebuilding(false);
            await refresh();
        }
    };

    const categories = info?.categories ?? [];
    const total = info?.total ?? 0;
    // 各类的「实际可清理」之和。封面只删残留，这个数通常远小于 total
    const clearableTotal = categories.reduce((sum, c) => sum + c.clearable, 0);

    return (
        <div className="settings-group">
            <div className="settings-group-title">存储与缓存</div>

            <div className="cache-panel">
                <div className="cache-summary">
                    <div style={{ minWidth: 0 }}>
                        <div className="cache-summary-label">应用缓存占用</div>
                        <div className="cache-summary-size">
                            {info ? formatSize(total) : "计算中…"}
                        </div>
                        {info ? (
                            <div className="cache-calc-hint">
                                {clearableTotal === 0
                                    ? "没有可清理的内容"
                                    : `其中可清理 ${formatSize(clearableTotal)}`}
                            </div>
                        ) : null}
                        {calculating && info ? (
                            <div className="cache-calc-hint">正在重新计算…</div>
                        ) : null}
                    </div>
                    <div className="cache-actions">
                        <button className="btn-ghost" disabled={busy} onClick={refresh}>
                            刷新
                        </button>
                        <button
                            className="btn-ghost"
                            onClick={async () => {
                                const dir = await openCoverCacheDir();
                                if (!dir) {
                                    showToast("缓存目录还不存在");
                                }
                            }}
                        >
                            打开目录
                        </button>
                        <button
                            className="btn-primary"
                            disabled={busy || clearableTotal === 0}
                            title="清理封面残留、网络缓存与下载临时文件（不含本地存储）"
                            onClick={() => handleClear(SAFE_KEYS, "all")}
                        >
                            {clearing === "all" ? "清理中…" : "一键清理"}
                        </button>
                    </div>
                </div>

                {info && total > 0 ? (
                    <>
                        <div className="cache-bar">
                            {categories
                                .filter((c) => c.size > 0)
                                .map((c) => (
                                    <div
                                        key={c.key}
                                        className="cache-bar-seg"
                                        style={{
                                            width: `${(c.size / total) * 100}%`,
                                            background: CACHE_COLORS[c.key],
                                        }}
                                        title={`${c.label} ${formatSize(c.size)}`}
                                    />
                                ))}
                        </div>
                        <div className="cache-legend">
                            {categories
                                .filter((c) => c.size > 0)
                                .map((c) => (
                                    <div className="cache-legend-item" key={c.key}>
                                        <span
                                            className="cache-dot"
                                            style={{ background: CACHE_COLORS[c.key] }}
                                        />
                                        {c.label} {formatSize(c.size)}
                                    </div>
                                ))}
                        </div>
                    </>
                ) : null}
            </div>

            {categories.map((c) => (
                <React.Fragment key={c.key}>
                <div className="settings-item">
                    <div style={{ minWidth: 0 }}>
                        <div className="settings-item-label">
                            <span
                                className="cache-dot"
                                style={{ background: CACHE_COLORS[c.key] }}
                            />
                            {c.label}
                            {c.risky ? (
                                <span className="cache-risk-tag">需重启生效</span>
                            ) : null}
                        </div>
                        <div
                            className="settings-item-desc"
                            style={{ whiteSpace: "normal", wordBreak: "break-word" }}
                        >
                            {c.desc}
                        </div>
                    </div>
                    <div className="cache-item-right">
                        <div style={{ textAlign: "right" }}>
                            <div className="cache-size">{formatSize(c.size)}</div>
                            <div className="cache-count">
                                {c.count !== null
                                    ? c.key === "media"
                                        ? `${c.count} 首已缓存`
                                        : `${c.count} 个文件`
                                    : ""}
                                {c.clearable < c.size ? ` · 可清理 ${formatSize(c.clearable)}` : ""}
                            </div>
                        </div>
                        {c.key === "cover" ? (
                            <button
                                className="btn-ghost"
                                style={{ flexShrink: 0 }}
                                disabled={busy}
                                title="按本地音乐列表重新抽取内嵌封面，修复封面被清空的情况"
                                onClick={handleRebuild}
                            >
                                {rebuilding ? "重建中…" : "重建"}
                            </button>
                        ) : null}
                        <button
                            className="btn-ghost"
                            style={{ flexShrink: 0 }}
                            disabled={busy || c.clearable === 0}
                            onClick={() => handleClear([c.key], c.key)}
                        >
                            {clearing === c.key ? "清理中…" : "清除"}
                        </button>
                    </div>
                </div>
                {c.key === "media" && limit !== null ? (
                    <div className="settings-item">
                        <div style={{ minWidth: 0 }}>
                            <div className="settings-item-label">播放缓存上限</div>
                            <div className="settings-item-desc">
                                {limit === 0
                                    ? "当前已关闭，在线音乐不落盘，每次播放都重新下载"
                                    : "超出上限时自动删除最久未播放的歌曲"}
                            </div>
                        </div>
                        <div className="segment" style={{ flexShrink: 0 }}>
                            {MEDIA_CACHE_LIMIT_OPTIONS.map((o) => (
                                <button
                                    key={o.bytes}
                                    className={`segment-item${limit === o.bytes ? " active" : ""}`}
                                    disabled={savingLimit}
                                    onClick={() => changeLimit(o.bytes)}
                                >
                                    {o.label}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : null}
                </React.Fragment>
            ))}
        </div>
    );
}
