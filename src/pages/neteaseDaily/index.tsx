import React, { useEffect, useMemo, useRef, useState } from "react";
import Cover from "@/components/base/Cover";
import Icon from "@/components/base/Icon";
import MusicList from "@/components/base/MusicList";
import NeteaseMatchingPanel from "@/components/base/NeteaseMatchingPanel";
import { showToast } from "@/components/base/Toast";
import {
    addMusicToSheetMany,
    createSheet,
    getUserSheets,
} from "@/core/musicSheet";
import {
    getCachedNeteaseProfile,
    INeteasePlaylistCard,
    INeteaseProfile,
    INeteaseSong,
    getNeteaseAccountInfo,
    NeteaseNeedLoginError,
    fetchNeteaseDailySongs,
    fetchNeteasePersonalizedPlaylists,
    fetchNeteaseRecommendPlaylists,
    formatPlayCount,
    getNeteaseStatus,
    openNeteaseLogin,
} from "@/core/netease";
import {
    resetAllMatchSessions,
    resetMatchSession,
    startMatchSession,
    startPlaylistMatchSession,
    useMatchSession,
} from "@/core/neteaseMatchSession";
import {
    readPageSnapshot,
    writePageSnapshot,
} from "@/core/pageSnapshot";
import { navigate } from "@/core/router";

/**
 * 每日推荐（网易云）：扫码登录后拉取账号的个性化推荐——
 *  - 每日推荐歌曲：用已启用的音源插件逐首匹配成可播放曲目，一键存为本地歌单「日推 YYYY-MM-DD」；
 *  - 推荐歌单（每日推荐 + 个性化网格）：点进详情页整单匹配，离开页面匹配在后台继续。
 *
 * 匹配都跑在模块级会话（core/neteaseMatchSession）里，本页只负责拉数据、触发和订阅进度。
 *
 * 重挂载不白屏：匹配结果在会话里、推荐歌单网格在页面快照里（按日期分键，跨天自然失效），
 * 切回本页先用它们渲染首帧，网易云接口在后台静默刷新。只有当天首次进入才看到「正在连接」。
 */

const PAGE_KEY = "neteaseDaily";

function dateStr(d = new Date()) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 快照按「日期@账号」分键：换账号不会拿到上个账号的推荐网格 */
function snapshotSourceKey(profile?: INeteaseProfile | null) {
    return `${dateStr()}@${profile?.userId ?? ""}`;
}

interface INeteaseDailySnapshot {
    playlists: INeteasePlaylistCard[];
}

type Phase = "loading" | "anonymous" | "ready";

