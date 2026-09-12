import { atom, getDefaultStore, useAtomValue } from "jotai";
import EventEmitter from "eventemitter3";
import {
    buildLocalMediaUrl,
    buildRemoteMediaUrl,
    getPluginByMedia,
    getSortedPluginsWithAbility,
    ipcInvoke,
    pluginCall,
} from "./ipc";
import { setMusicHistory } from "./musicHistory";
import { getQuality } from "./appConfig";

export type MusicState = "playing" | "paused" | "stopped";
export type MusicRepeatMode = "off" | "queue" | "single";

/**
 * 内联封面尺寸上限。超过就认为它是"整张图塞成 base64"，不该进 localStorage、
 * 也不该交给 MediaMetadata（Chromium 会直接报 "MediaImage src exceeds maximum URL length"，
 * 并把这条错误连着几 MB 的 base64 打到控制台）。
 */
const MAX_PERSISTED_ARTWORK = 64 * 1024;

export const enum TrackPlayerEvents {
    PlayEnd = "PlayEnd",
    CurrentMusicChanged = "CurrentMusicChanged",
    ProgressChanged = "ProgressChanged",
    StateChanged = "StateChanged",
}

/** ---------- jotai atoms ---------- */
export const playListAtom = atom<IMusic.IMusicItem[]>([]);
export const currentMusicAtom = atom<IMusic.IMusicItem | null>(null);
export const musicStateAtom = atom<MusicState>("stopped");
export const repeatModeAtom = atom<MusicRepeatMode>("off");
export const progressAtom = atom<{ position: number; duration: number }>({
    position: 0,
    duration: 0,
});
export const rateAtom = atom<number>(1);

const store = getDefaultStore();

function setAtom<T>(atom_: any, value: T) {
    store.set(atom_, value);
}

/** ---------- 播放器 ---------- */

class TrackPlayer extends EventEmitter {
    private audio: HTMLAudioElement | null = null;
    private _repeatMode: MusicRepeatMode = "off";
    private _playList: IMusic.IMusicItem[] = [];
    private _currentMusic: IMusic.IMusicItem | null = null;
    private _rate = 1;
    private pendingPlayId = "";

    setup() {
        if (this.audio) {
            return;
        }
        const audio = new Audio();
        audio.preload = "auto";
        audio.volume = Math.min(Number(localStorage.getItem("volume") ?? 0.8), 1);
        audio.addEventListener("ended", this.onEnded);
        audio.addEventListener("timeupdate", this.onProgress);
        audio.addEventListener("loadedmetadata", this.onProgress);
        audio.addEventListener("pause", this.onAudioPause);
        audio.addEventListener("play", this.onAudioPlay);
        audio.addEventListener("error", this.onAudioError);
        this.audio = audio;

        // 恢复播放列表
        try {
            const saved = localStorage.getItem("playList");
            if (saved) {
                this._playList = JSON.parse(saved);
                setAtom(playListAtom, this._playList);
            }
            const savedCurrent = localStorage.getItem("currentMusic");
            if (savedCurrent) {
                this._currentMusic = JSON.parse(savedCurrent);
                setAtom(currentMusicAtom, this._currentMusic);
            }
            const savedRepeat = localStorage.getItem("repeatMode");
            if (savedRepeat) {
                this._repeatMode = savedRepeat as MusicRepeatMode;
                setAtom(repeatModeAtom, this._repeatMode);
            }
        } catch {
            // ignore
        }
    }

    /** ---------- 内部事件 ---------- */
    private onProgress = () => {
        if (!this.audio) {
            return;
        }
        const progress = {
            position: this.audio.currentTime || 0,
            duration: this.audio.duration || 0,
        };
        setAtom(progressAtom, progress);
        this.emit(TrackPlayerEvents.ProgressChanged, progress);
    };

    private onAudioPause = () => {
        if (this._currentMusic) {
            setAtom(musicStateAtom, "paused");
        }
    };

    private onAudioPlay = () => {
        setAtom(musicStateAtom, "playing");
    };

    private onAudioError = async () => {
        const err = this.audio?.error;
        console.warn(
            `[trackPlayer] media error code=${err?.code} message=${err?.message} srcLen=${this.audio?.src?.length ?? 0} srcPrefix=${this.audio?.src?.slice(0, 40) ?? "-"}`,
        );
        // 兜底：音源解析失败时尝试下一首
        if (this._currentMusic && this.audio?.src) {
            await this.skipToNext();
        }
    };

