import React, { useEffect, useState } from "react";
import Icon from "./Icon";
import { showToast } from "./Toast";
import {
    IUserSheet,
    addMusicToSheet,
    createSheet,
    getUserSheets,
} from "@/core/musicSheet";

/**
 * 「添加到歌单」弹层
 */

let panelListener: ((musicItem: IMusic.IMusicItem) => void) | null = null;

export function showAddToSheetPanel(musicItem: IMusic.IMusicItem) {
    panelListener?.(musicItem);
}

export default function AddToSheetPanelHost() {
    const [musicItem, setMusicItem] = useState<IMusic.IMusicItem | null>(null);
    const [sheets, setSheets] = useState<IUserSheet[]>([]);
    const [creating, setCreating] = useState(false);
    const [newTitle, setNewTitle] = useState("");

    useEffect(() => {
        panelListener = (item) => {
            setMusicItem(item);
            getUserSheets().then(setSheets);
        };
        return () => {
            panelListener = null;
        };
    }, []);

    if (!musicItem) {
        return null;
    }

    const close = () => {
        setMusicItem(null);
        setCreating(false);
        setNewTitle("");
    };

    const handleAdd = async (sheetId: string) => {
        await addMusicToSheet(sheetId, musicItem);
        showToast("已添加到歌单");
        close();
    };

    const handleCreate = async () => {
        const title = newTitle.trim();
        if (!title) {
            showToast("请输入歌单名");
            return;
        }
        const sheet = await createSheet(title);
        await addMusicToSheet(sheet.id, musicItem);
        showToast(`已创建「${title}」并添加歌曲`);
        close();
    };

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
                    <div style={{ fontSize: 16, fontWeight: 600 }}>添加到歌单</div>
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
                        {sheets.map((sheet) => (
                            <div
                                key={sheet.id}
                                className="context-menu-item"
                                onClick={() => handleAdd(sheet.id)}
                            >
                                <Icon name="playQueue" size={15} />
                                {sheet.title}
                                <span
                                    style={{ marginLeft: "auto", color: "var(--text-tertiary)", fontSize: 12 }}
                                >
                                    {sheet.musicList.length}首
                                </span>
                            </div>
                        ))}
                        {!sheets.length && (
                            <div className="empty-hint" style={{ padding: "24px 0" }}>
                                还没有歌单，点击上方「新建歌单」创建
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
                            创建并添加
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
