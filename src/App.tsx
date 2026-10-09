import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Sidebar from "./components/layout/Sidebar";
import PlayerBar from "./components/layout/PlayerBar";
import MusicDetailOverlay from "./components/layout/MusicDetailOverlay";
import PlayQueuePanelHost from "./components/layout/PlayQueuePanel";
import ContextMenuHost from "./components/base/ContextMenu";
import ToastHost, { showToast } from "./components/base/Toast";
import AddToSheetPanelHost from "./components/base/AddToSheetPanel";
import PromptDialogHost from "./components/base/PromptDialog";
import DownloadPanelHost from "./components/base/DownloadPanel";
import SearchHistoryPanel from "./components/base/SearchHistoryPanel";
import Icon from "./components/base/Icon";
import {
    goBack,
    getLastNavKind,
    navigate,
    useCanGoBack,
    useCurrentRoute,
} from "./core/router";
import { recallScroll, rememberScroll } from "./core/scrollMemory";
import {
    IPlayFailurePayload,
    IQualitySwapFailedPayload,
    TrackPlayerEvents,
    TrackPlayerSingleton,
    loadCurrentLyric,
} from "./core/trackPlayer";
import { useThemeSetup } from "./core/theme";
import { usePlayerShortcuts } from "./hooks/usePlayerShortcuts";
import { addSearchHistory } from "./core/searchHistory";
import { setupDesktopLyrics } from "./core/desktopLyrics";
import { setupSystemIntegration } from "./core/systemIntegration";
import { initUpdater, openReleasePage, updateResultAtom } from "./core/updater";
import { useAtomValue } from "jotai";

import HomePage from "./pages/home";
import NeteaseDailyPage from "./pages/neteaseDaily";
import NeteasePlaylistDetailPage from "./pages/neteasePlaylistDetail";
import SearchPage from "./pages/search";
import SheetDetailPage from "./pages/sheetDetail";
import AlbumDetailPage from "./pages/albumDetail";
import ArtistDetailPage from "./pages/artistDetail";
import TopListPage from "./pages/topList";
import TopListDetailPage from "./pages/topListDetail";
import LocalMusicPage from "./pages/localMusic";
import HistoryPage from "./pages/history";
import DownloadingPage from "./pages/downloading";
import PluginManagePage from "./pages/pluginManage";
import SettingsPage from "./pages/settings";

const pageMap: Record<string, React.ComponentType<any>> = {
    home: HomePage,
    neteaseDaily: NeteaseDailyPage,
    neteasePlaylistDetail: NeteasePlaylistDetailPage,
    search: SearchPage,
    sheetDetail: SheetDetailPage,
    albumDetail: AlbumDetailPage,
    artistDetail: ArtistDetailPage,
    topList: TopListPage,
    topListDetail: TopListDetailPage,
    localMusic: LocalMusicPage,
    history: HistoryPage,
    downloading: DownloadingPage,
    pluginManage: PluginManagePage,
    settings: SettingsPage,
};

/** Windows 的系统 caption 按钮（最小化/最大化/关闭）画在标题栏右上角，会盖住右上角入口 */
const IS_WINDOWS = /Windows/.test(navigator.userAgent);
/** 三个 caption 按钮约 140px，再留 8px 呼吸空隙 */
const TITLEBAR_RIGHT_INSET = IS_WINDOWS ? 148 : 20;