    private onEnded = async () => {
        if (!this._currentMusic) {
            return;
        }
        if (this._repeatMode === "single") {
            this.audio!.currentTime = 0;
            this.audio!.play();
            return;
        }
        // 列表末尾
        const index = this.getMusicIndexInPlayList(this._currentMusic);
        if (
            index === this._playList.length - 1 &&
            this._repeatMode === "off" &&
            this._playList.length > 1
        ) {
            // 列表循环模式下回到第一首; off 模式播放完结束
            this.emit(TrackPlayerEvents.PlayEnd);
            setAtom(musicStateAtom, "stopped");
            return;
        }
        await this.skipToNext();
    };

    /** ---------- 播放列表管理 ---------- */
    get playList() {
        return this._playList;
    }
    get currentMusic() {
        return this._currentMusic;
    }
    get repeatMode() {
        return this._repeatMode;
    }

    private persistPlayList() {
        // 播放列表整体写进 localStorage，每次增删都会重写一遍。
        // 若其中有条目带着音源塞进来的大体积 base64 封面（见过 13 MB 的 PNG），
        // 这行就会反复往 leveldb 里灌几十 MB，日志文件被撑大、GC 压力陡增。
        // 落盘前把这类内联封面丢掉：内存里的列表不受影响，界面照常显示。
        const slim = (item: IMusic.IMusicItem): IMusic.IMusicItem =>
            typeof item.artwork === "string" && item.artwork.length > MAX_PERSISTED_ARTWORK
                ? { ...item, artwork: "" }
                : item;
        localStorage.setItem(
            "playList",
            JSON.stringify(this._playList.slice(0, 500).map(slim)),
        );
        if (this._currentMusic) {
            localStorage.setItem("currentMusic", JSON.stringify(slim(this._currentMusic)));
        } else {
            localStorage.removeItem("currentMusic");
        }
    }

    getMusicIndexInPlayList(musicItem?: IMusic.IMusicItem | null) {
        if (!musicItem) {
            return -1;
        }
        return this._playList.findIndex(
            (it) => it.id === musicItem.id && it.platform === musicItem.platform,
        );
    }

    isInPlayList(musicItem?: IMusic.IMusicItem | null) {
        return this.getMusicIndexInPlayList(musicItem) >= 0;
    }

    isPlayListEmpty() {
        return this._playList.length === 0;
    }

    addAll(
        musicItems: IMusic.IMusicItem[],
        beforeIndex?: number,
        shouldShuffle?: boolean,
    ) {
        const valid = musicItems.filter((it) => it?.id && !it.localPath?.startsWith?.("tmp"));
        const list = [...this._playList];
        const insertAt = beforeIndex === undefined ? list.length : beforeIndex;
        if (shouldShuffle) {
            valid.sort(() => Math.random() - 0.5);
        }
        list.splice(insertAt, 0, ...valid);
        this._playList = list;
        setAtom(playListAtom, this._playList);
        this.persistPlayList();
    }

    add(musicItem: IMusic.IMusicItem | IMusic.IMusicItem[], beforeIndex?: number) {
        const items = Array.isArray(musicItem) ? musicItem : [musicItem];
        this.addAll(items, beforeIndex);
    }

    addNext(musicItem: IMusic.IMusicItem | IMusic.IMusicItem[]) {
        const items = Array.isArray(musicItem) ? musicItem : [musicItem];
        const currentIndex = this.getMusicIndexInPlayList(this._currentMusic);
        this.addAll(items, currentIndex + 1);
    }

    async remove(musicItem: IMusic.IMusicItem) {
        const index = this.getMusicIndexInPlayList(musicItem);
        if (index < 0) {
            return;
        }
        const removingCurrent = this.isCurrentMusic(musicItem);
        const list = [...this._playList];
        list.splice(index, 1);
        this._playList = list;
        setAtom(playListAtom, this._playList);
        this.persistPlayList();
        if (removingCurrent) {
            if (list.length === 0) {
                await this.clearPlayList();
            } else {
                await this.play(list[Math.min(index, list.length - 1)], true);
            }
        }
    }

    isCurrentMusic(musicItem?: IMusic.IMusicItem | null) {
        if (!musicItem || !this._currentMusic) {
            return false;
        }
        return (
            musicItem.id === this._currentMusic.id &&
            musicItem.platform === this._currentMusic.platform
        );
    }

    async clearPlayList() {
        this._playList = [];
        this._currentMusic = null;
        setAtom(playListAtom, []);
        setAtom(currentMusicAtom, null);
        setAtom(musicStateAtom, "stopped");
        setAtom(progressAtom, { position: 0, duration: 0 });
        this.audio?.pause();
        if (this.audio) {
            this.audio.removeAttribute("src");
        }
        this.persistPlayList();
    }

    /** ---------- 播放控制 ---------- */

