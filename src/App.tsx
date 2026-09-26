import React, { useCallback, useEffect, useRef, useState } from "react";
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
    navigate,
    useCanGoBack,
    useCurrentRoute,
} from "./core/router";
import {
    IPlayFailurePayload,
    TrackPlayerEvents,
    TrackPlayerSingleton,
    loadCurrentLyric,
} from "./core/trackPlayer";
import { useThemeSetup } from "./core/theme";
import { usePlayerShortcuts } from "./hooks/usePlayerShortcuts";
import { addSearchHistory } from "./core/searchHistory";
import { setupDesktopLyrics } from "./core/desktopLyrics";

import HomePage from "./pages/home";
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
                    <div style={{ width: 8 }} />
                </div>
                <div className="page-container" key={`${route.path}-${JSON.stringify(route.params)}`}>
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
        // setup() 只还原播放列表 / 当前歌曲，并把进度条摆到上次听到的位置，
        // 不会自动出声：重启后要不要接着听，由用户按播放决定。
        TrackPlayerSingleton.setup();
        // 桌面歌词：接好「状态推送 → 歌词窗」与「歌词窗遥控 → 播放器」两条链路
        setupDesktopLyrics();
    }, []);

    // 换歌失败时把原因说出来：失败后播放器会真正停下来，不再静默地把上一首继续放下去
    useEffect(() => {
        const onPlayFailed = (payload: IPlayFailurePayload) => {
            const title = payload.musicItem?.title ?? "当前歌曲";
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