function MainContent(props: { onOpenDetail: () => void }) {
    const { onOpenDetail } = props;
    const route = useCurrentRoute();
    const canGoBack = useCanGoBack();
    const [keyword, setKeyword] = useState("");
    /** 搜索框聚焦时下拉的搜索历史面板 */
    const [historyVisible, setHistoryVisible] = useState(false);
    /** 搜索框 + 历史面板：判断「点击是否落在外面」用，两者都算里面 */
    const searchBoxRef = useRef<HTMLDivElement>(null);

    const Page = pageMap[route.path] ?? HomePage;

    /** 滚动容器：页面实例（路由条目）切换时按导航方向恢复/重置滚动位置 */
    const pageScrollRef = useRef<HTMLDivElement>(null);

    // 返回/前进时恢复该页面实例离开时的滚动位置；新进的页面从顶部开始。
    // 用 useLayoutEffect 在首帧绘制前设置 scrollTop，避免先画顶部再跳回去。
    useLayoutEffect(() => {
        const el = pageScrollRef.current;
        if (!el) {
            return;
        }
        const kind = getLastNavKind();
        el.scrollTop = kind === "back" || kind === "forward" ? recallScroll(route.id) : 0;
    }, [route.id]);

    /** 发起一次搜索：回填输入框、记历史、跳转。回车和点历史都走这里 */
    const runSearch = useCallback((raw: string) => {
        const query = raw.trim();
        if (!query) {
            return;
        }
        setKeyword(query);
        addSearchHistory(query);
        setHistoryVisible(false);
        navigate("search", { query, refresh: Date.now() });
    }, []);

    // 点面板外部 / 按 Esc 收起历史。刻意不用 input 失焦来关：
    // 点历史条目时输入框必然先失焦，用 blur 会在跳转前把面板拆掉。
    useEffect(() => {
        if (!historyVisible) {
            return;
        }
        const onMouseDown = (e: MouseEvent) => {
            if (!searchBoxRef.current?.contains(e.target as Node)) {
                setHistoryVisible(false);
            }
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setHistoryVisible(false);
            }
        };
        document.addEventListener("mousedown", onMouseDown);
        window.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("mousedown", onMouseDown);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [historyVisible]);

    return (
        <>
            <main className="app-main">
                <div className="titlebar-drag">
                    <button
                        className="titlebar-nav-btn"
                        disabled={!canGoBack}
                        onClick={() => goBack()}
                        title="后退"
                    >
                        <Icon name="back" size={18} />
                    </button>
                    <div className="search-input-wrap" ref={searchBoxRef}>
                        <Icon name="search" size={14} style={{ color: "var(--text-tertiary)" }} />
                        <input
                            placeholder="搜索音乐、歌单、专辑、歌手"
                            value={keyword}
                            onChange={(e) => setKeyword(e.target.value)}
                            onFocus={() => setHistoryVisible(true)}
                            // 只靠 focus 不够：输入框已经聚焦时（点完历史、按 Esc 收起后）
                            // 再点它不会重新触发 focus，历史面板就打不开了
                            onMouseDown={() => setHistoryVisible(true)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    runSearch(keyword);
                                    (e.target as HTMLInputElement).blur();
                                }
                            }}
                        />
                        {historyVisible && <SearchHistoryPanel onPick={runSearch} />}
                    </div>
                    {/*
                     * 搜索框右侧的标题栏空白处。
                     * 这里是 -webkit-app-region: drag 区，落在拖拽区里的 mousedown 会被窗口拖动吃掉、
                     * 根本传不到渲染进程，所以「点空白处关掉历史面板」从来没生效过。
                     * 面板展开时临时把这一块改成 no-drag，点击才能落到页面上被外面的监听接住。
                     */}
                    <div
                        className={`titlebar-spacer${historyVisible ? " panel-open" : ""}`}
                        style={{ flex: 1 }}
                    />
                    {/* 右上角固定入口：音源 / 设置（原侧边栏底部入口上移到这里） */}
                    <div className="titlebar-actions">
                        <button
                            className={`titlebar-nav-btn${route.path === "pluginManage" ? " active" : ""}`}
                            onClick={() => navigate("pluginManage")}
                            title="音源"
                        >
                            <Icon name="plugin" size={17} />
                        </button>
                        <button
                            className={`titlebar-nav-btn${route.path === "settings" ? " active" : ""}`}
                            onClick={() => navigate("settings")}
                            title="设置"
                        >
                            <Icon name="settings" size={17} />
                        </button>
                    </div>
                    {/* 设置入口右侧留边距：Windows 要避开系统 caption 按钮区域 */}
                    <div style={{ width: TITLEBAR_RIGHT_INSET }} />
                </div>
                <div
                    className="page-container"
                    key={`${route.path}-${JSON.stringify(route.params)}`}
                    ref={pageScrollRef}
                    onScroll={() => {
                        const el = pageScrollRef.current;
                        if (el) {
                            rememberScroll(route.id, el.scrollTop);
                        }
                    }}
                >
                    <Page {...route.params} />
                </div>
            </main>
        </>
    );
}