    /** 解析可播放的 mfs 音源 */
    private async resolveMediaUrl(
        musicItem: IMusic.IMusicItem,
    ): Promise<{ src: string; source?: IPlugin.IMediaSourceResult } | null> {
        if (musicItem.localPath) {
            return { src: buildLocalMediaUrl(musicItem.localPath) };
        }
        const plugin = await getPluginByMedia(musicItem);
        if (plugin?.supportedMethods.includes("getMediaSource")) {
            for (const quality of [getQuality(), "standard"]) {
                try {
                    const source = (await pluginCall(
                        plugin.hash,
                        "getMediaSource",
                        musicItem,
                        quality,
                    )) as IPlugin.IMediaSourceResult | null;
                    if (source?.url) {
                        return {
                            src: buildRemoteMediaUrl({
                                url: source.url,
                                headers: source.headers,
                                userAgent: source.userAgent,
                            }),
                            source,
                        };
                    }
                    console.warn(`[trackPlayer] getMediaSource empty for ${quality}`);
                } catch (e: any) {
                    console.warn(
                        `[trackPlayer] getMediaSource failed (${quality}):`,
                        e?.message ?? e,
                    );                }
            }
        }
        if (musicItem.url) {
            return { src: buildRemoteMediaUrl({ url: musicItem.url }) };
        }
        return null;
    }

    private async setMediaSrc(musicItem: IMusic.IMusicItem) {
        const resolved = await this.resolveMediaUrl(musicItem);
        if (!resolved) {
            throw new Error("无法获取播放链接");
        }
        if (this.audio) {
            this.audio.src = resolved.src;
            this.audio.playbackRate = this._rate;
            await this.updateMediaSession(musicItem);
        }
    }

    private async updateMediaSession(musicItem: IMusic.IMusicItem) {
        // macOS 控制中心 / 触控栏
        if ("mediaSession" in navigator) {
            let artwork: string | undefined = musicItem.artwork;
            // 本地音乐的封面在列表里是 mfs://cover 短链，系统媒体面板取不到，
            // 这里只针对「正在播放的这一首」单独取一次 base64，不影响列表体积
            if (musicItem.localPath && artwork?.startsWith("mfs://cover/")) {
                try {
                    const cover = await ipcInvoke<string | null>(
                        "localMusic:readCover",
                        musicItem.localPath,
                    );
                    if (cover) {
                        artwork = cover;
                    }
                } catch {
                    // 取不到就用短链兜底
                }
            }
            // 超长的 data: URL 交给 MediaMetadata 只会被 Chromium 拒绝
            // （还在控制台打一条几 MB 的错误），不如直接不带封面
            if (artwork && artwork.length > MAX_PERSISTED_ARTWORK) {
                artwork = undefined;
            }
            navigator.mediaSession.metadata = new MediaMetadata({
                title: musicItem.title,
                artist: musicItem.artist,
                album: musicItem.album,
                artwork: artwork ? [{ src: artwork, sizes: "512x512" }] : [],
            });
            navigator.mediaSession.setActionHandler("play", () => this.resume());
            navigator.mediaSession.setActionHandler("pause", () => this.pause());
            navigator.mediaSession.setActionHandler("previoustrack", () =>
                this.skipToPrevious(),
            );
            navigator.mediaSession.setActionHandler("nexttrack", () => this.skipToNext());
        }
    }

    async play(musicItem?: IMusic.IMusicItem | null, forcePlay?: boolean) {
        if (!musicItem && !this._currentMusic) {
            return;
        }
        const target = musicItem ?? this._currentMusic!;
        const playId = `${target.platform}-${target.id}-${Date.now()}`;
        this.pendingPlayId = playId;

        const isNew = !this.isCurrentMusic(target);
        if (isNew) {
            if (!this.isInPlayList(target)) {
                this.add(target);
            }
            this._currentMusic = target;
            setAtom(currentMusicAtom, target);
            this.emit(TrackPlayerEvents.CurrentMusicChanged, target);
            setMusicHistory(target);
            this.persistPlayList();
            setAtom(progressAtom, { position: 0, duration: target.duration ?? 0 });
        }

        try {
            if (isNew || forcePlay) {
                await this.setMediaSrc(target);
            }
            await this.audio!.play();
            if (this.pendingPlayId === playId) {
                setAtom(musicStateAtom, "playing");
            }
        } catch (e) {
            console.warn("[trackPlayer] play failed", e);
            setAtom(musicStateAtom, "paused");
        }
    }

    private resume() {
        this.audio?.play();
    }

    async pause() {
        this.audio?.pause();
        setAtom(musicStateAtom, "paused");
    }

    async togglePlay() {
        if (!this._currentMusic) {
            if (this._playList.length) {
                await this.play(this._playList[0]);
            }
            return;
        }
        // 恢复的播放状态可能还没有设置音源，需要完整走一遍解析流程
        if (this.audio && !this.audio.src) {
            await this.play(this._currentMusic, true);
            return;
        }
        if (this.audio?.paused) {
            this.resume();
        } else {
            this.pause();
        }
    }

