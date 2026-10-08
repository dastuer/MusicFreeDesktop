import React, { useEffect, useState } from "react";
import Icon from "../components/base/Icon";

/**
 * 桌面歌词悬浮窗（独立 BrowserWindow 的根组件，?window=desktopLyrics 进入，
 * 仅在不支持菜单栏歌词的平台上使用）：深色胶囊条 = 左侧当前歌词行（可双行：原文+译文）
 * + 右侧遥控（上一首/播放/下一首/喜欢/关闭）。数据由主窗口经主进程推来
 * （激活行已解析好，见 core/desktopLyrics.ts），自身不碰播放器。
 * 整条可拖动（-webkit-app-region: drag），位置由主进程记忆。
 * 显示设置（字号/双行/鼠标穿透锁定）由主窗口面板改，主进程即时推来并落盘；
 * 锁定态下遥控钮收起（整窗不吃鼠标，解锁要回主窗口）。
 */

interface ILyricsWindowState {
    playing: boolean;
    liked: boolean;
    /** 已解析的激活行（前奏/无歌词时已退回歌名） */
    activeLine: string;
    /** 双行开启且该行有译文 */
    activeTranslation?: string;
}

interface ILyricsWindowSettings {
    fontSize: number;
    twoLine: boolean;
    locked: boolean;
}

const INITIAL_STATE: ILyricsWindowState = {
    playing: false,
    liked: false,
    activeLine: "",
};

const INITIAL_SETTINGS: ILyricsWindowSettings = {
    fontSize: 17,
    twoLine: false,
    locked: false,
};

export default function DesktopLyricsWindow() {
    const [state, setState] = useState<ILyricsWindowState>(INITIAL_STATE);
    const [settings, setSettings] = useState<ILyricsWindowSettings>(INITIAL_SETTINGS);

    useEffect(() => {
        window.mfp?.onLyricsState(setState as any);
        window.mfp?.onLyricsSettings(setSettings);
        // 挂载完成：让主窗口立刻补推一份状态，别等下一次 timeupdate
        window.mfp?.notifyLyricsReady();
    }, []);

    // 兜底：还没收到过状态包时别留一条空胶囊
    const text = state.activeLine || "MusicFree Desktop";
    const translation = settings.twoLine ? state.activeTranslation : undefined;

    const send = (cmd: "togglePlay" | "next" | "prev" | "toggleLike") => {
        window.mfp?.sendLyricsCommand(cmd);
    };

    return (
        <div className="desktop-lyrics" style={{ fontSize: settings.fontSize }}>
            <div className="desktop-lyrics-lines">
                <div className="desktop-lyrics-text" title={text}>
                    {text}
                </div>
                {translation && (
                    <div className="desktop-lyrics-text desktop-lyrics-translation" title={translation}>
                        {translation}
                    </div>
                )}
            </div>
            {!settings.locked && (
                <div className="desktop-lyrics-controls">
                    <button
                        className="desktop-lyrics-btn"
                        title="上一首"
                        onClick={() => send("prev")}
                    >
                        <Icon name="prev" size={15} />
                    </button>
                    <button
                        className="desktop-lyrics-btn"
                        title={state.playing ? "暂停" : "播放"}
                        onClick={() => send("togglePlay")}
                    >
                        <Icon name={state.playing ? "pause" : "play"} size={15} />
                    </button>
                    <button
                        className="desktop-lyrics-btn"
                        title="下一首"
                        onClick={() => send("next")}
                    >
                        <Icon name="next" size={15} />
                    </button>
                    <button
                        className="desktop-lyrics-btn"
                        title={state.liked ? "取消喜欢" : "喜欢"}
                        onClick={() => send("toggleLike")}
                    >
                        <Icon
                            name={state.liked ? "heartFilled" : "heart"}
                            size={16}
                            style={{ color: state.liked ? "var(--primary-color)" : undefined }}
                        />
                    </button>
                    <button
                        className="desktop-lyrics-btn"
                        title="关闭桌面歌词"
                        onClick={() => window.mfp?.invoke("lyrics:hide")}
                    >
                        <Icon name="close" size={13} />
                    </button>
                </div>
            )}
        </div>
    );
}
