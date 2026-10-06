import React, { useEffect, useMemo, useRef, useState } from "react";
import Cover from "@/components/base/Cover";
import Icon from "@/components/base/Icon";
import MusicList from "@/components/base/MusicList";
import { showToast } from "@/components/base/Toast";
import {
    addMusicToSheetMany,
    createSheet,
    getUserSheets,
} from "@/core/musicSheet";
import {
    INeteasePlaylistCard,
    INeteaseSong,
    NeteaseNeedLoginError,
    fetchNeteaseDailySongs,
    fetchNeteasePersonalizedPlaylists,
    fetchNeteasePlaylistDetail,
    fetchNeteaseRecommendPlaylists,
    formatPlayCount,
    getNeteaseStatus,
    openNeteaseLogin,
} from "@/core/netease";
import { ISongMatch, matchNeteaseSongs } from "@/core/neteaseMatch";

/**
 * 每日推荐（网易云）：扫码登录后拉取账号的个性化推荐——
 *  - 每日推荐歌曲：用已启用的音源插件逐首匹配成可播放曲目，一键存为本地歌单「日推 YYYY-MM-DD」；
 *  - 推荐歌单（每日推荐 + 个性化网格）：点开整单匹配，确认后写入本地歌单（同名追加去重）。
 *
 * cookie 只在主进程（safeStorage 加密），本页只经 IPC 拿归一化数据。
 */

function dateStr(d = new Date()) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type Phase = "loading" | "anonymous" | "ready";