    private async getNextIndex(direction: 1 | -1): Promise<number> {
        const len = this._playList.length;
        if (!len) {
            return -1;
        }
        const curIndex = this.getMusicIndexInPlayList(this._currentMusic);
        if (this._repeatMode === "queue") {
            // 随机播放
            if (len === 1) {
                return curIndex;
            }
            let next = curIndex;
            while (next === curIndex) {
                next = Math.floor(Math.random() * len);
            }
            return next;
        }
        if (curIndex < 0) {
            return 0;
        }
        return (curIndex + direction + len) % len;
    }

    async skipToNext() {
        const nextIndex = await this.getNextIndex(1);
        if (nextIndex >= 0) {
            await this.play(this._playList[nextIndex], true);
        }
    }

    async skipToPrevious() {
        const nextIndex = await this.getNextIndex(-1);
        if (nextIndex >= 0) {
            await this.play(this._playList[nextIndex], true);
        }
    }

    async playWithReplacePlayList(
        musicItem: IMusic.IMusicItem,
        newPlayList: IMusic.IMusicItem[],
    ) {
        this._playList = [...newPlayList];
        setAtom(playListAtom, this._playList);
        await this.play(musicItem, true);
    }

    toggleRepeatMode() {
        const order: MusicRepeatMode[] = ["off", "queue", "single"];
        const next = order[(order.indexOf(this._repeatMode) + 1) % order.length];
        this._repeatMode = next;
        setAtom(repeatModeAtom, next);
        localStorage.setItem("repeatMode", next);
    }

    async seekTo(position: number) {
        if (this.audio && Number.isFinite(this.audio.duration)) {
            this.audio.currentTime = position;
            setAtom(progressAtom, {
                position,
                duration: this.audio.duration || 0,
            });
        }
    }

    async setRate(rate: number) {
        this._rate = rate;
        if (this.audio) {
            this.audio.playbackRate = rate;
        }
        setAtom(rateAtom, rate);
    }

    setVolume(volume: number) {
        if (this.audio) {
            this.audio.volume = Math.min(Math.max(volume, 0), 1);
            localStorage.setItem("volume", String(volume));
        }
    }

    getVolume() {
        return this.audio?.volume ?? 0.8;
    }

    getProgress() {
        if (this.audio) {
            return {
                position: this.audio.currentTime,
                duration: this.audio.duration || 0,
            };
        }
        return { position: 0, duration: 0 };
    }
}

export const TrackPlayerSingleton = new TrackPlayer();

/** ---------- hooks ---------- */
export function usePlayList() {
    return useAtomValue(playListAtom);
}
export function useCurrentMusic() {
    return useAtomValue(currentMusicAtom);
}
export function useMusicState() {
    return useAtomValue(musicStateAtom);
}
export function useRepeatMode() {
    return useAtomValue(repeatModeAtom);
}
export function useProgress() {
    return useAtomValue(progressAtom);
}
export function useCurrentLyric() {
    return useAtomValue(currentLyricAtom);
}

export const currentLyricAtom = atom<ILyric.IParsedLrc>([]);

/** 加载当前歌曲歌词 */
export async function loadCurrentLyric(musicItem: IMusic.IMusicItem) {
    let lyricSource: ILyric.ILyricSource | null = musicItem.lyric ?? null;
    if (!lyricSource && !musicItem.localPath) {
        const plugin = await getPluginByMedia(musicItem);
        if (plugin?.supportedMethods.includes("getLyric")) {
            try {
                lyricSource = await pluginCall(plugin.hash, "getLyric", musicItem);
            } catch {
                // ignore
            }
        }
    }
    let rawLrc = lyricSource?.rawLrc ?? "";
    if (!rawLrc && lyricSource?.lrc) {
        try {
            rawLrc = await (await fetch(lyricSource.lrc)).text();
        } catch {
            // ignore
        }
    }
    store.set(currentLyricAtom, rawLrc ? parseLrc(rawLrc) : []);
}

function parseLrc(rawLrc: string): ILyric.IParsedLrc {
    const result: ILyric.IParsedLrc = [];
    const lines = rawLrc.split("\n");
    const timeReg = /\[(\d+):(\d+)(?:[.:](\d+))?\]/g;
    lines.forEach((line) => {
        const text = line.replace(timeReg, "").trim();
        let match: RegExpExecArray | null;
        timeReg.lastIndex = 0;
        while ((match = timeReg.exec(line)) !== null) {
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const fraction = match[3] ? parseInt(match[3], 10) / Math.pow(10, match[3].length) : 0;
            const time = minutes * 60 + seconds + fraction;
            result.push({ time, lrc: text, index: result.length });
        }
    });
    result.sort((a, b) => a.time - b.time);
    return result;
}
