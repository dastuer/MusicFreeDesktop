import React, { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { showToast } from "./Toast";
import {
    IUserSheet,
    LIKES_SHEET_ID,
    addMusicToSheetMany,
    createSheet,
    ensureLikesSheet,
    getUserSheets,
} from "@/core/musicSheet";

/**
 * 「添加到歌单」弹层：支持单首（右键菜单 / 播放栏）和批量（列表多选「收藏」）。
 * 名单里「我喜欢的音乐」固定排在最前，其余是自建歌单，也可以现场新建。
 */

/** 一次会话：待收藏的歌曲 + 候选歌单过滤 + 收藏完成后的回调 */
interface ISheetPanelSession {
    musicItems: IMusic.IMusicItem[];
    /**
     * 从某个歌单页发起的收藏：候选名单里去掉它自己。
     * 「已在当前歌单里的歌再收藏到当前歌单」没有意义，凭空多一个永远点不出效果的选项。
     */
    excludeSheetId?: string;
    onDone?: () => void;
}

let panelListener: ((session: ISheetPanelSession) => void) | null = null;

/**
 * 打开「添加到歌单」弹层。
 * @param musicItem 单首或多首
 * @param options.excludeSheetId 不列入候选的歌单（当前所在歌单）
 * @param options.onDone 成功加入某个歌单后触发（弹层随即关闭）
 */
export function showAddToSheetPanel(
    musicItem: IMusic.IMusicItem | IMusic.IMusicItem[],
    options?: { excludeSheetId?: string; onDone?: () => void },
) {
    const musicItems = (Array.isArray(musicItem) ? musicItem : [musicItem]).filter(Boolean);
    if (!musicItems.length) {
        return;
    }
    panelListener?.({
        musicItems,
        excludeSheetId: options?.excludeSheetId,
        onDone: options?.onDone,
    });
}

export default function AddToSheetPanelHost() {
    const [session, setSession] = useState<ISheetPanelSession | null>(null);
    const [sheets, setSheets] = useState<IUserSheet[]>([]);
    const [creating, setCreating] = useState(false);
    const [newTitle, setNewTitle] = useState("");
    /** 关闭动画/重复点击期间防止回调跑第二次 */
    const doneOnceRef = useRef(false);

    useEffect(() => {
        panelListener = (next) => {
            doneOnceRef.current = false;
            setSession(next);
            setCreating(false);
            setNewTitle("");
            // 「我喜欢的音乐」首次进入应用时才会被创建，这里兜一次底，
            // 保证候选名单里始终有它
            ensureLikesSheet()
                .then(getUserSheets)
                .then(setSheets);
        };
        return () => {
            panelListener = null;
        };
    }, []);

    if (!session) {
        return null;
    }

    const { musicItems, excludeSheetId, onDone } = session;
    const count = musicItems.length;
    // 当前歌单不参与候选：在「我喜欢的音乐」里收藏到「我喜欢的音乐」是无意义的
    const candidates = sheets.filter((it) => it.id !== excludeSheetId);
    const likesSheet = candidates.find((it) => it.id === LIKES_SHEET_ID);
    const otherSheets = candidates.filter((it) => it.id !== LIKES_SHEET_ID);

    const close = () => {
        setSession(null);
        setCreating(false);
        setNewTitle("");
    };

    /** 收尾：回调交给调用方（清空选择 / 刷新列表），然后关掉弹层 */
    const finish = () => {
        if (!doneOnceRef.current) {
            doneOnceRef.current = true;
            onDone?.();
        }
        close();
    };

    const addToSheet = async (sheetId: string, sheetTitle: string) => {
        const { added, skipped } = await addMusicToSheetMany(sheetId, musicItems);
        if (!added) {
            showToast(`这些歌曲已在「${sheetTitle}」中`);
            return;
        }
        showToast(
            count > 1
                ? `已收藏 ${added} 首到「${sheetTitle}」${
                      skipped ? `，${skipped} 首已存在` : ""
                  }`
                : `已收藏到「${sheetTitle}」`,
        );
        finish();
    };

    const handleCreate = async () => {
        const title = newTitle.trim();
        if (!title) {
            showToast("请输入歌单名");
            return;
        }
        const sheet = await createSheet(title);
        await addMusicToSheetMany(sheet.id, musicItems);
        showToast(
            count > 1 ? `已创建「${title}」并收藏 ${count} 首` : `已创建「${title}」并添加歌曲`,
        );
        finish();
    };

    const renderSheetRow = (sheet: IUserSheet, isLikes: boolean) => (
        <div
            key={sheet.id}
            className="context-menu-item"
            onClick={() => addToSheet(sheet.id, sheet.title)}
        >
            <Icon
                name={isLikes ? "heartFilled" : "playQueue"}
                size={15}
                style={isLikes ? { color: "var(--primary-color)" } : undefined}
            />
            {sheet.title}
            <span
                style={{ marginLeft: "auto", color: "var(--text-tertiary)", fontSize: 12 }}
            >
                {sheet.musicList.length}首
            </span>
        </div>
    );

    return (
        <div className="panel-mask" onClick={close}>
            <div className="panel-body" onClick={(e) => e.stopPropagation()}>
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 14,
                    }}
                >
                    <div style={{ fontSize: 16, fontWeight: 600 }}>
                        {count > 1 ? `收藏 ${count} 首到歌单` : "添加到歌单"}
                    </div>
                    <Icon
                        name="close"
                        size={16}
                        style={{ cursor: "pointer" }}
                        onClick={close}
                    />
                </div>

                {!creating ? (
                    <>
                        <div
                            className="context-menu-item"
                            onClick={() => setCreating(true)}
                        >
                            <Icon name="plus" size={15} />
                            新建歌单
                        </div>
                        {likesSheet && renderSheetRow(likesSheet, true)}
                        {otherSheets.map((sheet) => renderSheetRow(sheet, false))}
                        {!candidates.length && (
                            <div className="empty-hint" style={{ padding: "24px 0" }}>
                                {excludeSheetId
                                    ? "当前歌单之外还没有别的歌单，点上方「新建歌单」创建一个"
                                    : "还没有歌单，点击上方「新建歌单」创建"}
                            </div>
                        )}
                    </>
                ) : (
                    <div style={{ display: "flex", gap: 8 }}>
                        <input
                            className="text-input"
                            autoFocus
                            placeholder="歌单名称"
                            value={newTitle}
                            onChange={(e) => setNewTitle(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                        />
                        <button className="btn-primary" onClick={handleCreate}>
                            创建并收藏
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