export default function NeteaseDailyPage() {
    const [phase, setPhase] = useState<Phase>("loading");
    const [expired, setExpired] = useState(false);
    const [songs, setSongs] = useState<INeteaseSong[]>([]);
    const [dailyError, setDailyError] = useState("");
    const [playlists, setPlaylists] = useState<INeteasePlaylistCard[]>([]);
    const [playlistsError, setPlaylistsError] = useState("");
    // 匹配结果按网易云歌曲 id 索引，命中一首渲染一首
    const [matches, setMatches] = useState<Record<string, ISongMatch>>({});
    const [matchDone, setMatchDone] = useState(0);
    const [matchTotal, setMatchTotal] = useState(0);
    const [matchError, setMatchError] = useState("");
    const [importCard, setImportCard] = useState<INeteasePlaylistCard | null>(null);
    const [reloadKey, setReloadKey] = useState(0);
    // 匹配会话号：重载/卸载后旧会话的结果全部作废
    const matchRunIdRef = useRef(0);

    useEffect(() => {
        let cancelled = false;
        const runId = ++matchRunIdRef.current;
        setPhase("loading");
        setExpired(false);
        setSongs([]);
        setPlaylists([]);
        setMatches({});
        setMatchDone(0);
        setMatchTotal(0);
        setMatchError("");
        setDailyError("");
        setPlaylistsError("");
        (async () => {
            try {
                const status = await getNeteaseStatus();
                if (cancelled) {
                    return;
                }
                if (!status.loggedIn) {
                    setPhase("anonymous");
                    return;
                }
            } catch {
                if (!cancelled) {
                    setPhase("anonymous");
                }
                return;
            }

            let needLogin = false;
            let dailySongs: INeteaseSong[] = [];
            let cards: INeteasePlaylistCard[] = [];
            try {
                dailySongs = await fetchNeteaseDailySongs();
            } catch (e: any) {
                if (e instanceof NeteaseNeedLoginError) {
                    needLogin = true;
                } else if (!cancelled) {
                    setDailyError(e?.message ?? "每日推荐歌曲获取失败");
                }
            }
            try {
                const dailyCards = await fetchNeteaseRecommendPlaylists();
                const personalized = await fetchNeteasePersonalizedPlaylists();
                // 每日推荐在前，按歌单 id 去重合并个性化网格
                const seen = new Set<string>();
                cards = [];
                for (const c of [...dailyCards, ...personalized]) {
                    if (!seen.has(c.id)) {
                        seen.add(c.id);
                        cards.push(c);
                    }
                }
            } catch (e: any) {
                if (e instanceof NeteaseNeedLoginError) {
                    needLogin = true;
                } else if (!cancelled) {
                    setPlaylistsError(e?.message ?? "推荐歌单获取失败");
                }
            }
            if (cancelled) {
                return;
            }
            if (needLogin && !dailySongs.length) {
                setDailyError("网易云登录已过期，请重新扫码登录");
            }
            if (needLogin && !dailySongs.length && !cards.length) {
                setExpired(true);
                setPhase("anonymous");
                return;
            }
            setSongs(dailySongs);
            setPlaylists(cards);
            setPhase("ready");
            if (dailySongs.length) {
                matchNeteaseSongs(dailySongs, {
                    onProgress: (done) => {
                        if (matchRunIdRef.current === runId) {
                            setMatchDone(done);
                        }
                    },
                    onResult: (r) => {
                        if (matchRunIdRef.current === runId) {
                            setMatches((prev) => ({ ...prev, [r.song.id]: r }));
                        }
                    },
                    shouldContinue: () => matchRunIdRef.current === runId,
                }).catch((e: any) => {
                    if (matchRunIdRef.current === runId) {
                        // 匹配没跑起来（如没有可用音源）：清掉进度，header 别停在「正在匹配 0/30」
                        setMatchDone(0);
                        setMatchTotal(0);
                        setMatchError(e?.message ?? "匹配失败");
                    }
                });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [reloadKey]);

    const matchedItems = useMemo(
        () =>
            songs
                .map((s) => matches[s.id])
                .filter((m) => m?.status === "matched" && !m.duplicate)
                .map((m) => m.item!),
        [songs, matches],
    );
    const missedMatches = useMemo(
        () =>
            songs
                .map((s) => matches[s.id])
                .filter((m) => m?.status === "missed" || m?.duplicate),
        [songs, matches],
    );
    const lowCount = useMemo(
        () =>
            Object.values(matches).filter(
                (m) => m.status === "matched" && !m.duplicate && (m.viaDetail || m.low),
            ).length,
        [matches],
    );
    const matching = matchTotal > 0 && matchDone < matchTotal;
    const cachedCount = useMemo(
        () => Object.values(matches).filter((m) => m.fromCache).length,
        [matches],
    );

    const saveDailyAsSheet = async () => {
        if (!matchedItems.length) {
            return;
        }
        const title = `日推 ${dateStr()}`;
        try {
            const sheets = await getUserSheets();
            const existed = sheets.find((s) => s.title === title);
            const sheet = existed ?? (await createSheet(title));
            const { added, skipped } = await addMusicToSheetMany(sheet.id, matchedItems);
            showToast(
                `已保存到「${title}」：新增 ${added} 首${skipped ? `，跳过重复 ${skipped} 首` : ""}` +
                    (missedMatches.length ? `；${missedMatches.length} 首未匹配到音源` : ""),
            );
        } catch (e: any) {
            showToast(`保存失败：${e?.message ?? "未知错误"}`);
        }
    };

    const openLogin = async () => {
        const res = await openNeteaseLogin();
        if (res.success) {
            showToast("网易云登录成功");
            setReloadKey((k) => k + 1);
        } else if (!res.canceled) {
            showToast(res.message ?? "登录未完成");
        }
    };

    return (
        <div>
            <div className="page-header">
                <div className="page-header-row">
                    <div>
                        <div className="page-header-title">每日推荐</div>
                        <div className="page-header-sub">
                            {phase === "ready" && songs.length > 0
                                ? matching
                                    ? `正在用已启用的音源逐首匹配 ${matchDone}/${matchTotal}…`
                                    : `命中 ${matchedItems.length}/${songs.length}${
                                          lowCount ? `（低置信 ${lowCount}）` : ""
                                      }${missedMatches.length ? `，未匹配 ${missedMatches.length}` : ""}`
                                : "网易云账号的个性化推荐，匹配后可直接播放、一键入库"}
                        </div>
                    </div>
                    <div className="netease-header-actions">
                        {phase === "ready" && !matching && matchedItems.length > 0 && (
                            <button className="btn-primary" onClick={saveDailyAsSheet}>
                                <Icon name="addToSheet" size={14} />
                                存为本地歌单
                            </button>
                        )}
                        <button
                            className="btn-ghost"
                            title="重新加载"
                            onClick={() => setReloadKey((k) => k + 1)}
                        >
                            <Icon name="forward" size={14} />
                        </button>
                    </div>
                </div>
            </div>

            {phase === "loading" && (
                <div className="empty-hint">正在连接网易云账号…</div>
            )}

            {phase === "anonymous" && (
                <div className="empty-hint">
                    {expired
                        ? "网易云登录已过期，重新扫码后即可继续获取个性化每日推荐"
                        : "尚未登录网易云。扫码登录后，这里会展示账号的个性化每日推荐（歌曲与歌单），并用你的音源插件匹配成可直接播放的曲目"}
                    <div style={{ marginTop: 12 }}>
                        <button className="btn-primary" onClick={openLogin}>
                            {expired ? "重新扫码登录" : "扫码登录网易云"}
                        </button>
                    </div>
                </div>
            )}

            {phase === "ready" && (
                <>
                    {matchError && (
                        <div className="source-note">{matchError}</div>
                    )}
                    {!matchError && !!missedMatches.length && !matching && (
                        <details className="netease-missed">
                            <summary>
                                未匹配到音源的 {missedMatches.length} 首（点开查看）
                            </summary>
                            <div className="netease-missed-list">
                                {missedMatches.map((m) => {
                                    const idx = songs.findIndex((s) => s.id === m.song.id) + 1;
                                    return (
                                        <div key={m.song.id}>
                                            #{idx} {m.song.name} - {m.song.artists.join("/")}
                                            {m.duplicate
                                                ? "（与前面歌曲重复，已跳过）"
                                                : m.bestTitle
                                                  ? `（最佳候选：${m.bestTitle}）`
                                                  : "（无候选）"}
                                        </div>
                                    );
                                })}
                            </div>
                        </details>
                    )}

                    {songs.length > 0 ? (
                        matching ? (
                            // 匹配期间列表区域整体显示动效面板，完成后一次性替换为完整列表
                            <MatchingPanel
                                done={matchDone}
                                total={matchTotal}
                                matchedCount={matchedItems.length}
                                cachedCount={cachedCount}
                            />
                        ) : (
                            <MusicList
                                musicList={matchedItems}
                                listId={`netease-daily-${dateStr()}`}
                                searchable
                                selectable={false}
                                className="netease-list-in"
                            />
                        )
                    ) : (
                        !dailyError && <div className="empty-hint">今天暂时没有推荐歌曲</div>
                    )}
                    {dailyError && <div className="source-note">每日推荐歌曲获取失败：{dailyError}</div>}

                    {(playlists.length > 0 || playlistsError) && (
                        <section className="home-section">
                            <div className="section-title">推荐歌单</div>
                            {playlistsError && (
                                <div className="source-note">
                                    推荐歌单获取失败：{playlistsError}
                                </div>
                            )}
                            {playlists.length > 0 && (
                                <>
                                    <div className="source-note">
                                        点击歌单会用已启用的音源逐首匹配，确认后写入本地歌单
                                    </div>
                                    <div className="card-grid">
                                        {playlists.map((card) => (
                                            <div
                                                key={card.id}
                                                className="media-card"
                                                onClick={() => setImportCard(card)}
                                            >
                                                <div className="square-cover">
                                                    <Cover
                                                        src={card.artwork}
                                                        size="100%"
                                                        borderRadius={8}
                                                        style={{ width: "100%", height: "100%" }}
                                                    />
                                                </div>
                                                <div className="media-card-title">{card.title}</div>
                                                <div className="media-card-subtitle">
                                                    {[
                                                        formatPlayCount(card.playCount)
                                                            ? `${formatPlayCount(card.playCount)}次播放`
                                                            : "",
                                                        card.trackCount ? `${card.trackCount}首` : "",
                                                    ]
                                                        .filter(Boolean)
                                                        .join(" · ")}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </>
                            )}
                        </section>
                    )}
                </>
            )}

            {importCard && (
                <PlaylistImportDialog
                    card={importCard}
                    onClose={() => setImportCard(null)}
                />
            )}
        </div>
    );
}

/**
 * 匹配进行中的整体动效面板：与单曲无关，占住列表区域转唱片 + 走进度条，
 * 匹配完成后整个列表一次性替换进来（列表侧用 netease-list-in 淡入）。
 */
function MatchingPanel(props: {
    done: number;
    total: number;
    matchedCount: number;
    cachedCount: number;
}) {
    const pct = props.total ? Math.round((props.done / props.total) * 100) : 0;
    return (
        <div className="netease-matching-panel">
            <div className="netease-matching-disc">
                <Icon name="musicNote" size={26} />
            </div>
            <div className="netease-matching-title">正在用已启用的音源逐首匹配</div>
            <div className="netease-matching-sub">
                {props.cachedCount > 0 ? `缓存命中 ${props.cachedCount} · ` : ""}
                已处理 {props.done}/{props.total}，命中 {props.matchedCount}
            </div>
            <div className="netease-progress">
                <div style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
}

/**
 * 歌单导入弹窗：拉全量曲目 → 自动匹配（可中途取消）→ 出对照摘要 → 确认写入。
 * 目标歌单按标题查找：已有同名歌单直接追加（addMusicToSheetMany 会去重），否则新建。
 */
function PlaylistImportDialog(props: { card: INeteasePlaylistCard; onClose: () => void }) {
    const { card, onClose } = props;
    const [stage, setStage] = useState<"loading" | "matching" | "done" | "saving">("loading");
    const [error, setError] = useState("");
    const [songs, setSongs] = useState<INeteaseSong[]>([]);
    const [results, setResults] = useState<ISongMatch[]>([]);
    const [progress, setProgress] = useState({ done: 0, total: 0 });
    const [appending, setAppending] = useState(false);
    const runIdRef = useRef(0);

    useEffect(() => {
        const runId = ++runIdRef.current;
        let cancelled = false;
        (async () => {
            try {
                const { songs } = await fetchNeteasePlaylistDetail(card.id);
                if (cancelled) {
                    return;
                }
                setSongs(songs);
                setStage("matching");
                setProgress({ done: 0, total: songs.length });
                const all = await matchNeteaseSongs(songs, {
                    onProgress: (done, total) => {
                        if (!cancelled && runIdRef.current === runId) {
                            setProgress({ done, total });
                        }
                    },
                    onResult: (r) => {
                        if (!cancelled && runIdRef.current === runId) {
                            setResults((prev) => [...prev, r]);
                        }
                    },
                    shouldContinue: () => !cancelled && runIdRef.current === runId,
                });
                if (cancelled) {
                    return;
                }
                setResults(all);
                setStage("done");
            } catch (e: any) {
                if (!cancelled) {
                    setError(e?.message ?? "加载失败");
                }
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const accepted = useMemo(
        () => results.filter((r) => r.status === "matched" && !r.duplicate),
        [results],
    );
    const missed = useMemo(
        () => results.filter((r) => r.status === "missed" || r.duplicate),
        [results],
    );
    const lowCount = accepted.filter((r) => r.viaDetail || r.low).length;

    useEffect(() => {
        // 弹窗打开时就查一次同名歌单，按钮文案能提前说清楚是「追加」还是「新建」
        getUserSheets().then((sheets) => {
            setAppending(sheets.some((s) => s.title === card.title));
        });
    }, [card.title]);

    const confirmImport = async () => {
        if (!accepted.length) {
            return;
        }
        setStage("saving");
        try {
            const sheets = await getUserSheets();
            const existed = sheets.find((s) => s.title === card.title);
            const sheet = existed ?? (await createSheet(card.title));
            const { added, skipped } = await addMusicToSheetMany(
                sheet.id,
                accepted.map((r) => r.item!),
            );
            showToast(
                `已导入「${card.title}」：新增 ${added} 首${skipped ? `，跳过重复 ${skipped} 首` : ""}` +
                    (missed.length ? `；${missed.length} 首未匹配到音源` : ""),
            );
            onClose();
        } catch (e: any) {
            setStage("done");
            showToast(`导入失败：${e?.message ?? "未知错误"}`);
        }
    };

    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    const liveMatched = accepted.length;

    return (
        <div
            className="netease-modal-mask"
            onClick={() => {
                if (stage !== "saving") {
                    onClose();
                }
            }}
        >
            <div className="netease-modal" onClick={(e) => e.stopPropagation()}>
                <div className="netease-modal-title">导入歌单「{card.title}」</div>

                {error ? (
                    <>
                        <div className="netease-modal-error">{error}</div>
                        <div className="netease-modal-actions">
                            <button className="btn-primary" onClick={onClose}>
                                知道了
                            </button>
                        </div>
                    </>
                ) : stage === "loading" ? (
                    <div className="netease-modal-hint">正在获取歌单全量曲目…</div>
                ) : stage === "matching" ? (
                    <>
                        <div className="netease-modal-hint">
                            正在用已启用的音源逐首匹配 {progress.done}/{progress.total}
                            （已命中 {liveMatched}），可关闭弹窗取消
                        </div>
                        <div className="netease-progress">
                            <div style={{ width: `${pct}%` }} />
                        </div>
                    </>
                ) : stage === "saving" ? (
                    <div className="netease-modal-hint">正在写入本地歌单…</div>
                ) : (
                    <>
                        <div className="netease-summary">
                            共 {songs.length} 首 · 命中 {accepted.length}
                            {lowCount ? `（低置信 ${lowCount}）` : ""} · 未命中 {missed.length}
                        </div>
                        {lowCount > 0 && (
                            <div className="netease-modal-hint">
                                低置信 = 靠专辑+时长复核才采信或得分刚过线，导入后建议试听确认
                            </div>
                        )}
                        {missed.length > 0 && (
                            <div className="netease-missed-list">
                                {missed.map((m) => {
                                    const idx = songs.findIndex((s) => s.id === m.song.id) + 1;
                                    return (
                                        <div key={m.song.id}>
                                            #{idx} {m.song.name} - {m.song.artists.join("/")}
                                            {m.duplicate
                                                ? "（与前面歌曲重复，已跳过）"
                                                : m.bestTitle
                                                  ? `（最佳候选：${m.bestTitle}）`
                                                  : "（无候选）"}
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        <div className="netease-modal-actions">
                            <button className="btn-ghost" onClick={onClose}>
                                取消
                            </button>
                            <button
                                className="btn-primary"
                                disabled={!accepted.length}
                                onClick={confirmImport}
                            >
                                {appending ? "追加到" : "导入"}歌单「{card.title}」
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
