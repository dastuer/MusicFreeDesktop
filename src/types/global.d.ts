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
                /** 双行开启且该行有译文时的第二行 */
                activeTranslation?: string;
                /** 显示设置快照（双行开关影响菜单栏的拼接） */
                settings?: IDesktopLyricsSettings;
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
            /** ---------- 桌面歌词设置（见 core/desktopLyrics.ts 与 services/lyricsWindow.ts） ---------- */
            /** 主窗口：推送歌词窗设置（形态/字号/双行/锁定），主进程落盘并即时生效 */
            sendLyricsSettings: (settings: IDesktopLyricsSettings) => void;
            /** 歌词窗：接收设置 */
            onLyricsSettings: (callback: (settings: IDesktopLyricsSettings) => void) => void;
            /** ---------- 系统集成（托盘 / 全局快捷键 / 任务栏缩略图按钮，见 core/systemIntegration.ts） ---------- */
            /** 主窗口 → 主进程：播放状态快照（托盘菜单与缩略图按钮跟着走） */
            sendSystemState: (state: {
                hasMusic: boolean;
                playing: boolean;
                liked: boolean;
                title: string;
                artist: string;
            }) => void;
            /** 主窗口 → 主进程：托盘/缩略图按钮图标（base64 PNG） */
            sendSystemIcons: (icons: Record<string, string>) => void;
            /** 主窗口：接收托盘菜单/全局快捷键/缩略图按钮发来的命令 */
            onSystemCommand: (callback: (cmd: string) => void) => void;
        };
    }

    /** 桌面歌词设置（与 electron/services/lyricsWindow.ts 对齐） */
    interface IDesktopLyricsSettings {
        /** 形态（仅 mac 可选）：菜单栏 / 悬浮窗；其他平台主进程恒走悬浮窗 */
        form: "menubar" | "overlay";
        /** 字号 px（12-32，悬浮窗专属） */
        fontSize: number;
        /** 双行：原文 + 译文（悬浮窗两行；菜单栏拼成「原文 · 译文」） */
        twoLine: boolean;
        /** 鼠标穿透锁定：整窗不吃鼠标事件（悬浮窗形态专属） */
        locked: boolean;
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
