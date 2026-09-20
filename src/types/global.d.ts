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
