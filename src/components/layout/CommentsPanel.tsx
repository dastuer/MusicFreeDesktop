import React, { useCallback, useEffect, useRef, useState } from "react";
import Icon from "../base/Icon";
import {
    INeteaseComment,
    INeteaseCommentsPage,
    INeteaseProfile,
    NeteaseNeedLoginError,
    addNeteaseComment,
    deleteNeteaseComment,
    fetchNeteaseHotComments,
    fetchNeteaseSongComments,
    getNeteaseAccountInfo,
    likeNeteaseComment,
    openNeteaseLogin,
} from "@/core/netease";
import { rememberCommentTotal, resolveNeteaseSongId } from "@/core/neteaseComments";
import { showToast } from "../base/Toast";

/**
 * 正在播放页·整页评论区（按网易云桌面端 1:1 复刻）：
 *
 * - 页面分两部分：「热门评论」默认只摘 5 条，点「查看更多精彩评论」
 *   进入独立的精彩评论页（热门评论独立分页，滚动续载）；「最新评论」展示
 *   评论条数，回复按时间混排（带引用条），滚动到底自动加载。
 * - 条目：圆头像 + 昵称(VIP 徽标) + 正文 + 引用条；左下时间
 *   （今天 HH:mm / 今年 MM-DD / 更早 YYYY-MM-DD），右下 [赞数]👍 回复💬。
 * - 发布/回复：底部居中悬浮「发布评论」胶囊 → 居中模态输入框
 *   （标题「歌曲：X」/「回复评论」，#/@/表情 工具位，字数上限 1000，红色发布按钮）。
 * - 点赞：拇指图标乐观更新；删除自己的评论悬停显示、两步确认。
 * - 未登录时点赞/发布直接拉起扫码登录（与网易云一致），浏览评论免登录。
 */

const PAGE_SIZE = 30;
const HOT_EXCERPT = 5;
const HOT_PAGE_SIZE = 30;

type Phase =
    | { kind: "resolving" }
    | { kind: "unmatched" }
    | { kind: "error"; message: string }
    | { kind: "ready" };

type PageKind = "main" | "hot";

type Composer =
    | { mode: "publish" }
    | { mode: "reply"; target: INeteaseComment };

