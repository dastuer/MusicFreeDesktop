import React, { useEffect, useMemo } from "react";
import Cover from "@/components/base/Cover";
import Icon from "@/components/base/Icon";
import MusicList from "@/components/base/MusicList";
import NeteaseMatchingPanel from "@/components/base/NeteaseMatchingPanel";
import { showToast } from "@/components/base/Toast";
import { INeteasePlaylistCard } from "@/core/netease";
import {
    resetMatchSession,
    startPlaylistMatchSession,
    useMatchSession,
} from "@/core/neteaseMatchSession";
import {
    addMusicToSheetMany,
    createSheet,
    getUserSheets,
} from "@/core/musicSheet";
import { navigate } from "@/core/router";

/**
 * 推荐歌单详情：点开即触发「拉全量曲目 → 用已启用音源逐首匹配」，
 * 整条流水线跑在模块级会话里——退出本页也在后台继续，回来接着看进度/结果。
 * 完成后可一键把命中的曲目写入本地歌单（同名追加去重）。
 */
export default function NeteasePlaylistDetailPage(props: { card?: INeteasePlaylistCard }) {
    const card = props.card;
    const sessionKey = card ? `playlist:${card.id}` : "";

    // hooks 必须在 early return 之前：无 card 时也会订阅（恒为 null）
    useEffect(() => {
        if (card) {
            // 同 key 已在跑/已完成时内部直接复用；这里只负责「触发」
            startPlaylistMatchSession(card);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionKey]);

    const session = useMatchSession(sessionKey);

    const matchedItems = useMemo(
        () =>
            (session?.matches ?? [])
                .filter((m) => m.status === "matched" && !m.duplicate)
                .map((m) => m.item!),
        [session],
    );

    if (!card) {
        return (
            <div className="empty-hint">
                缺少歌单信息，请从「每日推荐」页的歌单卡片进入
                <div style={{ marginTop: 12 }}>
                    <button className="btn-primary" onClick={() => navigate("neteaseDaily")}>
                        去每日推荐
                    </button>
                </div>
            </div>
        );
    }

    const saveToSheet = async () => {
        if (!matchedItems.length) {
            return;
        }
        try {
            const sheets = await getUserSheets();
            const existed = sheets.find((s) => s.title === card.title);
            const sheet = existed ?? (await createSheet(card.title));
            const { added, skipped } = await addMusicToSheetMany(sheet.id, matchedItems);
            showToast(
                `已导入「${card.title}」：新增 ${added} 首${skipped ? `，跳过重复 ${skipped} 首` : ""}` +
                    (session && session.missedCount > 0
                        ? `；${session.missedCount} 首未匹配到音源`
                        : ""),
            );
        } catch (e: any) {
            showToast(`导入失败：${e?.message ?? "未知错误"}`);
        }
    };

    const rematch = () => {
        resetMatchSession(sessionKey);
        // 刷新语义：强制不走缓存完整重配（新结果仍回写缓存）
        startPlaylistMatchSession(card, { ignoreCache: true });
    };

    const headerSub = (() => {
        if (!session) {
            return "正在准备…";
        }
        if (session.status === "loading") {
            return "正在获取曲目…";
        }
        if (session.status === "running") {
            return `正在匹配 ${session.done}/${session.total}，命中 ${session.matchedCount}${
                session.cachedCount ? `（缓存 ${session.cachedCount}）` : ""
            }`;
        }
        if (session.status === "error") {
            return session.error ?? "获取失败";
        }
        return `命中 ${session.matchedCount}/${session.total}${
            session.lowCount ? `（低置信 ${session.lowCount}）` : ""
        }${session.missedCount ? `，未匹配 ${session.missedCount}` : ""}`;
    })();

    return (
        <div>
            <div className="page-header">
                <div className="page-header-row">
                    <div style={{ display: "flex", gap: 16, minWidth: 0 }}>
                        <Cover src={card.artwork} size={96} borderRadius={8} />
                        <div style={{ minWidth: 0 }}>
                            <div className="page-header-title">{card.title}</div>
                            <div className="page-header-sub">{headerSub}</div>
                        </div>
                    </div>
                    <div className="netease-header-actions">
                        {session?.status === "done" && matchedItems.length > 0 && (
                            <button className="btn-primary" onClick={saveToSheet}>
                                <Icon name="addToSheet" size={14} />
                                存为本地歌单
                            </button>
                        )}
                        <button className="btn-ghost" title="重新匹配" onClick={rematch}>
                            <Icon name="refresh" size={15} />
                        </button>
                    </div>
                </div>
            </div>

            {!session || session.status === "loading" || session.status === "running" ? (
                session ? (
                    <NeteaseMatchingPanel view={session} />
                ) : (
                    <div className="empty-hint">正在准备…</div>
                )
            ) : session.status === "error" ? (
                <div className="source-note">
                    {session.error}
                    <div style={{ marginTop: 12 }}>
                        <button className="btn-primary" onClick={rematch}>
                            重新匹配
                        </button>
                    </div>
                </div>
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
                                            session.matches.findIndex(
                                                (it) => it.song.id === m.song.id,
                                            ) + 1;
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
                    <MusicList
                        musicList={matchedItems}
                        listId={`netease-playlist-${card.id}`}
                        searchable
                        selectable={false}
                        className="netease-list-in"
                    />
                </>
            )}
        </div>
    );
}
