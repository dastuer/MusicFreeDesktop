import { atom, getDefaultStore, useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { TrackPlayerSingleton, TrackPlayerEvents } from "./trackPlayer";

/**
 * 定时关闭（睡眠定时器）：倒计时到点就暂停播放。
 *  - 只暂停、不退出应用：定时关的是「播放」，不是播放器本身（对标主流播放器语义）；
 *  - 跑在墙上时钟（setTimeout + deadline 时间戳），播放暂停与否不影响倒计时；
 *  - 也支持「播完 N 首后关闭」：按 PlayEnd 事件计数，播完一首减一；
 *  - 纯会话级：重启不续倒计时（睡前的定时重来一次就好，持久化一个会误伤的小倒计时不值当）。
 */

export type SleepTimerMode = "off" | "countdown" | "songs";

export interface ISleepTimerState {
    mode: SleepTimerMode;
    /** countdown 模式的截止时刻（epoch ms） */
    deadline: number | null;
    /** songs 模式：还剩几首播完 */
    songsLeft: number | null;
}

const store = getDefaultStore();
export const sleepTimerAtom = atom<ISleepTimerState>({
    mode: "off",
    deadline: null,
    songsLeft: null,
});

let countdownTimer: ReturnType<typeof setTimeout> | null = null;
let playEndUnsub: (() => void) | null = null;

function clearTimer() {
    if (countdownTimer) {
        clearTimeout(countdownTimer);
        countdownTimer = null;
    }
    if (playEndUnsub) {
        playEndUnsub();
        playEndUnsub = null;
    }
}

function fireAndStop() {
    clearTimer();
    store.set(sleepTimerAtom, { mode: "off", deadline: null, songsLeft: null });
    void TrackPlayerSingleton.pause();
}

function armCountdown(ms: number) {
    clearTimer();
    const deadline = Date.now() + ms;
    store.set(sleepTimerAtom, { mode: "countdown", deadline, songsLeft: null });
    countdownTimer = setTimeout(fireAndStop, ms);
}

function armSongs(count: number) {
    clearTimer();
    store.set(sleepTimerAtom, { mode: "songs", deadline: null, songsLeft: count });
    const onPlayEnd = () => {
        const cur = store.get(sleepTimerAtom);
        if (cur.mode !== "songs" || cur.songsLeft == null) {
            return;
        }
        const left = cur.songsLeft - 1;
        if (left <= 0) {
            fireAndStop();
        } else {
            store.set(sleepTimerAtom, { ...cur, songsLeft: left });
        }
    };
    TrackPlayerSingleton.on(TrackPlayerEvents.PlayEnd, onPlayEnd);
    playEndUnsub = () => TrackPlayerSingleton.off(TrackPlayerEvents.PlayEnd, onPlayEnd);
}

/** 选项表：设置页/播放栏菜单共用。0 分钟档即关闭 */
export const SLEEP_COUNTDOWN_PRESETS = [10, 20, 30, 45, 60, 90];
export const SLEEP_SONG_PRESETS = [1, 3, 5];

/** 开一个倒计时（分钟） */
export function startSleepCountdown(minutes: number) {
    armCountdown(Math.max(1, Math.round(minutes)) * 60 * 1000);
}

/** 开一个「播完 N 首」定时器 */
export function startSleepAfterSongs(songs: number) {
    armSongs(Math.max(1, Math.round(songs)));
}

export function stopSleepTimer() {
    clearTimer();
    store.set(sleepTimerAtom, { mode: "off", deadline: null, songsLeft: null });
}

/** 剩余毫秒（倒计时模式）；非倒计时模式返回 null。每秒重算一次（UI 用） */
export function useSleepRemaining() {
    const state = useAtomValue(sleepTimerAtom);
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (state.mode !== "countdown") {
            return;
        }
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [state.mode]);
    if (state.mode !== "countdown" || !state.deadline) {
        return null;
    }
    return Math.max(0, state.deadline - now);
}
