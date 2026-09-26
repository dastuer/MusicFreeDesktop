import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import DesktopLyricsWindow from "./windows/DesktopLyricsWindow";
import "./styles/global.css";

/**
 * 桌面歌词悬浮窗与主窗口共用同一份前端代码，
 * 以 query 参数区分：?window=desktopLyrics 渲染歌词窗根组件。
 */
const isDesktopLyricsWindow =
    new URLSearchParams(window.location.search).get("window") === "desktopLyrics";

if (isDesktopLyricsWindow) {
    // 歌词窗是透明窗口：body 的应用底色要透掉，只留胶囊条本身
    document.body.classList.add("in-desktop-lyrics-window");
}

const root = createRoot(document.getElementById("root")!);
root.render(isDesktopLyricsWindow ? <DesktopLyricsWindow /> : <App />);
