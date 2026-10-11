import React, { useCallback, useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import Cover from "./Cover";
import { showToast } from "./Toast";
import { SerializedPlugin } from "@/core/ipc";
import { getMatchableSourcePlugins, ISongMatch } from "@/core/neteaseMatch";
import {
    applySheetReplacements,
    checkMusicHealthMany,
    describeReplacement,
    ITrackHealth,
    matchMusicItems,
} from "@/core/sheetSourceFix";
import type { TSheetFixMode } from "@/core/sheetSourceFix";
import { TrackPlayerSingleton } from "@/core/trackPlayer";

/**
 * 歌单音源管理弹窗（「我的歌单」详情页专用）：重新匹配 / 修复音源 / 替换音源。
 *
 * 一条流水线四个阶段，全程在弹窗里展示：
 *  0. sources —— 选择参与匹配的音源：重新匹配/修复音源可多选（默认全选），
 *     替换音源必须指定一个，匹配与替换都只用它。
 *  1. checking —— 健康检查：修复模式逐首探测（插件在不在、拿不拿得到播放直链、
 *     本地文件在不在），正常的直接跳过；重新匹配/替换音源模式只查本地文件
 *     （流媒体一律重配，本地文件好好的不折腾）。
 *  2. matching —— 把进入匹配的曲目交给 neteaseMatch 的打分管线（含可播性闸门）。
 *  3. review   —— 前后对比：左边原曲（失效原因红标），右边匹配候选（相似度分）。
 *     批量时逐行勾选、默认全选；未命中/命中重复/与原曲一致的行禁用并说明原因。
 *  确认后原位替换歌单并同步播放队列。
 */

export interface ISheetFixRequest {
    mode: TSheetFixMode;
    sheetId: string;
    sheetTitle: string;
    /** 要处理的曲目（整张歌单 / 多选集合 / 单首，由入口决定） */
    items: IMusic.IMusicItem[];
    /** 替换落盘后的回调（页面刷新列表用） */
    onDone?: () => void;
}

let panelListener: ((req: ISheetFixRequest) => void) | null = null;

export function showSheetFixPanel(req: ISheetFixRequest) {
    panelListener?.(req);
}

type TStage = "sources" | "checking" | "matching" | "review" | "applying" | "error";

interface IFixRow {
    /** 原曲 platform-id；也是转换给匹配管线的歌曲 id，onResult 按它对回行 */
    key: string;
    original: IMusic.IMusicItem;
    /** 健康检查结果（修复模式全部有；其余模式只有本地文件有） */
    health?: ITrackHealth;
    match?: ISongMatch;
    candidate: IMusic.IMusicItem | null;
    /** 不可替换的原因（未命中 / 重复 / 与原曲一致） */
    skipReason?: string;
}

/** 各模式的标题与选择音源一步的说明文案 */
const MODE_META: Record<TSheetFixMode, { label: string; hint: string }> = {
    rematch: {
        label: "重新匹配音乐",
        hint: "选择用哪些音源来匹配（可多选）：流媒体曲目全部重新匹配，本地文件只处理已丢失的",
    },
    repair: {
        label: "修复音源",
        hint: "将先逐首检查音源能否播放，失效的只用选中的音源匹配替换，正常的自动跳过",
    },
    replacer: {
        label: "替换音源",
        hint: "指定一个音源，用它匹配到的版本替换曲目（本地文件只处理已丢失的）",
    },
};

function rowKeyOf(item: IMusic.IMusicItem) {
    return `${item.platform}-${item.id}`;
}

function formatPairJoin(...parts: (string | undefined)[]) {
    return parts.filter(Boolean).join(" · ");
}

export default function SheetFixPanelHost() {
    const [req, setReq] = useState<ISheetFixRequest | null>(null);
    const [stage, setStage] = useState<TStage>("sources");
    const [error, setError] = useState("");
    const [rows, setRows] = useState<IFixRow[]>([]);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [progress, setProgress] = useState({ done: 0, total: 0 });
    const [healthySkipped, setHealthySkipped] = useState(0);
    const [availableSources, setAvailableSources] = useState<SerializedPlugin[] | null>(null);
    const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
    /** 进行中的流水线编号：关弹窗 / 新请求 / 再次点开始都会自增，旧流程的异步回调不再落地 */
    const runIdRef = useRef(0);

    useEffect(() => {
        panelListener = (next) => setReq(next);
        return () => {
            panelListener = null;
        };
    }, []);

    const close = useCallback(() => {
        runIdRef.current += 1;
        setReq(null);
    }, []);

    // 每次请求进来先停在「选择音源」一步，拉一份当前可用的音源插件
    useEffect(() => {
        if (!req) {
            return;
        }
        runIdRef.current += 1;
        setStage("sources");
        setError("");
        setRows([]);
        setChecked(new Set());
        setProgress({ done: 0, total: 0 });
        setHealthySkipped(0);
        setAvailableSources(null);
        setSelectedSources(new Set());
        let cancelled = false;
        getMatchableSourcePlugins()
            .then((plugins) => {
                if (cancelled) {
                    return;
                }
                setAvailableSources(plugins);
                // 多选模式默认全选；替换音源模式必须用户自己挑一个
                if (req.mode !== "replacer") {
                    setSelectedSources(new Set(plugins.map((p) => p.hash)));
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setAvailableSources([]);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [req]);

    /** 确认音源后启动检查 → 匹配 → 对比确认 */
    const startFlow = async (hashes: string[]) => {
        if (!req) {
            return;
        }
        const id = ++runIdRef.current;
        const alive = () => runIdRef.current === id;
        const { mode, items } = req;
        try {
            // ---- 阶段一：健康检查 ----
            // 修复模式全部要查；重匹/替换音源模式只查本地文件（流媒体一律重配）。
            const toCheck = mode === "repair" ? items : items.filter((it) => it.localPath);
            const healthMap = new Map<string, ITrackHealth>();
            if (toCheck.length) {
                setStage("checking");
                setProgress({ done: 0, total: toCheck.length });
                const results = await checkMusicHealthMany(toCheck, {
                    shouldContinue: alive,
                    onProgress: (done, total) => {
                        if (alive()) {
                            setProgress({ done, total });
                        }
                    },
                });
                if (!alive()) {
                    return;
                }
                toCheck.forEach((it, i) => healthMap.set(rowKeyOf(it), results[i]));
            }

            // 进入匹配的目标：修复模式只要失效的；其余模式流媒体全要 + 失效的本地文件
            const targets = items.filter((it) => {
                const health = healthMap.get(rowKeyOf(it));
                if (mode === "repair") {
                    return !!health && !health.ok;
                }
                return it.localPath ? !!health && !health.ok : true;
            });
            const skippedHealthy = items.length - targets.length;
            if (!alive()) {
                return;
            }
            setHealthySkipped(skippedHealthy);
            if (!targets.length) {
                showToast(
                    mode === "repair"
                        ? `检查完成：${items.length} 首音源全部正常，无需修复`
                        : "没有需要重新匹配的曲目",
                );
                close();
                return;
            }

            // ---- 阶段二：匹配（只用选中的音源） ----
            setStage("matching");
            setProgress({ done: 0, total: targets.length });
            setRows(
                targets.map((it) => ({
                    key: rowKeyOf(it),
                    original: it,
                    health: healthMap.get(rowKeyOf(it)),
                    candidate: null,
                })),
            );
            const resultByKey = new Map<string, ISongMatch>();
            const results = await matchMusicItems(targets, {
                sourceHashes: hashes,
                shouldContinue: alive,
                onProgress: (done, total) => {
                    if (alive()) {
                        setProgress({ done, total });
                    }
                },
                onResult: (r) => {
                    if (!alive()) {
                        return;
                    }
                    resultByKey.set(r.song.id, r);
                    setRows((prev) =>
                        prev.map((row) =>
                            row.key === r.song.id
                                ? { ...row, match: r, ...describeReplacement(row.original, r) }
                                : row,
                        ),
                    );
                },
            });
            if (!alive()) {
                return;
            }
            results.forEach((r) => resultByKey.set(r.song.id, r));

            // ---- 阶段三：对比确认（默认全选可替换的行） ----
            const finalRows: IFixRow[] = targets.map((it) => {
                const key = rowKeyOf(it);
                const match = resultByKey.get(key);
                return {
                    key,
                    original: it,
                    health: healthMap.get(key),
                    match,
                    ...describeReplacement(it, match),
                };
            });
            setRows(finalRows);
            setChecked(new Set(finalRows.filter((r) => r.candidate).map((r) => r.key)));
            setStage("review");
        } catch (e: any) {
            if (!alive()) {
                return;
            }
            setError(e?.message ?? String(e ?? "匹配失败"));
            setStage("error");
        }
    };

    const toggleSource = (hash: string) => {
        setSelectedSources((prev) => {
            // 替换音源模式是单选：点已选中的再点一下取消
            if (req?.mode === "replacer") {
                return prev.has(hash) ? new Set() : new Set([hash]);
            }
            const next = new Set(prev);
            if (next.has(hash)) {
                next.delete(hash);
            } else {
                next.add(hash);
            }
            return next;
        });
    };

    const replaceableRows = rows.filter((r) => r.candidate);
    const checkedCount = replaceableRows.filter((r) => checked.has(r.key)).length;
    const multi = rows.length > 1;
    const missedCount = rows.length - replaceableRows.length;
    const singleSourceMode = req?.mode === "replacer";
    const canStart = singleSourceMode ? selectedSources.size === 1 : selectedSources.size > 0;
    const defaultPluginHash = localStorage.getItem("defaultPluginHash");

    /** 摘要一行说清：查了多少、跳了多少、多少能换 */
    const summary = (() => {
        const parts: string[] = [];
        if (req) {
            if (req.mode === "repair") {
                parts.push(
                    `检查了 ${rows.length + healthySkipped} 首：${healthySkipped} 首正常已跳过，${rows.length} 首音源失效`,
                );
            } else if (healthySkipped > 0) {
                parts.push(
                    `共 ${rows.length + healthySkipped} 首：${healthySkipped} 首本地音乐有效已跳过`,
                );
            }
        }
        if (rows.length) {
            parts.push(
                `可替换 ${replaceableRows.length} 首${missedCount ? ` · ${missedCount} 首无可替换候选` : ""}`,
            );
        }
        return parts.join("；");
    })();

    const toggleRow = (key: string) => {
        setChecked((prev) => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    };

    const toggleAll = () => {
        setChecked((prev) =>
            prev.size >= replaceableRows.length && replaceableRows.length > 0
                ? new Set()
                : new Set(replaceableRows.map((r) => r.key)),
        );
    };

    const applyChecked = async () => {
        if (!req) {
            return;
        }
        const pairs = replaceableRows
            .filter((r) => checked.has(r.key))
            .map((r) => ({ from: r.original, to: r.candidate! }));
        if (!pairs.length) {
            return;
        }
        setStage("applying");
        try {
            const { applied, skipped, appliedPairs } = await applySheetReplacements(
                req.sheetId,
                pairs,
            );
            // 播放队列里的同一首歌同步换成新条目（正在播的那首除外）
            TrackPlayerSingleton.replaceMusicInQueue(appliedPairs);
            showToast(
                applied
                    ? `已替换 ${applied} 首音源${skipped ? `，另有 ${skipped} 首因与其他歌曲重复被跳过` : ""}`
                    : "没有实际替换的曲目",
            );
            req.onDone?.();
            close();
        } catch (e: any) {
            setStage("review");
            showToast(`替换失败：${e?.message ?? e}`);
        }
    };

    if (!req) {
        return null;
    }

    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    const modeMeta = MODE_META[req.mode];
    const chosenSources =
        availableSources?.filter((p) => selectedSources.has(p.hash)) ?? [];
    const matchingLabel =
        chosenSources.length === 1
            ? `正在用「${chosenSources[0].name}」逐首匹配…`
            : `正在用 ${chosenSources.length} 个音源逐首匹配…`;

    return (
        <div className="panel-mask" onClick={close}>
            <div
                className="panel-body sheet-fix-body"
                style={{ width: 660 }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="sheet-fix-head">
                    <div style={{ fontSize: 16, fontWeight: 600 }}>
                        {modeMeta.label}
                        <span className="sheet-fix-head-sub">「{req.sheetTitle}」</span>
                    </div>
                    <Icon name="close" size={16} style={{ cursor: "pointer" }} onClick={close} />
                </div>

                {stage === "sources" && (
                    <>
                        <div className="sheet-fix-summary">{modeMeta.hint}</div>
                        <div className="sheet-fix-list">
                            {availableSources === null ? (
                                <div className="sheet-fix-note">正在获取可用音源…</div>
                            ) : availableSources.length === 0 ? (
                                <div className="sheet-fix-note">
                                    没有可用的音源插件，请先在「音源插件」中安装并启用
                                </div>
                            ) : (
                                availableSources.map((p) => {
                                    const isChecked = selectedSources.has(p.hash);
                                    return (
                                        <div
                                            className="sheet-fix-row clickable"
                                            key={p.hash}
                                            onClick={() => toggleSource(p.hash)}
                                        >
                                            <div
                                                className={`music-row-check sheet-fix-check${isChecked ? " checked" : ""}`}
                                            >
                                                {isChecked && <Icon name="check" size={11} />}
                                            </div>
                                            <div className="sheet-fix-cell">
                                                <div className="sheet-fix-title">
                                                    {p.name}
                                                    {p.hash === defaultPluginHash && (
                                                        <span className="tag">默认</span>
                                                    )}
                                                </div>
                                                <div className="sheet-fix-sub">
                                                    <span className="sheet-fix-ellipsis">
                                                        {p.platform === p.name
                                                            ? `v${p.version}`
                                                            : p.platform}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                        <div className="sheet-fix-footer">
                            <div className="sheet-fix-footer-left">
                                {!singleSourceMode &&
                                    availableSources &&
                                    availableSources.length > 0 && (
                                        <>
                                            <button
                                                className="btn-ghost"
                                                onClick={() =>
                                                    setSelectedSources((prev) =>
                                                        availableSources.length &&
                                                        prev.size >= availableSources.length
                                                            ? new Set()
                                                            : new Set(
                                                                  availableSources.map(
                                                                      (p) => p.hash,
                                                                  ),
                                                              ),
                                                    )
                                                }
                                            >
                                                {availableSources.length &&
                                                selectedSources.size >= availableSources.length
                                                    ? "取消全选"
                                                    : "全选"}
                                            </button>
                                            <span className="sheet-fix-selected">
                                                已选 {selectedSources.size}/
                                                {availableSources.length}
                                            </span>
                                        </>
                                    )}
                            </div>
                            <div className="sheet-fix-footer-actions">
                                <button className="btn-ghost" onClick={close}>
                                    取消
                                </button>
                                <button
                                    className="btn-primary"
                                    disabled={!canStart}
                                    onClick={() => startFlow([...selectedSources])}
                                >
                                    开始匹配
                                </button>
                            </div>
                        </div>
                    </>
                )}

                {(stage === "checking" || stage === "matching") && (
                    <div className="sheet-fix-stage">
                        <div className="sheet-fix-stage-text">
                            <span className="sheet-fix-stage-spin" aria-hidden>
                                <Icon name="musicNote" size={13} />
                            </span>
                            {stage === "checking"
                                ? "正在逐首检查音源可用性…"
                                : matchingLabel}
                            <span className="sheet-fix-stage-count">
                                {progress.done}/{progress.total}
                            </span>
                        </div>
                        <div className="netease-progress">
                            <div style={{ width: `${pct}%` }} />
                        </div>
                        <div className="sheet-fix-stage-hint">
                            {stage === "checking"
                                ? "正常的曲目会自动跳过，只有失效的才进入匹配"
                                : "完成后可以逐首对比替换前后的曲目再确认"}
                        </div>
                    </div>
                )}

                {stage === "error" && (
                    <div className="sheet-fix-error">
                        <Icon name="close" size={22} />
                        <div>{error}</div>
                        <button className="btn-ghost" onClick={close}>
                            知道了
                        </button>
                    </div>
                )}

                {(stage === "review" || stage === "applying") && (
                    <>
                        <div className="sheet-fix-summary">{summary}</div>
                        <div className="sheet-fix-list">
                            {rows.map((row) => {
                                const replaceable = !!row.candidate;
                                const isChecked = replaceable && checked.has(row.key);
                                return (
                                    <div className="sheet-fix-row" key={row.key}>
                                        {multi && (
                                            <div
                                                className={`music-row-check sheet-fix-check${
                                                    isChecked ? " checked" : ""
                                                }${replaceable ? "" : " disabled"}`}
                                                title={
                                                    replaceable
                                                        ? isChecked
                                                            ? "取消选择"
                                                            : "选择替换"
                                                        : row.skipReason
                                                }
                                                onClick={() => replaceable && toggleRow(row.key)}
                                            >
                                                {isChecked && <Icon name="check" size={11} />}
                                            </div>
                                        )}
                                        <div className="sheet-fix-cell">
                                            <div className="sheet-fix-cell-head">
                                                <Cover
                                                    src={row.original.artwork}
                                                    size={32}
                                                    borderRadius={4}
                                                />
                                                <div className="sheet-fix-cell-text">
                                                    <div
                                                        className="sheet-fix-title"
                                                        title={row.original.title}
                                                    >
                                                        {row.original.title}
                                                    </div>
                                                    <div className="sheet-fix-sub">
                                                        <span className="sheet-fix-src">
                                                            {row.original.platform}
                                                        </span>
                                                        <span className="sheet-fix-ellipsis">
                                                            {formatPairJoin(
                                                                row.original.artist,
                                                                row.original.album,
                                                            )}
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>
                                            {row.health && !row.health.ok && (
                                                <span className="sheet-fix-tag danger">
                                                    {row.health.reason}
                                                </span>
                                            )}
                                        </div>
                                        <Icon
                                            name="forward"
                                            size={13}
                                            className="sheet-fix-arrow"
                                        />
                                        <div className="sheet-fix-cell after">
                                            {row.candidate ? (
                                                <div className="sheet-fix-cell-head">
                                                    <Cover
                                                        src={row.candidate.artwork}
                                                        size={32}
                                                        borderRadius={4}
                                                    />
                                                    <div className="sheet-fix-cell-text">
                                                        <div
                                                            className="sheet-fix-title"
                                                            title={row.candidate.title}
                                                        >
                                                            {row.candidate.title}
                                                        </div>
                                                        <div className="sheet-fix-sub">
                                                            <span className="sheet-fix-src">
                                                                {row.candidate.platform}
                                                            </span>
                                                            <span className="sheet-fix-ellipsis">
                                                                {formatPairJoin(
                                                                    row.candidate.artist,
                                                                    row.candidate.album,
                                                                )}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="sheet-fix-note">
                                                    {row.skipReason ?? "未找到合适的替换"}
                                                </div>
                                            )}
                                            {row.candidate && row.match?.score != null && (
                                                <span
                                                    className={`sheet-fix-score${
                                                        row.match.low || row.match.viaDetail
                                                            ? " low"
                                                            : ""
                                                    }`}
                                                    title="匹配相似度"
                                                >
                                                    {Math.round(row.match.score * 100)}%
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="sheet-fix-footer">
                            {multi ? (
                                <div className="sheet-fix-footer-left">
                                    <button className="btn-ghost" onClick={toggleAll}>
                                        {checkedCount >= replaceableRows.length &&
                                        replaceableRows.length > 0
                                            ? "取消全选"
                                            : "全选"}
                                    </button>
                                    <span className="sheet-fix-selected">
                                        已选 {checkedCount}/{replaceableRows.length}
                                    </span>
                                </div>
                            ) : (
                                <span />
                            )}
                            <div className="sheet-fix-footer-actions">
                                <button className="btn-ghost" onClick={close}>
                                    取消
                                </button>
                                <button
                                    className="btn-primary"
                                    disabled={!checkedCount || stage === "applying"}
                                    onClick={applyChecked}
                                >
                                    {stage === "applying"
                                        ? "替换中…"
                                        : multi
                                          ? `替换选中 ${checkedCount} 首`
                                          : "替换"}
                                </button>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
