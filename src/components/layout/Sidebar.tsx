import React, { useEffect, useState } from "react";
import Icon from "../base/Icon";
import { showContextMenu } from "../base/ContextMenu";
import { showPrompt } from "../base/PromptDialog";
import { showToast } from "../base/Toast";
import { navigate, useCurrentRoute } from "@/core/router";
import {
    IUserSheet,
    LIKES_SHEET_ID,
    createSheet,
    deleteSheet,
    ensureLikesSheet,
    getUserSheets,
    renameSheet,
} from "@/core/musicSheet";
import { TrackPlayerSingleton } from "@/core/trackPlayer";

const mainNavItems = [
    { path: "home", title: "发现音乐", icon: "home" },
    { path: "topList", title: "排行榜", icon: "toplist" },
    { path: "history", title: "最近播放", icon: "history" },
    { path: "localMusic", title: "本地音乐", icon: "localMusic" },
    { path: "downloading", title: "下载管理", icon: "download" },
] as const;

const subNavItems = [
    { path: "pluginManage", title: "音源", icon: "plugin" },
    { path: "settings", title: "设置", icon: "settings" },
] as const;

export default function Sidebar() {
    const route = useCurrentRoute();
    const [sheets, setSheets] = useState<IUserSheet[]>([]);

    const refreshSheets = () => {
        getUserSheets().then(setSheets);
    };

    useEffect(() => {
        ensureLikesSheet().then(refreshSheets);
        const timer = setInterval(refreshSheets, 3000);
        return () => clearInterval(timer);
    }, []);

    const likesSheet = sheets.find((it) => it.id === LIKES_SHEET_ID);
    const userSheets = sheets.filter((it) => it.id !== LIKES_SHEET_ID);

    const renderItem = (item: { path: string; title: string; icon: string }) => (
        <div
            key={item.path}
            className={`sidebar-item${route.path === item.path ? " active" : ""}`}
            onClick={() => navigate(item.path as any)}
        >
            <span className="sidebar-item-icon">
                <Icon name={item.icon} size={17} />
            </span>
            {item.title}
        </div>
    );

    const isActiveSheet = (sheetId: string) =>
        route.path === "sheetDetail" && route.params?.userSheetId === sheetId;

    const createSheetAction = () => {
        showPrompt({
            title: "新建歌单",
            placeholder: "请输入歌单名称",
            confirmText: "创建",
            onConfirm: async (title) => {
                await createSheet(title);
                showToast(`歌单「${title}」已创建`);
                refreshSheets();
            },
        });
    };

    const sheetMenu = (e: React.MouseEvent, sheet: IUserSheet) => {
        e.preventDefault();
        e.stopPropagation();
        const items: any[] = [
            {
                title: "播放全部",
                icon: "play",
                onClick: () => {
                    if (sheet.musicList.length) {
                        TrackPlayerSingleton.playWithReplacePlayList(
                            TrackPlayerSingleton.pickPlayAllStart(sheet.musicList),
                            sheet.musicList,
                        );
                    } else {
                        showToast("歌单还没有歌曲");
                    }
                },
            },
        ];
        if (sheet.id !== LIKES_SHEET_ID) {
            items.push(
                {
                    title: "重命名",
                    icon: "settings",
                    onClick: () => {
                        showPrompt({
                            title: "重命名歌单",
                            defaultValue: sheet.title,
                            confirmText: "保存",
                            onConfirm: async (title) => {
                                await renameSheet(sheet.id, title);
                                refreshSheets();
                            },
                        });
                    },
                },
                {
                    title: "删除歌单",
                    icon: "close",
                    danger: true,
                    onClick: async () => {
                        await deleteSheet(sheet.id);
                        showToast(`已删除「${sheet.title}」`);
                        if (isActiveSheet(sheet.id)) {
                            navigate("home");
                        }
                        refreshSheets();
                    },
                },
            );
        }
        showContextMenu(e.clientX, e.clientY, items);
    };

    return (
        <aside className="app-sidebar">
            {/* macOS 红绿灯区域：拖拽 + 留白 */}
            <div className="sidebar-drag" />
            <nav className="sidebar-nav">{mainNavItems.map(renderItem)}</nav>
            <div className="sidebar-section-title">
                我的歌单
                <Icon
                    name="plus"
                    size={14}
                    title="新建歌单"
                    style={{ cursor: "pointer", color: "var(--text-tertiary)" }}
                    onClick={createSheetAction}
                />
            </div>
            <div className="sidebar-sheet-list">
                {likesSheet && (
                    <div
                        className={`sidebar-item${isActiveSheet(LIKES_SHEET_ID) ? " active" : ""}`}
                        onClick={() =>
                            navigate("sheetDetail", {
                                userSheetId: LIKES_SHEET_ID,
                                title: likesSheet.title,
                            })
                        }
                    >
                        <span
                            className="sidebar-item-icon"
                            style={{ color: "var(--primary-color)" }}
                        >
                            <Icon name="heart" size={16} />
                        </span>
                        <span
                            style={{
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                            }}
                        >
                            {likesSheet.title}
                        </span>
                        <span
                            style={{
                                marginLeft: "auto",
                                fontSize: 11,
                                color: "var(--text-tertiary)",
                            }}
                        >
                            {likesSheet.musicList.length}
                        </span>
                    </div>
                )}
                {userSheets.map((sheet) => (
                    <div
                        key={sheet.id}
                        className={`sidebar-item${isActiveSheet(sheet.id) ? " active" : ""}`}
                        onClick={() =>
                            navigate("sheetDetail", {
                                userSheetId: sheet.id,
                                title: sheet.title,
                            })
                        }
                        onContextMenu={(e) => sheetMenu(e, sheet)}
                    >
                        <span className="sidebar-item-icon">
                            <Icon name="playQueue" size={16} />
                        </span>
                        <span
                            style={{
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                            }}
                        >
                            {sheet.title}
                        </span>
                        <span
                            style={{
                                marginLeft: "auto",
                                fontSize: 11,
                                color: "var(--text-tertiary)",
                            }}
                        >
                            {sheet.musicList.length}
                        </span>
                    </div>
                ))}
            </div>
            <nav className="sidebar-nav" style={{ paddingBottom: 12 }}>
                {subNavItems.map(renderItem)}
            </nav>
        </aside>
    );
}
