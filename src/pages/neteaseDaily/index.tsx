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
    getMatchSession,
    resetAllMatchSessions,
    resetMatchSession,
    startMatchSession,
    startPlaylistMatchSession,
    useMatchSession,
} from "@/core/neteaseMatchSession";
import {
    readGridCache,
    writeGridCache,
} from "@/core/neteaseGridCache";
import { navigate } from "@/core/router";

/**
 * 每日推荐（网易云）：扫码登录后拉取账号的个性化推荐——
 *  - 每日推荐歌曲：用已启用的音源插件逐首匹配成可播放曲目，一键存为本地歌单「日推 YYYY-MM-DD」；
 *  - 推荐歌单（每日推荐 + 个性化网格）：点进详情页整单匹配，离开页面匹配在后台继续。
 *
 * 匹配都跑在模块级会话（core/neteaseMatchSession）里，本页只负责拉数据、触发和订阅进度。
 *
 * 数据刷新时机（刻意收紧，防止自动刷新把正在看/正在播放的歌单卡片从网格里挤掉）：
 *  - 推荐歌单网格只在三种情况下重新拉取：手动点刷新、跨天后的首次加载、更换网易云账号
 *    （含重启后当天首次进入但缓存缺失）。其余情况——反复进出页面、同一天内重启应用——
 *    一律用 localStorage 网格缓存（core/neteaseGridCache），页面怎么切网格都不动。
 *  - 歌曲区完全由模块级会话驱动：会话在跑/已完成时重挂载不重拉；只有无会话
 *    （当天首次、重启后、或上次匹配出错）才拉取并起会话。
 */

function dateStr(d = new Date()) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type Phase = "loading" | "anonymous" | "ready";

export default function NeteaseDailyPage() {
    // 当天的网格缓存（今天 + 同账号才可用；重启后账号还未知，effect 里再校验一次）：
    // 有它本页首帧就直接出网格，且当次挂载不会后台重拉
    const [cachedGrid] = useState(() => {
        const cache = readGridCache();
        if (!cache || cache.date !== dateStr() || !cache.playlists.length) {
            return null;
        }
        const known = getCachedNeteaseProfile();
        if (known && cache.userId && cache.userId !== known.userId) {
            return null;
        }
        return cache;
    });
    const [phase, setPhase] = useState<Phase>(cachedGrid ? "ready" : "loading");
    const [expired, setExpired] = useState(false);
    const [songs, setSongs] = useState<INeteaseSong[]>([]);
    const [dailyError, setDailyError] = useState("");
    const [playlists, setPlaylists] = useState<INeteasePlaylistCard[]>(
        cachedGrid?.playlists ?? [],
    );
    const [playlistsError, setPlaylistsError] = useState("");
    const [reloadKey, setReloadKey] = useState(0);
    // 歌曲区是否在等拉取/起会话：有会话时展示全归会话，不该闪「今天暂时没有推荐歌曲」
    const [songsPending, setSongsPending] = useState(() => {
        const s = getMatchSession(`daily:${dateStr()}`);
        return !s || s.status === "error";
    });
    /** 当前账号：换号时要把旧账号的会话与页面数据全部作废（见下方 effect） */
    const [profile, setProfile] = useState<INeteaseProfile | null>(() =>
        getCachedNeteaseProfile(),
    );
    const profileRef = useRef<INeteaseProfile | null>(profile);
    // 刷新按钮带来的「本次不走缓存」标记：effect 开头消费一次，只作用于这一轮
    const ignoreCacheRef = useRef(false);

    // 会话按日期隔离：跨天自然失效重跑；页面重挂载复用进行中/已完成的会话
    const dailyKey = `daily:${dateStr()}`;
    const session = useMatchSession(dailyKey);

    useEffect(() => {
        let cancelled = false;
        setDailyError("");
        setPlaylistsError("");
        // 手动刷新标记在 effect 开头消费一次：只作用于这一轮，之后恢复「缓存优先」
        const forceRefresh = ignoreCacheRef.current;
        ignoreCacheRef.current = false;
        // 与 songsPending 初值同一套判断（刷新按钮会先 reset 会话，这里要重新置起）
        const currentSession = getMatchSession(dailyKey);
        setSongsPending(!currentSession || currentSession.status === "error");
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

            const account = await getNeteaseAccountInfo();
            if (cancelled) {
                return;
            }
            const today = dateStr();
            const cache = readGridCache();
            // 网格缓存对「今天 + 当前账号」有效（账号资料暂时拿不到时姑且信缓存）
            const cacheValid =
                !forceRefresh &&
                !!cache &&
                cache.date === today &&
                !!cache.playlists.length &&
                (!account || !cache.userId || cache.userId === account.userId);
            // 换号：私人雷达等歌单内容按账号生成，旧账号的会话与页面数据全部作废。
            // 重启后 profileRef 还是空，靠缓存里记的 userId 识别是不是换了人登录。
            const isAccountSwitch =
                !!account &&
                (profileRef.current
                    ? account.userId !== profileRef.current.userId
                    : !!cache?.userId && cache.userId !== account.userId);
            if (isAccountSwitch) {
                profileRef.current = account;
                setProfile(account);
                setSongs([]);
                setPlaylists([]);
                setPhase("loading");
                resetAllMatchSessions();
            }

            // 歌曲区：会话在跑/已完成时整块交给会话，重挂载不重拉；
            // 只有没会话（当天首次/重启后/上次出错）才拉曲目并起会话
            const existingSession = getMatchSession(dailyKey);
            const needSongsFetch = !existingSession || existingSession.status === "error";
            if (needSongsFetch) {
                try {
                    dailySongs = await fetchNeteaseDailySongs();
                } catch (e: any) {
                    if (e instanceof NeteaseNeedLoginError) {
                        needLogin = true;
                    } else if (!cancelled) {
                        setDailyError(e?.message ?? "每日推荐歌曲获取失败");
                    }
                }
                if (!cancelled) {
                    setSongsPending(false);
                }
            }

            // 歌单网格：仅手动刷新/跨天/换号（缓存缺失或失效）时重新拉取，
            // 其余情况一律用缓存——个性化接口每次返回有出入，自动重拉会把
            // 正在看/正在播放的歌单卡片从网格里挤掉
            if (!cacheValid) {
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
                writeGridCache({
                    date: today,
                    userId: account?.userId ?? "",
                    playlists: cards,
                });
            } else if (cacheValid && cache) {
                // 防御：缓存有效但 state 是空的（正常路径初始化时已用上）
                setPlaylists(cache.playlists);
            }
            setPhase("ready");
            if (needSongsFetch && dailySongs.length) {
                // 同 key 会话在跑/已完成时内部会复用；手动刷新已先 reset 并带不走缓存标记
                startMatchSession(dailyKey, "每日推荐", dailySongs, {
                    ignoreCache: forceRefresh,
                });
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
                                                    // 编号取会话自带的曲目表：重挂载不重拉时页面 songs state 是空的
                                                    const idx =
                                                        session.songs.findIndex(
                                                            (s) => s.id === m.song.id,
                                                        ) + 1;
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
                    ) : songsPending ? (
                        <div className="empty-hint">正在获取今日推荐歌曲…</div>
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
