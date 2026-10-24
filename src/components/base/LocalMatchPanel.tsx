import React, { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import Cover from "./Cover";
import { showToast } from "./Toast";
import { SerializedPlugin } from "@/core/ipc";
import { getMatchableSourcePlugins } from "@/core/neteaseMatch";
import {
    ILocalMatchOutcome,
    matchLocalTrack,
    resolveCurrentSourcePlugin,
    startLocalBatchMatch,
} from "@/core/localMusicMatch";

/**
 * 本地音乐歌词/封面匹配的音源选择弹窗（批量 + 单曲共用一个宿主）：
 *  - batch：选音源后启动模块级批量会话（进度条在本地音乐列表顶部，关弹窗不中断）；
 *  - single：单曲匹配，弹窗里等结果，完成后回调 onDone（详情页刷新歌词用）。
 *
 * 默认选中「当前音源」= 搜索页记住的音源，其次默认音源（resolveCurrentSourcePlugin）。
 * 样式复用歌单音源管理弹窗（SheetFixPanel）的一套 sheet-fix-* 类。
 */

export interface ILocalMatchRequest {
    /** batch: 整份本地列表；single: 单首（详情页 / 右键菜单入口） */
    mode: "batch" | "single";
    items: IMusic.IMusicItem[];
    /** 单曲匹配结束后的回调（无论成败；详情页据 outcome 刷新歌词） */
    onDone?: (outcome: ILocalMatchOutcome) => void;
}

let panelListener: ((req: ILocalMatchRequest) => void) | null = null;

export function showLocalMatchPanel(req: ILocalMatchRequest) {
    panelListener?.(req);
}

export default function LocalMatchPanelHost() {
    const [req, setReq] = useState<ILocalMatchRequest | null>(null);
    const [sources, setSources] = useState<SerializedPlugin[] | null>(null);
    /** 单选：空串 = 还没选（打开时自动选中当前音源） */
    const [selectedHash, setSelectedHash] = useState("");
    /** 「当前音源」是哪个：列表里给它挂标识，与用户后来改选了哪个无关 */
    const [defaultHash, setDefaultHash] = useState("");
    const [running, setRunning] = useState(false);
    const runIdRef = useRef(0);

    useEffect(() => {
        panelListener = (next) => setReq(next);
        return () => {
            panelListener = null;
        };
    }, []);

    useEffect(() => {
        if (!req) {
            return;
        }
        const id = ++runIdRef.current;
        setSources(null);
        setSelectedHash("");
        setDefaultHash("");
        setRunning(false);
        let cancelled = false;
        (async () => {
            const [list, current] = await Promise.all([
                getMatchableSourcePlugins().catch(() => [] as SerializedPlugin[]),
                resolveCurrentSourcePlugin(),
            ]);
            if (cancelled || runIdRef.current !== id) {
                return;
            }
            setSources(list);
            setDefaultHash(current?.hash ?? "");
            setSelectedHash(current?.hash ?? "");
        })();
        return () => {
            cancelled = true;
        };
    }, [req]);

    if (!req) {
        return null;
    }

    const close = () => {
        runIdRef.current += 1;
        setReq(null);
    };

    const start = async () => {
        const plugin = sources?.find((p) => p.hash === selectedHash) ?? null;
        if (req.mode === "batch") {
            // 会话在模块级跑：进度条在本地音乐列表顶部，弹窗可以立刻收
            if (startLocalBatchMatch(req.items, plugin)) {
                close();
            }
            return;
        }
        const item = req.items[0];
        if (!item) {
            return;
        }
        setRunning(true);
        let outcome: ILocalMatchOutcome;
        try {
            outcome = await matchLocalTrack(item, plugin, { overwrite: true });
        } catch (e: any) {
            outcome = { status: "error", reason: e?.message ?? String(e) };
        }
        setRunning(false);
        if (outcome.status === "matched") {
            const parts = [
                outcome.gotLyric ? "歌词" : null,
                outcome.gotCover ? "封面" : null,
            ].filter(Boolean);
            showToast(`已写入${parts.join("和")}`);
        } else if (outcome.status === "skipped") {
            showToast("这首歌的歌词封面已经齐全");
        } else {
            showToast(`匹配失败：${outcome.reason ?? "未知错误"}`);
        }
        req.onDone?.(outcome);
        close();
    };

    const single = req.mode === "single";
    const item = req.items[0];
    const noSource = !!sources && sources.length === 0;

    return (
        <div className="panel-mask" onClick={running ? undefined : close}>
            <div
                className="panel-body sheet-fix-body"
                style={{ width: 520 }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="sheet-fix-head">
                    <div style={{ fontSize: 16, fontWeight: 600 }}>
                        {single ? "匹配歌词与封面" : "批量匹配歌词封面"}
                    </div>
                    {!running && (
                        <Icon name="close" size={16} style={{ cursor: "pointer" }} onClick={close} />
                    )}
                </div>

                {running ? (
                    <div className="sheet-fix-stage">
                        <div className="sheet-fix-stage-text">
                            <span className="sheet-fix-stage-spin" aria-hidden>
                                <Icon name="musicNote" size={13} />
                            </span>
                            正在搜索并写回…
                        </div>
                        <div className="sheet-fix-stage-hint">
                            歌词与封面会写进音频文件（mp3 / flac 内嵌，其余格式写同名 .lrc）
                        </div>
                    </div>
                ) : (
                    <>
                        {single && item && (
                            <div className="sheet-fix-summary">
                                <span className="local-match-single-track">
                                    <Cover src={item.artwork} size={28} borderRadius={4} />
                                    <span className="sheet-fix-ellipsis">
                                        {item.title} - {item.artist}
                                    </span>
                                </span>
                            </div>
                        )}
                        <div className="sheet-fix-summary">
                            {single
                                ? "从所选音源搜索同名歌曲，把歌词与封面写回本地文件；音源没给的字段保留原值。"
                                : `将对 ${req.items.length} 首本地音乐逐首匹配：歌词封面已齐全的自动跳过，缺什么补什么。匹配在后台进行，可在列表顶部的进度条里取消。`}
                        </div>
                        <div className="sheet-fix-list">
                            {sources === null ? (
                                <div className="sheet-fix-note">正在获取可用音源…</div>
                            ) : noSource ? (
                                <div className="sheet-fix-note">
                                    没有可用的音源插件，请先在「音源插件」中安装并启用
                                </div>
                            ) : (
                                sources.map((p) => {
                                    const isChecked = p.hash === selectedHash;
                                    return (
                                        <div
                                            className="sheet-fix-row clickable"
                                            key={p.hash}
                                            onClick={() => setSelectedHash(p.hash)}
                                        >
                                            <div
                                                className={`music-row-check sheet-fix-check${isChecked ? " checked" : ""}`}
                                            >
                                                {isChecked && <Icon name="check" size={11} />}
                                            </div>
                                            <div className="sheet-fix-cell">
                                                <div className="sheet-fix-title">
                                                    {p.name}
                                                    {p.hash === defaultHash && (
                                                        <span className="tag">当前音源</span>
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
                            <span />
                            <div className="sheet-fix-footer-actions">
                                <button className="btn-ghost" onClick={close}>
                                    取消
                                </button>
                                <button
                                    className="btn-primary"
                                    disabled={!selectedHash || noSource}
                                    onClick={start}
                                >
                                    开始匹配
                                </button>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