/** 网易云评论时间：今天到时分，今年到月日，更早带年份 */
function formatCommentTime(ms: number, fallback = "") {
    if (!ms) {
        return fallback;
    }
    const d = new Date(ms);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    if (d.toDateString() === now.toDateString()) {
        return `${d.getHours()}:${pad(d.getMinutes())}`;
    }
    if (d.getFullYear() === now.getFullYear()) {
        return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function CommentsPanel(props: { music: IMusic.IMusicItem; active: boolean }) {
    const { music, active } = props;
    const [phase, setPhase] = useState<Phase>({ kind: "resolving" });
    const [songId, setSongId] = useState<string | null>(null);
    const [page, setPage] = useState<INeteaseCommentsPage | null>(null);
    /** 第 2 页起追加的最新评论 */
    const [extraComments, setExtraComments] = useState<INeteaseComment[]>([]);
    const [loadingMore, setLoadingMore] = useState(false);
    const [pageKind, setPageKind] = useState<PageKind>("main");
    /** 精彩评论页的热门评论（独立分页，进入时拉取） */
    const [hotList, setHotList] = useState<INeteaseComment[] | null>(null);
    const [hotHasMore, setHotHasMore] = useState(false);
    /** 热评子集自身的总数（≠ 全部评论数），热评页头用来标注「精彩评论 共 N 条」 */
    const [hotTotal, setHotTotal] = useState(0);
    const [hotLoading, setHotLoading] = useState(false);
    const [likeBusy, setLikeBusy] = useState<Record<string, boolean>>({});
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [composer, setComposer] = useState<Composer | null>(null);
    const [composerText, setComposerText] = useState("");
    const [sending, setSending] = useState(false);
    const [profile, setProfile] = useState<INeteaseProfile | null>(null);
    /** 刚发布成功的评论：滚动定位到它并短暂高亮，发完能立刻看到自己那条 */
    const [flashCommentId, setFlashCommentId] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const composerInputRef = useRef<HTMLTextAreaElement>(null);

    const loadFirst = useCallback(async (id: string) => {
        const first = await fetchNeteaseSongComments(id, { limit: PAGE_SIZE, offset: 0 });
        setPage(first);
        setExtraComments([]);
        // 评论总数回写计数缓存，播放条角标即可同步
        rememberCommentTotal(music, first.total);
    }, [music]);

    // 面板激活时：解析歌曲 id → 拉首页。
    // 同一首歌首次打开才拉数据；之后切走再切回（active 反复翻转）保持已加载的
    // 数据与状态不重置，避免重新加载闪「正在匹配」占位。
    const musicKey = `${music.platform}:${music.id}`;
    const loadedKeyRef = useRef<string | null>(null);

    useEffect(() => {
        if (!active) {
            return;
        }
        if (loadedKeyRef.current === musicKey) {
            return;
        }
        let cancelled = false;
        setPhase({ kind: "resolving" });
        setSongId(null);
        setPage(null);
        setExtraComments([]);
        setComposer(null);
        setPageKind("main");
        setHotList(null);
        setHotTotal(0);
        setHotHasMore(false);
        resolveNeteaseSongId(music)
            .then(async (id) => {
                if (cancelled) {
                    return;
                }
                if (!id) {
                    // 未匹配也记下来：这首歌就是没有网易云评论，切回不重跑
                    loadedKeyRef.current = musicKey;
                    setPhase({ kind: "unmatched" });
                    return;
                }
                setSongId(id);
                setPhase({ kind: "ready" });
                await loadFirst(id);
                // 首页拉成功才算加载完成并缓存；失败保持未缓存，下次打开仍可重试
                if (!cancelled) {
                    loadedKeyRef.current = musicKey;
                }
            })
            .catch((e: any) => {
                if (!cancelled) {
                    setPhase({ kind: "error", message: e?.message ?? "评论加载失败" });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [active, musicKey, loadFirst]);

    // 登录态（null = 未登录），决定点赞/发布入口与「自己的评论」判定
    useEffect(() => {
        if (!active) {
            return;
        }
        getNeteaseAccountInfo()
            .then((p) => setProfile(p))
            .catch(() => setProfile(null));
    }, [active]);

    // 模态打开期间按 Esc 关闭（与网易云一致）
    useEffect(() => {
        if (!composer) {
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setComposer(null);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [composer]);

    /**
     * 发布成功后把新评论滚到视野中央并高亮一下。
     * DOM 更新在下一帧才落定，用 rAF 等它出现再量位置；
     * 高亮保持 2 秒后撤掉，避免一直亮着干扰阅读。
     */
    useEffect(() => {
        if (!flashCommentId) {
            return;
        }
        let raf = 0;
        let timer = 0;
        raf = requestAnimationFrame(() => {
            const scope = scrollRef.current;
            const item = scope?.querySelector<HTMLElement>(
                `.cmt-item[data-comment-id="${flashCommentId}"]`,
            );
            if (item) {
                const scopeRect = scope!.getBoundingClientRect();
                const itemRect = item.getBoundingClientRect();
                scope!.scrollTo({
                    top:
                        scope!.scrollTop +
                        (itemRect.top - scopeRect.top) -
                        // 留一点上边距，不贴着页头
                        Math.max(24, (scopeRect.height - itemRect.height) / 2),
                    behavior: "smooth",
                });
            }
            timer = window.setTimeout(() => setFlashCommentId(null), 2000);
        });
        return () => {
            cancelAnimationFrame(raf);
            clearTimeout(timer);
        };
    }, [flashCommentId]);

    const handleActionError = (e: unknown, fallback: string) => {
        if (e instanceof NeteaseNeedLoginError) {
            setProfile(null);
            showToast("网易云登录已过期，请重新扫码登录");
        } else {
            showToast(e instanceof Error && e.message ? e.message : fallback);
        }
    };

    const promptLogin = async () => {
        try {
            const r = await openNeteaseLogin();
            if (r.success) {
                const p = await getNeteaseAccountInfo().catch(() => null);
                setProfile(p);
                // 重新拉一遍，把点赞状态带出来
                if (songId) {
                    void loadFirst(songId).catch(() => undefined);
                }
            }
        } catch {
            // 登录窗打不开等异常：不打断浏览
        }
    };

    /**
     * 点赞/发布前的登录态确认。挂载时的资料拉取可能瞬时失败而被缓存成
     * 「未登录」，这里先补拉一次再决定是否引导扫码，避免误弹登录窗。
     */
    const ensureProfile = async (): Promise<INeteaseProfile | null> => {
        if (profile) {
            return profile;
        }
        const p = await getNeteaseAccountInfo().catch(() => null);
        setProfile(p);
        return p;
    };

    /** 点赞乐观更新：热评块、最新块（含追加页）、精彩评论页里同 id 的评论一起翻状态 */
    const applyLike = (commentId: string, next: boolean) => {
        const patch = (c: INeteaseComment) =>
            c.commentId === commentId
                ? { ...c, liked: next, likedCount: Math.max(0, c.likedCount + (next ? 1 : -1)) }
                : c;
        setPage((p) =>
            p
                ? { ...p, hotComments: p.hotComments.map(patch), comments: p.comments.map(patch) }
                : p,
        );
        setExtraComments((list) => list.map(patch));
        setHotList((list) => (list ? list.map(patch) : list));
    };

    const toggleLike = async (c: INeteaseComment) => {
        if (!songId || likeBusy[c.commentId]) {
            return;
        }
        if (!(await ensureProfile())) {
            void promptLogin();
            return;
        }
        const next = !c.liked;
        setLikeBusy((m) => ({ ...m, [c.commentId]: true }));
        applyLike(c.commentId, next);
        try {
            await likeNeteaseComment(songId, c.commentId, next);
        } catch (e) {
            applyLike(c.commentId, !next);
            handleActionError(e, "点赞失败，请稍后再试");
        } finally {
            setLikeBusy((m) => ({ ...m, [c.commentId]: false }));
        }
    };

    /** 本地移除一条评论（各列表；总数同步减一） */
    const removeLocal = (commentId: string) => {
        const drop = (list: INeteaseComment[]) => list.filter((c) => c.commentId !== commentId);
        setPage((p) =>
            p
                ? {
                      ...p,
                      total: Math.max(0, p.total - 1),
                      hotComments: drop(p.hotComments),
                      comments: drop(p.comments),
                  }
                : p,
        );
        setExtraComments((list) => drop(list));
        setHotList((list) => (list ? drop(list) : list));
        rememberCommentTotal(music, Math.max(0, (page?.total ?? 1) - 1));
    };

    // 删除走两步确认：第一次点变成「确认删除」，3 秒内再点才真删
    const removeComment = async (c: INeteaseComment) => {
        if (!songId) {
            return;
        }
        if (confirmDeleteId !== c.commentId) {
            setConfirmDeleteId(c.commentId);
            setTimeout(() => setConfirmDeleteId((v) => (v === c.commentId ? null : v)), 3000);
            return;
        }
        setConfirmDeleteId(null);
        try {
            await deleteNeteaseComment(songId, c.commentId);
            removeLocal(c.commentId);
        } catch (e) {
            handleActionError(e, "删除失败，请稍后再试");
        }
    };

    const loadMore = async () => {
        if (!songId || !page?.hasMore || loadingMore) {
            return;
        }
        setLoadingMore(true);
        try {
            // offset 分页在热门歌曲上会被服务端截断（约 1100 条就 more=false），
            // 改用 beforeTime 游标：拿当前最后一条的时间往更早翻，才能真的翻到底
            const last = extraComments.length
                ? extraComments[extraComments.length - 1]
                : page.comments[page.comments.length - 1];
            const next = await fetchNeteaseSongComments(songId, {
                limit: PAGE_SIZE,
                beforeTime: last?.time ?? 0,
            });
            setExtraComments((prev) => [...prev, ...next.comments]);
            setPage((p) => (p ? { ...p, hasMore: next.hasMore } : p));
        } catch (e) {
            handleActionError(e, "评论加载失败");
        } finally {
            setLoadingMore(false);
        }
    };

    const loadHot = useCallback(
        async (offset: number, replace: boolean) => {
            if (!songId || hotLoading) {
                return;
            }
            setHotLoading(true);
            try {
                const res = await fetchNeteaseHotComments(songId, {
                    limit: HOT_PAGE_SIZE,
                    offset,
                });
                setHotList((prev) => (replace ? res.comments : [...(prev ?? []), ...res.comments]));
                setHotHasMore(res.hasMore);
                setHotTotal(res.total);
            } catch (e) {
                handleActionError(e, "精彩评论加载失败");
            } finally {
                setHotLoading(false);
            }
        },
        [songId, hotLoading],
    );

    const openHotPage = () => {
        setPageKind("hot");
        setHotList(null);
        setHotHasMore(false);
        setHotTotal(0);
        void loadHot(0, true);
    };

    // 滚动到底自动续载：主页面续最新评论，精彩评论页续热评
    const handleListScroll = () => {
        const el = scrollRef.current;
        if (!el || el.scrollTop + el.clientHeight < el.scrollHeight - 240) {
            return;
        }
        if (pageKind === "main") {
            if (page?.hasMore && !loadingMore) {
                void loadMore();
            }
        } else if (hotHasMore && !hotLoading) {
            void loadHot(hotList?.length ?? 0, false);
        }
    };

    // 发完本地插入最新流顶部：网易云也是发完立刻能在流里看到自己的评论
    const buildLocalComment = (text: string, target: INeteaseComment | null): INeteaseComment => ({
        commentId: `local-${Date.now()}`,
        content: text,
        time: Date.now(),
        timeStr: "",
        likedCount: 0,
        liked: false,
        user: {
            userId: profile!.userId,
            nickname: profile!.nickname,
            avatarUrl: profile!.avatarUrl,
            vipType: 0,
        },
        beReplied: target ? [{ content: target.content, user: target.user }] : [],
        parentCommentId: target?.commentId,
    });

    const sendComposer = async () => {
        const text = composerText.trim();
        if (!songId || !composer || !text || sending) {
            return;
        }
        if (!profile) {
            void promptLogin();
            return;
        }
        const target = composer.mode === "reply" ? composer.target : null;
        setSending(true);
        try {
            await addNeteaseComment(songId, text, target?.commentId);
            const local = buildLocalComment(text, target);
            setPage((p) =>
                p
                    ? {
                          ...p,
                          total: p.total + 1,
                          comments: [local, ...p.comments],
                      }
                    : p,
            );
            // 发完回到主页面（可能是在精彩评论页发的），并把新评论定位出来
            setPageKind("main");
            setFlashCommentId(local.commentId);
            setComposer(null);
            setComposerText("");
        } catch (e) {
            handleActionError(e, "评论发送失败，请稍后再试");
        } finally {
            setSending(false);
        }
    };

    const openComposer = async (next: Composer) => {
        // 与网易云一致：未登录点发布/回复直接拉起扫码登录
        if (!(await ensureProfile())) {
            void promptLogin();
            return;
        }
        setComposerText("");
        setComposer(next);
        setTimeout(() => composerInputRef.current?.focus(), 50);
    };

    const isMine = (c: INeteaseComment) => !!profile && c.user.userId === profile.userId;

    const renderItem = (c: INeteaseComment) => (
        <div
            className={`cmt-item${flashCommentId === c.commentId ? " cmt-item-flash" : ""}`}
            data-comment-id={c.commentId}
            key={c.commentId}
        >
            <div className="cmt-avatar">
                <span>{(c.user.nickname || "网").slice(0, 1)}</span>
                {c.user.avatarUrl && (
                    <img
                        src={c.user.avatarUrl}
                        loading="lazy"
                        alt=""
                        onError={(e) => {
                            (e.target as HTMLImageElement).style.display = "none";
                        }}
                    />
                )}
            </div>
            <div className="cmt-main">
                <div className="cmt-nick-row">
                    <span className="cmt-nick">{c.user.nickname}</span>
                    {!!c.user.vipType && c.user.vipType > 0 && (
                        <span className="cmt-vip-tag">VIP</span>
                    )}
                </div>
                <div className="cmt-content">{c.content}</div>
                {c.beReplied.length > 0 && (
                    <div className="cmt-quote">
                        <span className="cmt-quote-nick">
                            @{c.beReplied[0].user.nickname}：
                        </span>
                        {c.beReplied[0].content}
                    </div>
                )}
                <div className="cmt-foot">
                    <span className="cmt-time">{formatCommentTime(c.time, c.timeStr)}</span>
                    <div className="cmt-actions">
                        {isMine(c) && (
                            <button
                                className="cmt-action danger"
                                onClick={() => void removeComment(c)}
                            >
                                {confirmDeleteId === c.commentId ? "确认删除" : "删除"}
                            </button>
                        )}
                        <button
                            className={`cmt-like${c.liked ? " liked" : ""}`}
                            title={c.liked ? "取消点赞" : "点赞"}
                            onClick={() => void toggleLike(c)}
                        >
                            {c.likedCount > 0 && (
                                <span className="cmt-like-count">{c.likedCount}</span>
                            )}
                            <Icon name={c.liked ? "thumbUpFilled" : "thumbUp"} size={15} />
                        </button>
                        <button
                            className="cmt-action"
                            title="回复"
                            onClick={() => void openComposer({ mode: "reply", target: c })}
                        >
                            <Icon name="commentBubble" size={15} />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );

    if (phase.kind !== "ready") {
        return (
            <div className="cmt-wrap">
                {phase.kind === "resolving" && (
                    <div className="cmt-hint">正在匹配网易云音乐曲目…</div>
                )}
                {phase.kind === "unmatched" && (
                    <div className="cmt-hint">未能在网易云音乐找到对应歌曲，暂无评论</div>
                )}
                {phase.kind === "error" && (
                    <div className="cmt-hint">评论加载失败：{phase.message}</div>
                )}
            </div>
        );
    }

    const latestComments = [...(page?.comments ?? []), ...extraComments];
    const hotExcerpt = (page?.hotComments ?? []).slice(0, HOT_EXCERPT);
    const hasMoreHot = (page?.hotComments?.length ?? 0) > HOT_EXCERPT;

    return (
        <div className="cmt-wrap">
            {pageKind === "main" ? (
                <div className="cmt-scroll" ref={scrollRef} onScroll={handleListScroll}>
                    <div className="cmt-column">
                        {/* 热门评论：默认只摘 5 条，更多进独立精彩评论页 */}
                        {page && page.total > 0 && page.hotComments.length > 0 && (
                            <div className="cmt-section">
                                <div className="cmt-section-header">热门评论</div>
                                {hotExcerpt.map(renderItem)}
                                {hasMoreHot && (
                                    <button
                                        className="cmt-hot-more"
                                        onClick={openHotPage}
                                    >
                                        查看更多精彩评论
                                        <Icon name="forward" size={12} />
                                    </button>
                                )}
                            </div>
                        )}
                        {page && page.total === 0 && (
                            <div className="cmt-section">
                                <div className="cmt-section-header">热门评论</div>
                                <div className="cmt-hint">还没有评论，快来抢沙发</div>
                            </div>
                        )}
                        {/* 最新评论：展示条数，滚动到底自动续载 */}
                        <div className="cmt-section">
                            <div className="cmt-section-header">
                                最新评论
                                {page && page.total > 0 && (
                                    <span className="cmt-section-count">
                                        共 {page.total} 条
                                    </span>
                                )}
                            </div>
                            {latestComments.map(renderItem)}
                            {loadingMore && <div className="cmt-hint small">加载中…</div>}
                            {page && !page.hasMore && latestComments.length > 0 && (
                                <div className="cmt-hint small">已经到底了</div>
                            )}
                        </div>
                    </div>
                </div>
            ) : (
                <div className="cmt-scroll" ref={scrollRef} onScroll={handleListScroll}>
                    <div className="cmt-column">
                        <div className="cmt-hotpage-header">
                            <button
                                className="cmt-hotpage-back"
                                title="返回"
                                onClick={() => setPageKind("main")}
                            >
                                <Icon name="back" size={18} />
                            </button>
                            <span>精彩评论</span>
                            <span className="cmt-section-count">
                                {hotTotal > 0 ? `共 ${hotTotal} 条` : ""}
                            </span>
                        </div>
                        {(hotList ?? []).map(renderItem)}
                        {hotLoading && <div className="cmt-hint small">加载中…</div>}
                        {!hotLoading && hotList && !hotHasMore && (
                            <div className="cmt-hint small">已经到底了</div>
                        )}
                    </div>
                </div>
            )}
            {/* 底部居中悬浮「发布评论」胶囊（网易云样式） */}
            <button className="cmt-publish-pill" onClick={() => void openComposer({ mode: "publish" })}>
                <Icon name="edit" size={14} />
                发布评论
            </button>
            {composer && (
                <div className="cmt-modal-mask" onClick={() => setComposer(null)}>
                    <div className="cmt-modal" onClick={(e) => e.stopPropagation()}>
                        <button className="cmt-modal-close" onClick={() => setComposer(null)}>
                            <Icon name="close" size={16} />
                        </button>
                        <div className="cmt-modal-title">
                            {composer.mode === "reply"
                                ? "回复评论"
                                : `歌曲：${music.title}`}
                        </div>
                        <div className="cmt-modal-box">
                            <textarea
                                ref={composerInputRef}
                                className="cmt-modal-input"
                                placeholder={
                                    composer.mode === "reply"
                                        ? `回复 ${composer.target.user.nickname}：`
                                        : "说点什么吧"
                                }
                                value={composerText}
                                maxLength={1000}
                                onChange={(e) => setComposerText(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                                        void sendComposer();
                                    }
                                }}
                            />
                            <div className="cmt-modal-box-foot">
                                <div className="cmt-modal-tools">
                                    <button onClick={() => setComposerText((t) => `${t}#`)}>
                                        #
                                    </button>
                                    <button
                                        onClick={() =>
                                            setComposerText((t) =>
                                                composer.mode === "reply"
                                                    ? `${t}@${composer.target.user.nickname} `
                                                    : `${t}@`,
                                            )
                                        }
                                    >
                                        @
                                    </button>
                                    <button onClick={() => setComposerText((t) => `${t}😊`)}>
                                        😊
                                    </button>
                                </div>
                                <span className="cmt-modal-count">
                                    {1000 - composerText.length}
                                </span>
                            </div>
                        </div>
                        <button
                            className="cmt-modal-send"
                            disabled={!composerText.trim() || sending}
                            onClick={() => void sendComposer()}
                        >
                            {sending ? "…" : composer.mode === "reply" ? "回复" : "发布"}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