export default function NeteaseDailyPage() {
    // 快照/会话任一存在就能立即出内容：phase 初值据此跳过「正在连接」
    const [initialSnapshot] = useState(() =>
        readPageSnapshot<INeteaseDailySnapshot>(
            PAGE_KEY,
            snapshotSourceKey(getCachedNeteaseProfile()),
        ),
    );
    const [phase, setPhase] = useState<Phase>(initialSnapshot ? "ready" : "loading");
    const [expired, setExpired] = useState(false);
    const [songs, setSongs] = useState<INeteaseSong[]>([]);
    const [dailyError, setDailyError] = useState("");
    const [playlists, setPlaylists] = useState<INeteasePlaylistCard[]>(
        initialSnapshot?.playlists ?? [],
    );
    const [playlistsError, setPlaylistsError] = useState("");
    const [reloadKey, setReloadKey] = useState(0);
    /** 当前账号：换号时要把旧账号的会话与页面数据全部作废（见下方 effect） */
    const [profile, setProfile] = useState<INeteaseProfile | null>(() =>
        getCachedNeteaseProfile(),
    );
    const profileRef = useRef<INeteaseProfile | null>(profile);
    // 刷新按钮带来的「本次不走缓存」标记：从点击处传到异步加载完成后的 startMatchSession
    const ignoreCacheRef = useRef(false);

    // 会话按日期隔离：跨天自然失效重跑；页面重挂载复用进行中/已完成的会话
    const dailyKey = `daily:${dateStr()}`;
    const session = useMatchSession(dailyKey);

    useEffect(() => {
        let cancelled = false;
        setDailyError("");
        setPlaylistsError("");
        // 刻意不清 songs/playlists：有内容时这一轮是后台静默刷新，新数据到了再替换
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

            // 登录了，但可能换了账号（退出重登/扫码登了另一个号）：私人雷达等歌单
            // 内容按账号生成，旧账号的匹配会话和页面残留数据对新人来说是错的，全部作废重走
            const account = await getNeteaseAccountInfo();
            if (cancelled) {
                return;
            }
            if (account && account.userId !== profileRef.current?.userId) {
                profileRef.current = account;
                setProfile(account);
                setSongs([]);
                setPlaylists([]);
                setPhase("loading");
                resetAllMatchSessions();
            }

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
            if (needLogin) {
                // 登录过期：旧内容即使还在也拉不动新数据了，引导重新扫码
                setExpired(true);
                setPhase("anonymous");
                return;
            }
            if (dailySongs.length) {
                setSongs(dailySongs);
            }
            if (cards.length) {
                setPlaylists(cards);
                // 只在拿到有效数据时写快照（约定：失败/空态不写，避免覆盖好数据）
                writePageSnapshot<INeteaseDailySnapshot>(
                    PAGE_KEY,
                    snapshotSourceKey(account ?? profileRef.current),
                    { playlists: cards },
                );
            }
            setPhase("ready");
            if (dailySongs.length) {
                // 同 key 会话在跑/已完成时内部会复用；刷新按钮已先 reset 并带上不走缓存标记
                startMatchSession(dailyKey, "每日推荐", dailySongs, {
                    ignoreCache: ignoreCacheRef.current,
                });
                ignoreCacheRef.current = false;
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [reloadKey]);

    const matchedItems = useMemo(
        () =>
            (session?.matches ?? [])
                .filter((m) => m.status === "matched" && !m.duplicate)
                .map((m) => m.item!),
        [session],
    );

    /** 显式刷新：丢掉当前会话重新拉取，强制不走缓存完整重配（新结果仍回写缓存） */
    const refresh = () => {
        resetMatchSession(dailyKey);
        ignoreCacheRef.current = true;
        setReloadKey((k) => k + 1);
    };

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
                    (session && session.missedCount > 0 ? `；${session.missedCount} 首未匹配到音源` : ""),
            );
        } catch (e: any) {
            showToast(`保存失败：${e?.message ?? "未知错误"}`);
        }
    };

    const openLogin = async () => {
        const res = await openNeteaseLogin();
        if (res.success) {
            showToast("网易云登录成功");
            refresh();
        } else if (!res.canceled) {
            showToast(res.message ?? "登录未完成");
        }
    };

    const headerSub = (() => {
        if (session) {
            if (session.status === "running") {
                return `正在匹配 ${session.done}/${session.total}，命中 ${session.matchedCount}${
                    session.cachedCount ? `（缓存 ${session.cachedCount}）` : ""
                }`;
            }
            if (session.status === "error") {
                return session.error ?? "匹配失败";
            }
            if (session.status === "done") {
                return `命中 ${session.matchedCount}/${session.total}${
                    session.lowCount ? `（低置信 ${session.lowCount}）` : ""
                }${session.missedCount ? `，未匹配 ${session.missedCount}` : ""}`;
            }
        }
        if (phase === "loading") {
            return "正在连接网易云账号…";
        }
        return "网易云账号的个性化推荐，匹配后可直接播放、一键入库";
    })();

    return (
        <div>
            <div className="page-header">
                <div className="page-header-row">
                    <div>
                        <div className="page-header-title">每日推荐</div>
                        <div className="page-header-sub">{headerSub}</div>
                    </div>
                    <div className="netease-header-actions">
                        {phase === "ready" &&
                            session?.status === "done" &&
                            matchedItems.length > 0 && (
                                <button className="btn-primary" onClick={saveDailyAsSheet}>
                                    <Icon name="addToSheet" size={14} />
                                    存为本地歌单
                                </button>
                            )}
                        <button className="btn-ghost" title="重新加载" onClick={refresh}>
                            <Icon name="refresh" size={15} />
                        </button>
                    </div>
                </div>
            </div>

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

            {phase !== "anonymous" && (
                <>
                    {/* 歌曲区：会话存在就直接用会话渲染（重挂载不重跑），否则按冷启动兜底 */}
                    {session ? (
                        session.status === "running" || session.status === "loading" ? (
                            <NeteaseMatchingPanel view={session} />
                        ) : session.status === "error" ? (
                            <div className="source-note">{session.error}</div>
                        ) : (
                            <>
                                {session.missedCount > 0 && (
                                    <details className="netease-missed">
                                        <summary>
                                            未匹配到音源的 {session.missedCount} 首（点开查看）
                                        </summary>
                                        <div className="netease-missed-list">
                                            {(session.matches ?? [])
                                                .filter((m) => m.status === "missed" || m.duplicate)
                                                .map((m) => {
                                                    const idx =
                                                        songs.findIndex((s) => s.id === m.song.id) + 1;
                                                    return (
                                                        <div key={m.song.id}>
                                                            #{idx} {m.song.name} -{" "}
                                                            {m.song.artists.join("/")}
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
                                <MusicList
                                    musicList={matchedItems}
                                    listId={`netease-daily-${dateStr()}-${profile?.userId ?? ""}`}
                                    searchable
                                    selectable={false}
                                    className="netease-list-in"
                                />
                            </>
                        )
                    ) : phase === "loading" ? (
                        <div className="empty-hint">正在连接网易云账号…</div>
                    ) : songs.length > 0 ? (
                        <div className="empty-hint">正在准备匹配…</div>
                    ) : (
                        !dailyError && <div className="empty-hint">今天暂时没有推荐歌曲</div>
                    )}
                    {dailyError && (
                        <div className="source-note">每日推荐歌曲获取失败：{dailyError}</div>
                    )}

                    {/* 歌单区：快照/已有数据直接展示，后台刷新静默替换 */}
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
                                        点进歌单自动用已启用的音源逐首匹配（离开页面也在后台继续），完成后可整单入库
                                    </div>
                                    <div className="card-grid">
                                        {playlists.map((card) => (
                                            <div
                                                key={card.id}
                                                className="media-card"
                                                onClick={() => {
                                                    startPlaylistMatchSession(card);
                                                    navigate("neteasePlaylistDetail", { card });
                                                }}
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
        </div>
    );
}
