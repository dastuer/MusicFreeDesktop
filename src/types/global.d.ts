declare global {
    interface Window {
        mfp: {
            invoke: (channel: string, ...args: any[]) => Promise<any>;
            onDownloadEvent: (callback: (data: any) => void) => void;
            /** 启动时的上次播放会话（主进程 data/session.json，见 core/playProgress.ts） */
            initialSession: IPlaySessionSnapshot | null;
            /** 主进程退出前索要最新进度 */
            onSessionFlush: (callback: () => void) => void;
            /** 回执：会话已写完盘 */
            notifySessionSaved: () => void;
            /** ---------- 桌面歌词（见 core/desktopLyrics.ts 与 windows/DesktopLyricsWindow.tsx） ---------- */
            /** 主窗口 → 歌词窗：推送播放状态 */
            sendLyricsState: (state: {
                music: IMusic.IMusicItem | null;
                playing: boolean;
                loading: boolean;
                liked: boolean;
                position: number;
                duration: number;
                lines: ILyric.IParsedLrc;
                /** 已解析的激活行（前奏/无歌词时退回歌名）：菜单栏标题与悬浮窗共用 */
                activeLine: string;
            }) => void;
            /** 歌词窗 → 主窗口：遥控命令 */
            sendLyricsCommand: (cmd: "togglePlay" | "next" | "prev" | "toggleLike") => void;
            /** 歌词窗挂载完成：请主进程让主窗口补推一份状态 */
            notifyLyricsReady: () => void;
            /** 歌词窗可见性变化（开关按钮状态跟它走） */
            onLyricsVisibility: (callback: (visible: boolean) => void) => void;
            /** 歌词窗：接收播放状态 */
            onLyricsState: (callback: (state: any) => void) => void;
            /** 主窗口：接收歌词窗遥控命令 */
            onLyricsCommand: (callback: (cmd: string) => void) => void;
            /** 主窗口 → 主进程：菜单栏托盘图标（base64 PNG，与播放栏同源 SVG 画成） */
            sendLyricsIcons: (icons: Record<string, string>) => void;
        };
    }

    /** 上次播放会话快照（与 electron/services/sessionStore.ts 的 ISessionSnapshot 对齐） */
    interface IPlaySessionSnapshot {
        version: number;
        music: IMusic.IMusicItem | null;
        position: number;
        duration: number;
        musicUpdatedAt: number;
        playList: IMusic.IMusicItem[] | null;
        playListUpdatedAt: number;
    }
}

export {};
