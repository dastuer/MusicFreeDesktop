import React, { useEffect, useState } from "react";
import Sidebar from "./components/layout/Sidebar";
import PlayerBar from "./components/layout/PlayerBar";
import MusicDetailOverlay from "./components/layout/MusicDetailOverlay";
import PlayQueuePanelHost from "./components/layout/PlayQueuePanel";
import ContextMenuHost from "./components/base/ContextMenu";
import ToastHost from "./components/base/Toast";
import AddToSheetPanelHost from "./components/base/AddToSheetPanel";
import PromptDialogHost from "./components/base/PromptDialog";
import DownloadPanelHost from "./components/base/DownloadPanel";
import Icon from "./components/base/Icon";
import {
    goBack,
    navigate,
    useCanGoBack,
    useCurrentRoute,
} from "./core/router";
import { TrackPlayerSingleton, loadCurrentLyric } from "./core/trackPlayer";
import { useThemeSetup } from "./core/theme";

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

    const Page = pageMap[route.path] ?? HomePage;

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
                    <div className="search-input-wrap">
                        <Icon name="search" size={14} style={{ color: "var(--text-tertiary)" }} />
                        <input
                            placeholder="搜索音乐、歌单、专辑、歌手"
                            value={keyword}
                            onChange={(e) => setKeyword(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && keyword.trim()) {
                                    navigate("search", { query: keyword.trim(), refresh: Date.now() });
                                    (e.target as HTMLInputElement).blur();
                                }
                            }}
                        />
                    </div>
                    <div style={{ flex: 1 }} />
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
    const [musicDetailVisible, setMusicDetailVisible] = useState(false);

    useEffect(() => {
        TrackPlayerSingleton.setup();
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
