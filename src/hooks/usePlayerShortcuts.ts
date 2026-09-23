import { useEffect } from "react";
import { TrackPlayerSingleton } from "@/core/trackPlayer";

/**
 * 播放器全局快捷键：空格播放/暂停，← → 上一首/下一首，↑ ↓ 调音量。
 *
 * 只在窗口内生效（Electron 主进程没有注册 globalShortcut），且不抢键盘焦点：
 * 输入框、下拉框里的方向键和空格仍然归它们自己用。
 */

/** 每次按 ↑ ↓ 改变的音量比例 */
const VOLUME_STEP = 0.05;

/** 打字 / 移动光标 / 切换选项要靠这些键，全局快捷键让开 */
function isTypingTarget(target: EventTarget | null) {
    const el = target as HTMLElement | null;
    if (!el?.tagName) {
        return false;
    }
    return (
        el.isContentEditable === true ||
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT"
    );
}

/** 原生控件按空格就会激活（按钮、链接），再处理一次就是点两下 */
function isSpaceActivated(target: EventTarget | null) {
    const el = target as HTMLElement | null;
    if (!el?.tagName) {
        return false;
    }
    return el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button";
}

function stepVolume(delta: number) {
    const next = TrackPlayerSingleton.getVolume() + delta;
    // 音量是 0~1 的浮点，按百分位取整才不会累出 0.8500000000000001
    TrackPlayerSingleton.setVolume(Math.round(next * 100) / 100);
}

export function usePlayerShortcuts() {
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) {
                return;
            }
            const isVolumeKey = e.key === "ArrowUp" || e.key === "ArrowDown";
            // 音量按住连发是渐强渐弱，播放/切歌连发只会乱跳
            if (e.repeat && !isVolumeKey) {
                return;
            }
            switch (e.key) {
                case " ":
                    if (isSpaceActivated(e.target)) {
                        return;
                    }
                    e.preventDefault();
                    TrackPlayerSingleton.togglePlay();
                    return;
                case "ArrowLeft":
                    e.preventDefault();
                    TrackPlayerSingleton.skipToPrevious();
                    return;
                case "ArrowRight":
                    e.preventDefault();
                    TrackPlayerSingleton.skipToNext();
                    return;
                case "ArrowUp":
                    e.preventDefault();
                    stepVolume(VOLUME_STEP);
                    return;
                case "ArrowDown":
                    e.preventDefault();
                    stepVolume(-VOLUME_STEP);
                    return;
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);
}
