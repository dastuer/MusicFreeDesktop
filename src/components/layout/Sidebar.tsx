import React, { useEffect, useRef, useState } from "react";
import Draggable from "react-draggable";
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
    reorderSheets,
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

// 歌单行拖动排序的位移单位：.sidebar-item 高 38 + margin-bottom 2
const ITEM_PITCH = 40;

/** 一次拖动会话的状态；dragRef 是权威，drag state 只是渲染镜像 */
interface DragState {
    id: string;
    startIndex: number;
    /** 自拖拽起点累计的指针位移（px） */
    y: number;
    targetIndex: number;
    /** 超过 3px 才算真拖了，普通点击不触发抬起效果与 click 抑制 */
    moved: boolean;
}

export default function Sidebar() {
    const route = useCurrentRoute();
    const [sheets, setSheets] = useState<IUserSheet[]>([]);
    // ---------- 拖动排序（react-draggable，「我喜欢的音乐」不参与） ----------
    const dragRef = useRef<DragState | null>(null);
    const [drag, setDrag] = useState<DragState | null>(null);
    // 拖完松手紧跟着的那次 click 是拖拽的收尾，不是「打开歌单」
    const suppressClickUntilRef = useRef(0);

    const refreshSheets = () => {
        // 拖动中本地顺序就是权威顺序，别让 3 秒轮询把旧顺序刷回来
        if (dragRef.current) {
            return;
        }
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
                            // 与歌单详情页传同一个标识，队列的来历认得到这个歌单
                            `userSheet:${sheet.id}`,
                            // 「播放全部」是明确指令：一律重新铺一遍这份歌单
                            true,
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

    // ---------- 拖动排序（react-draggable，「我喜欢的音乐」不参与） ----------
    // 策略：被拖项由 Draggable 控制位移平滑跟随指针；拖动经过其他歌单时，
    // 其余项按 40px 一个档位做过渡动画让位；松手一次性换位落盘。
    // 轮询刷新在拖动期间挂起（见 refreshSheets），避免旧顺序刷回来。

    const handleDragStart = (sheetId: string, startIndex: number) => {
        dragRef.current = { id: sheetId, startIndex, y: 0, targetIndex: startIndex, moved: false };
        setDrag(dragRef.current);
    };

    const handleDragMove = (deltaY: number) => {
        const cur = dragRef.current;
        if (!cur) {
            return;
        }
        const y = cur.y + deltaY;
        const targetIndex = Math.max(
            0,
            Math.min(userSheets.length - 1, cur.startIndex + Math.round(y / ITEM_PITCH)),
        );
        dragRef.current = { ...cur, y, targetIndex, moved: cur.moved || Math.abs(y) > 3 };
        setDrag(dragRef.current);
    };

    const handleDragStop = () => {
        const d = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (!d || !d.moved || d.targetIndex === d.startIndex) {
            return;
        }
        suppressClickUntilRef.current = Date.now() + 400;
        // 本地先换位（likes 永远钉在最前），再落盘对齐
        const likes = sheets.filter((it) => it.id === LIKES_SHEET_ID);
        const others = sheets.filter((it) => it.id !== LIKES_SHEET_ID);
        const [movedSheet] = others.splice(d.startIndex, 1);
        others.splice(d.targetIndex, 0, movedSheet);
        setSheets([...likes, ...others]);
        reorderSheets(others.map((it) => it.id)).then(refreshSheets);
    };

    const handleSheetClick = (sheet: IUserSheet) => {
        if (Date.now() < suppressClickUntilRef.current) {
            return;
        }
        navigate("sheetDetail", { userSheetId: sheet.id, title: sheet.title });
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
                {userSheets.map((sheet, index) => {
                    const draggingSelf = drag?.id === sheet.id && drag.moved;
                    // 其余项给被拖项让位：跨过一个档位就补上 40px 过渡位移
                    let shiftY = 0;
                    if (drag?.moved && drag.id !== sheet.id) {
                        if (index > drag.startIndex && index <= drag.targetIndex) {
                            shiftY = -ITEM_PITCH;
                        } else if (index < drag.startIndex && index >= drag.targetIndex) {
                            shiftY = ITEM_PITCH;
                        }
                    }
                    return (
                        <SheetDraggable
                            key={sheet.id}
                            offsetY={drag?.id === sheet.id ? drag.y : 0}
                            dragging={!!draggingSelf}
                            shiftY={shiftY}
                            onStart={() => handleDragStart(sheet.id, index)}
                            onMove={handleDragMove}
                            onStop={handleDragStop}
                            onOpen={() => handleSheetClick(sheet)}
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
                        </SheetDraggable>
                    );
                })}
            </div>
            <nav className="sidebar-nav" style={{ paddingBottom: 12 }}>
                {subNavItems.map(renderItem)}
            </nav>
        </aside>
    );
}

/**
 * 侧边栏歌单行的拖拽外壳。
 * 外层 div 的 transform 由 Draggable 接管（被拖项跟随指针），
 * 内层 .sidebar-item 的 transform 留给「让位」过渡动画——
 * 两者必须分层，否则 Draggable 写入的 translate 会把让位位移覆盖掉。
 */
function SheetDraggable(props: {
    offsetY: number;
    dragging: boolean;
    shiftY: number;
    onStart: () => void;
    onMove: (deltaY: number) => void;
    onStop: () => void;
    onOpen: () => void;
    onContextMenu: (e: React.MouseEvent) => void;
    children: React.ReactNode;
}) {
    const nodeRef = useRef<HTMLDivElement>(null);
    return (
        <Draggable
            nodeRef={nodeRef}
            axis="y"
            position={{ x: 0, y: props.offsetY }}
            onStart={props.onStart}
            onDrag={(_, data) => props.onMove(data.deltaY)}
            onStop={props.onStop}
        >
            <div
                ref={nodeRef}
                style={{ position: "relative", zIndex: props.dragging ? 10 : undefined }}
            >
                <div
                    className={`sidebar-item${props.dragging ? " dragging" : ""}`}
                    style={{
                        transform:
                            !props.dragging && props.shiftY
                                ? `translateY(${props.shiftY}px)`
                                : undefined,
                        transition: props.dragging ? "none" : "transform 160ms ease",
                    }}
                    onClick={props.onOpen}
                    onContextMenu={props.onContextMenu}
                >
                    {props.children}
                </div>
            </div>
        </Draggable>
    );
}