export default function App() {
    useThemeSetup();
    usePlayerShortcuts();
    const [musicDetailVisible, setMusicDetailVisible] = useState(false);

    useEffect(() => {
        // setup() 还原播放列表 / 当前歌曲，并把进度条摆到上次听到的位置，默认不出声：
        // 要不要接着听由用户按播放决定；仅当「程序启动时自动播放」开着才自动起播。
        TrackPlayerSingleton.setup();
        // 桌面歌词：接好「状态推送 → 歌词窗」与「歌词窗遥控 → 播放器」两条链路
        setupDesktopLyrics();
        // 托盘 / 全局快捷键 / 任务栏缩略图按钮：图标与状态在这边供，命令回这边执行
        setupSystemIntegration();
        // 检查更新：读一次状态并按设置自动查（是否开启见设置页「关于」节）
        void initUpdater();
    }, []);

    // 启动检查发现新版本：弹一条 toast 引去 GitHub release 页（结果不落 localStorage，每次启动都提醒）
    const updateResult = useAtomValue(updateResultAtom);
    const lastNotifiedRef = useRef<string | null>(null);
    useEffect(() => {
        if (!updateResult?.updateAvailable || !updateResult.url) {
            return;
        }
        // 同一个版本只在本次会话提醒一次（设置页手动检查改状态时会再进这里）
        if (lastNotifiedRef.current === updateResult.url) {
            return;
        }
        lastNotifiedRef.current = updateResult.url;
        showToast(
            `发现新版本 ${updateResult.latestVersion}（当前 v${updateResult.currentVersion}），点击前往下载`,
            {
                action: { text: "查看", onClick: () => openReleasePage(updateResult.url!) },
                duration: 8000,
            },
        );
    }, [updateResult?.updateAvailable, updateResult?.url, updateResult?.latestVersion, updateResult?.currentVersion]);

    // 播放失败时把原因说出来：能降级音质自救的本曲会接着重试，救不了才停住或跳下一首
    useEffect(() => {
        const onPlayFailed = (payload: IPlayFailurePayload) => {
            const title = payload.musicItem?.title ?? "当前歌曲";
            if (payload.downgradedTo) {
                showToast(`「${title}」播放失败：${payload.reason}，已自动降低音质重试`);
                return;
            }
            showToast(
                payload.willSkip
                    ? `「${title}」无法播放：${payload.reason}，已跳到下一首`
                    : `「${title}」无法播放：${payload.reason}`,
            );
        };
        TrackPlayerSingleton.on(TrackPlayerEvents.PlayFailed, onPlayFailed);
        return () => {
            TrackPlayerSingleton.off(TrackPlayerEvents.PlayFailed, onPlayFailed);
        };
    }, []);

    // 切音质失败不打断播放（旧音源继续响），说一声就好：用户选的档暂时用不上
    useEffect(() => {
        const onQualitySwapFailed = (payload: IQualitySwapFailedPayload) => {
            const title = payload.musicItem?.title ?? "当前歌曲";
            showToast(`「${title}」无法切换音质：${payload.reason}，将继续以当前音质播放`);
        };
        TrackPlayerSingleton.on(TrackPlayerEvents.QualitySwapFailed, onQualitySwapFailed);
        return () => {
            TrackPlayerSingleton.off(TrackPlayerEvents.QualitySwapFailed, onQualitySwapFailed);
        };
    }, []);

    const openMusicDetail = () => {
        if (!TrackPlayerSingleton.currentMusic) {
            return;
        }
        setMusicDetailVisible((v) => {
            if (!v) {
                loadCurrentLyric(TrackPlayerSingleton.currentMusic!);
            }
            return !v;
        });
    };

    return (
        <div className="app-shell">
            <Sidebar />
            <MainContent onOpenDetail={openMusicDetail} />
            <PlayerBar onOpenDetail={openMusicDetail} />
            <MusicDetailOverlay
                visible={musicDetailVisible}
                onClose={() => setMusicDetailVisible(false)}
            />
            <PlayQueuePanelHost />
            <AddToSheetPanelHost />
            <PromptDialogHost />
            <DownloadPanelHost />
            <ContextMenuHost />
            <ToastHost />
        </div>
    );
}
