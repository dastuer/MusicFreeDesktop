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
import {
    bindProgressPersistence,
    clearAllProgress,
    getInitialSession,
    getRestoredSession,
    getStoredPlayList,
    saveSessionPlayList,
} from "./playProgress";

export type MusicState = "playing" | "paused" | "stopped" | "loading";
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
    /** 音源解析 / 音频加载失败（payload 见 IPlayFailurePayload） */
    PlayFailed = "PlayFailed",
}

/** 播放失败事件的载荷 */
export interface IPlayFailurePayload {
    musicItem: IMusic.IMusicItem;
    /** 失败原因（已转成可读短句） */
    reason: string;
    /** 是否会自动跳到下一首 */
    willSkip: boolean;
}

/**
 * 单次 getMediaSource 的最长等待。
 * 换歌时旧歌已经被停掉，等待期是静音的，所以不能让一个卡死的音源拖满 pluginCall 的 30s。
 */
const MEDIA_SOURCE_TIMEOUT = 10000;

/** 连续 N 首都播不出来就停下，不再自动往后跳（否则坏音源会把整个歌单空转一圈） */
const MAX_AUTO_SKIP = 3;

/** 播放历史留多少首（上一首按它回退；再多也没人按那么回去） */
const MAX_HISTORY = 50;

/**
 * 队列里认一首歌用的键。与 `musicSheet` 的 `mediaKey`、`MusicList` 的 `musicKey` 同一约定，
 * 也与 `getMusicIndexInPlayList` 的匹配口径一致。
 */
function playListKey(musicItem: IMusic.IMusicItem) {
    return `${musicItem.platform}-${musicItem.id}`;
}

/** 能进播放队列吗：得有 id（去重和增删都按它认），tmp 路径的临时文件不算 */
function isQueueable(musicItem?: IMusic.IMusicItem | null) {
    return !!musicItem?.id && !musicItem.localPath?.startsWith?.("tmp");
}

/**
 * 把一份列表整理成能进播放队列的样子：没有 id 的丢掉（队列里靠 platform+id 定位，
 * 没 id 的歌既找不到下标也删不掉），同一首只留第一份。
 *
 * 追加和整队替换共用这一条，所以播放列表面板里永远不会有重复行。
 */
function toQueueableList(musicItems: IMusic.IMusicItem[]) {
    const seen = new Set<string>();
    return musicItems.filter((it) => {
        if (!isQueueable(it) || seen.has(playListKey(it))) {
            return false;
        }
        seen.add(playListKey(it));
        return true;
    });
}

/** MediaError 转成人话（见 HTMLMediaElement.error） */
function describeMediaError(err?: MediaError | null) {
    switch (err?.code) {
        case 1:
            return "音频加载被中断";
        case 2:
            return "音频流网络中断";
        case 3:
            return "音频解码失败";
        case 4:
            return "音源返回的音频无法播放（链接可能已失效）";
        default:
            return "音频加载失败";
    }
}

/** play() 抛出的异常转成人话 */
function describePlayError(e: any) {
    if (e?.name === "NotSupportedError") {
        return "音源返回的音频无法播放（链接可能已失效）";
    }
    if (e?.name === "NotAllowedError") {
        return "浏览器未允许自动播放";
    }
    if (e?.name === "AbortError") {
        return "播放被新的请求中断";
    }
    return e?.message ?? String(e ?? "未知原因");
}

/** ---------- jotai atoms ---------- */
/** 音量默认值：没存过、或存的不是数字时用 */
export const DEFAULT_VOLUME = 0.8;

/**
 * 读回存过的音量。setup() 与 volumeAtom 共用这一份，否则两边初值不一致，
 * 第一次按方向键就会把用户音量弹回默认值。
 */
function getStoredVolume(): number {
    const raw = localStorage.getItem("volume");
    if (raw === null) {
        return DEFAULT_VOLUME;
    }
    const stored = Number(raw);
    return Number.isFinite(stored) ? Math.min(Math.max(stored, 0), 1) : DEFAULT_VOLUME;
}

export const playListAtom = atom<IMusic.IMusicItem[]>([]);
export const currentMusicAtom = atom<IMusic.IMusicItem | null>(null);
export const musicStateAtom = atom<MusicState>("stopped");
export const repeatModeAtom = atom<MusicRepeatMode>("off");
export const progressAtom = atom<{ position: number; duration: number }>({
    position: 0,
    duration: 0,
});
export const rateAtom = atom<number>(1);
export const volumeAtom = atom<number>(getStoredVolume());
/**
 * 每次有歌进入播放队列自增（追加、整队替换都算）。
 * 播放条据此在歌单入口图标上弹一次「已添加到歌单列表」，不能只比对队列长度——
 * 把 200 首的队列换成 3 首的歌单，长度是减的，却同样是「歌进了播放列表」。
 */
export const playListAddedAtom = atom(0);

const store = getDefaultStore();

function setAtom<T>(atom_: any, value: T) {
    store.set(atom_, value);
}

/** ---------- 播放器 ---------- */

class TrackPlayer extends EventEmitter {
    private audio: HTMLAudioElement | null = null;
    private _repeatMode: MusicRepeatMode = "off";
    private _playList: IMusic.IMusicItem[] = [];
    /**
     * 当前队列是哪份列表装进来的（各列表页给的稳定标识，见 `playWithReplacePlayList`）。
     * 只有「从某份列表整队替换」会改写它，重启时跟着队列一起还原。
     * 往队列里追加 / 移除歌曲**不改**这个标识：那是「在这份列表的基础上动动手脚」，
     * 不是换了列表——所以在同一份列表里继续点歌，不该重新整队替换、也不该再提示一次。
     */
    private _currentListId = "";
    /**
     * 播过的歌，按播放顺序，最后一项就是当前这首。
     * 「上一首」按它回退而不是按队列下标——随机播放下标没有「前一首」，
     * 列表里直接点歌之后也想回到刚才听到的那首。
     */
    private _history: IMusic.IMusicItem[] = [];
    private _currentMusic: IMusic.IMusicItem | null = null;
    private _rate = 1;
    private pendingPlayId = "";
    /** 换歌时正在解析音源：期间播放器静音、状态为 loading */
    private isLoading = false;
    /** 因错误自动跳过的累计次数，真正播出声后归零 */
    private autoSkipCount = 0;
    /** 标记紧跟着的这次 play() 是错误自动跳引发的（此时不重置 autoSkipCount） */
    private autoSkipping = false;
    /** play() 调用序号，用于让过期（被后续请求取代）的解析结果失效 */
    private playSeq = 0;
    /** 播放停滞自救用的定时器与次数（见 onAudioStall） */
    private stallTimer: ReturnType<typeof setTimeout> | null = null;
    private stallNudges = 0;
    /** 摆进度时挂上去的一次性监听，换歌前必须摘掉（见 applyStartPosition） */
    private pendingSeekListener: (() => void) | null = null;
    /** 启动时还原出来的起播位置：挂上音源时用一次就作废（见 play / restoreSession） */
    private pendingStartPosition = 0;

    setup() {
        if (this.audio) {
            return;
        }
        // 退出前的落盘点：主进程来要进度时，由 collectSessionProgress 现场给一份
        bindProgressPersistence(() => this.collectSessionProgress());
        const audio = new Audio();
        audio.preload = "auto";
        audio.volume = getStoredVolume();
        audio.addEventListener("ended", this.onEnded);
        audio.addEventListener("timeupdate", this.onProgress);
        audio.addEventListener("loadedmetadata", this.onProgress);
        audio.addEventListener("pause", this.onAudioPause);
        audio.addEventListener("play", this.onAudioPlay);
        audio.addEventListener("playing", this.onAudioPlaying);
        audio.addEventListener("error", this.onAudioError);
        // waiting / stalled：音源侧断流时浏览器会一直等下去，进度不再前进
        audio.addEventListener("waiting", this.onAudioStall);
        audio.addEventListener("stalled", this.onAudioStall);
        this.audio = audio;

        // 恢复上次播放会话（播放列表 + 当前歌曲 + 进度），见 restoreSession
        this.restoreSession();
    }

    /**
     * 还原「上次播放会话」：上次退出时在听的那首歌 + 听到哪儿。
     *
     * 歌曲与进度只有一份来源 —— 主进程 `data/session.json`（`getRestoredSession()`），
     * 它是「退出前那一次」写下的：`sendSync` 同步取回，第一帧就能摆对；与 origin 无关，
     * 也不依赖 Chromium 的异步提交。播放队列另算，仍以 localStorage 的 `playList`
     * 为首帧来源（队列变化时才写，跟进度无关）。
     *
     * 只改状态与 atom，**不自动出声**（要不要接着听由用户按播放决定）。
     */
    private restoreSession() {
        try {
            const session = getInitialSession();
            const storedList = getStoredPlayList();
            const playList = storedList ?? session?.playList ?? null;
            if (playList?.length) {
                // 去重之前留下的旧队列（可能有重复行）在还原时一并整理掉
                this._playList = toQueueableList(playList);
                // 队列标识只认 localStorage 这份队列：退到会话文件那份时对不上号，宁可不认
                this._currentListId = storedList
                    ? localStorage.getItem("currentListId") ?? ""
                    : "";
                setAtom(playListAtom, this._playList);
                // 整理过（旧数据里有重复行或进不了队列的条目）就把这份写回 localStorage，
                // 否则下次启动读到的还是那盘带重复行的
                if (this._playList.length !== playList.length) {
                    localStorage.setItem("playList", JSON.stringify(this._playList));
                }
                // 顺手把队列同步回会话文件：那份只在「队列变化」时写，而它正是
                // 「localStorage 那份读不到（换了 origin / 被清）」时的唯一兜底
                saveSessionPlayList(this._playList);
            }

            const restored = getRestoredSession();
            if (restored) {
                this._currentMusic = restored.music;
                setAtom(currentMusicAtom, restored.music);
                if (restored.position > 0) {
                    // 进度条直接停在上次听到的位置：音源解析要时间，若先渲染 00:00 再跳回去，
                    // 会让人以为进度丢了。
                    setAtom(progressAtom, {
                        position: restored.position,
                        duration: restored.duration || restored.music.duration || 0,
                    });
                    // 记住它：用户按播放时（`togglePlay` → `play`）从这里起播
                    this.pendingStartPosition = restored.position;
                }
                console.log(
                    `[trackPlayer] 恢复上次播放：${restored.music.title ?? restored.music.id} @ ${formatSeconds(
                        restored.position,
                    )}`,
                );
            }

            const savedRepeat = localStorage.getItem("repeatMode");
            if (savedRepeat) {
                this._repeatMode = savedRepeat as MusicRepeatMode;
                setAtom(repeatModeAtom, this._repeatMode);
            }
        } catch (e) {
            // 恢复失败不影响使用，就当这次没有会话
            console.warn("[trackPlayer] 恢复上次播放失败", e);
        }
    }

    /**
     * 退出前那一哆嗦：现场给出「当前歌曲 + 听到哪儿」。
     *
     * 位置优先取 `<audio>.currentTime`（拖动、倍速、暂停都算得准）；还没挂上音源时
     * （重启后还没按播放、或正在换歌）就用进度条上摆着的那个位置 —— 那正是上次
     * 还原出来、或用户刚拖过去的地方。
     */
    private collectSessionProgress() {
        const music = this._currentMusic;
        if (!music?.platform || !music?.id) {
            return null;
        }
        const audio = this.audio;
        const hasSource = !!audio?.src;
        const progress = store.get(progressAtom);
        const audioDuration =
            hasSource && Number.isFinite(audio?.duration ?? NaN) ? (audio!.duration as number) : 0;
        return {
            music,
            position: hasSource ? audio!.currentTime || 0 : progress.position || 0,
            duration: audioDuration || progress.duration || music.duration || 0,
        };
    }

    /** ---------- 内部事件 ---------- */
    private onProgress = () => {
        if (!this.audio) {
            return;
        }
        // 进度还在走就说明没卡，撤掉停滞自救的定时器
        this.clearStallWatch();
        const progress = {
            position: this.audio.currentTime || 0,
            duration: this.audio.duration || 0,
        };
        setAtom(progressAtom, progress);
        this.emit(TrackPlayerEvents.ProgressChanged, progress);
        // 这里不落盘：进度只在**退出前**记一次（见 collectSessionProgress）。
        // 播放中反复写文件既没有必要，也会在音源解析 / 网络抖动的窗口里写出坏位置。
    };

    private clearStallWatch = () => {
        if (this.stallTimer) {
            clearTimeout(this.stallTimer);
            this.stallTimer = null;
        }
    };

    /**
     * 播放停滞自救。
     *
     * 音源/上游断流时，Chromium 会停在 waiting/stalled 一直等（甚至 paused 仍是 false），
     * 表现就是「播放到一半卡住」，而手动拖一下进度条就能恢复——因为那会重新发一次
     * Range 请求。这里把这个人工动作自动化：12 秒还没恢复就微调一点进度，
     * 强制浏览器重新取流。每首歌最多 3 次，避免对着彻底坏掉的音源空转。
     */
    private onAudioStall = () => {
        if (this.stallTimer) {
            return;
        }
        this.stallTimer = setTimeout(() => {
            this.stallTimer = null;
            const audio = this.audio;
            if (!audio || audio.paused || audio.ended) {
                return;
            }
            if (this.stallNudges >= 3) {
                return;
            }
            this.stallNudges += 1;
            console.warn(
                `[trackPlayer] 播放停滞超过 12s，自动微调进度重新取流（第 ${this.stallNudges} 次）`,
            );
            try {
                // +0.05s 听感上约等于原地，但足以让浏览器作废当前缓冲区、重新请求
                audio.currentTime = (audio.currentTime || 0) + 0.05;
            } catch {
                // ignore
            }
        }, 12000);
    };

    private onAudioPause = () => {
        this.clearStallWatch();
        // 换歌过程中的 pause 是加载流程的一部分，不能当成"用户按了暂停"
        if (this.isLoading) {
            return;
        }
        if (this._currentMusic) {
            setAtom(musicStateAtom, "paused");
        }
    };

    private onAudioPlay = () => {
        setAtom(musicStateAtom, "playing");
    };

    private onAudioPlaying = () => {
        // 真正出声了：撤掉停滞自救的定时器，并清零"连续失败自动跳过"的计数
        this.clearStallWatch();
        this.isLoading = false;
        this.autoSkipCount = 0;
        setAtom(musicStateAtom, "playing");
    };

    private onAudioError = async () => {
        const err = this.audio?.error;
        console.warn(
            `[trackPlayer] media error code=${err?.code} message=${err?.message} srcLen=${this.audio?.src?.length ?? 0} srcPrefix=${this.audio?.src?.slice(0, 40) ?? "-"}`,
        );
        // 没有 src 说明这是上一首被换掉时留下的错误，不该算到当前这首头上
        if (!this._currentMusic || !this.audio?.src) {
            return;
        }
        await this.handlePlayFailure(this._currentMusic, describeMediaError(err));
    };

    /**
     * 断掉当前音源并静音。
     *
     * 换歌、以及播放失败时都必须走这一步：只改 jotai 状态是没用的，
     * `<audio>` 元素会继续把已经缓冲的上一首播完——这就是「切歌后还在播上一首」的根因。
     */
    private detachAudio() {
        this.clearStallWatch();
        this.clearPendingSeek();
        const audio = this.audio;
        if (!audio) {
            return;
        }
        audio.pause();
        audio.removeAttribute("src");
        try {
            // 只 removeAttribute 时，已缓冲的数据在部分情况下仍会继续出声，load() 让元素真正放弃旧资源
            audio.load();
        } catch {
            // ignore
        }
    }

    /** 摘掉「等元数据到位再摆进度」的监听，避免它落到下一首歌头上 */
    private clearPendingSeek() {
        if (this.pendingSeekListener) {
            this.audio?.removeEventListener("loadedmetadata", this.pendingSeekListener);
            this.pendingSeekListener = null;
        }
    }

    /**
     * 把播放位置摆到上次听到的地方（记忆播放进度 / 重启续播都走这里）。
     *
     * 关键点：要在 `<audio>` 还没拿到元数据（readyState = HAVE_NOTHING）时设置。
     * 规范要求此时把它记成「默认起播位置」，元数据到达后浏览器直接按这个偏移
     * 发起 Range 请求 —— 不会先老老实实从 0 下载到目标位置再跳过去（那样续播
     * 反而比从头播还慢）。若元数据已经就绪，则这次赋值立刻生效。
     */
    private applyStartPosition(audio: HTMLAudioElement, position: number) {
        if (!(position > 0) || !Number.isFinite(position)) {
            return;
        }
        this.clearPendingSeek();
        const seek = () => {
            try {
                audio.currentTime = position;
            } catch {
                // ignore
            }
        };
        seek();
        if (audio.readyState >= 1) {
            // HAVE_METADATA：上面那次已经落到位
            return;
        }
        // 兜底：个别音源/容器不认「默认起播位置」，元数据到位后再摆一次
        const listener = () => {
            this.pendingSeekListener = null;
            if (Math.abs((audio.currentTime || 0) - position) > 2) {
                seek();
            }
        };
        this.pendingSeekListener = listener;
        audio.addEventListener("loadedmetadata", listener, { once: true });
    }

    /** 进入"解析音源中"：立刻静音旧歌，状态置为 loading */
    private beginLoading() {
        this.isLoading = true;
        this.detachAudio();
        if (this._currentMusic) {
            setAtom(musicStateAtom, "loading");
        }
    }

    /** 取消在途的加载（用户按暂停，或被一次新的换歌请求取代） */
    private cancelLoading() {
        this.pendingPlayId = "";
        this.isLoading = false;
        this.detachAudio();
        setAtom(musicStateAtom, this._currentMusic ? "paused" : "stopped");
    }

    /** 播放失败：先真正停下来，再看要不要自动往后跳一首 */
    private async handlePlayFailure(musicItem: IMusic.IMusicItem, rawReason: string) {
        const reason = rawReason || "未知原因";
        this.isLoading = false;
        this.detachAudio();

        const willSkip = this.autoSkipCount < MAX_AUTO_SKIP && this._playList.length > 1;
        console.warn(
            `[trackPlayer] 播放失败：${musicItem.title}（${reason}）${
                willSkip ? `，自动尝试下一首（第 ${this.autoSkipCount + 1} 次）` : "，停止播放"
            }`,
        );
        this.emit(TrackPlayerEvents.PlayFailed, {
            musicItem,
            reason,
            willSkip,
        } as IPlayFailurePayload);

        if (!willSkip) {
            setAtom(musicStateAtom, this._currentMusic ? "paused" : "stopped");
            return;
        }
        this.autoSkipCount += 1;
        this.autoSkipping = true;
        try {
            await this.skipToNext();
        } finally {
            this.autoSkipping = false;
        }
    }

    private onEnded = async () => {
        if (!this._currentMusic) {
            return;
        }
        // 自然播完：这里不用管进度记录。它只在退出前写一次，那时读到的是
        //「当前歌曲 + 当前位置」——播完又没跳下一首时位置就在结尾，重启会当成「从头播」；
        // 跳了下一首则记录的是下一首。刻意不做「播完就清记录」这类动作。
        if (this._repeatMode === "single") {
            const audio = this.audio;
            if (!audio) {
                return;
            }
            if (!audio.src) {
                // 单曲循环但音源已失效（失败后 src 被清掉）：重新走一次解析
                await this.play(this._currentMusic, true);
                return;
            }
            audio.currentTime = 0;
            audio.play().catch((e) =>
                console.warn("[trackPlayer] repeat-single failed", e?.name ?? e),
            );
            return;
        }
        // 队列空了、只剩这一首"孤儿"还在听（清空过播放列表）：播完就到头了，
        // 别再往下跳（skipToNext 无处可跳，只会把状态停在 paused 让人以为卡住了）。
        if (this._playList.length === 0) {
            this.emit(TrackPlayerEvents.PlayEnd);
            setAtom(musicStateAtom, "stopped");
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
        // 队列的来历跟着队列一起存：重启后在这份列表里点歌，不该再来一次整队替换和提示
        if (this._currentListId) {
            localStorage.setItem("currentListId", this._currentListId);
        } else {
            localStorage.removeItem("currentListId");
        }
        if (this._currentMusic) {
            localStorage.setItem("currentMusic", JSON.stringify(slim(this._currentMusic)));
        } else {
            localStorage.removeItem("currentMusic");
        }
        // 顺手给主进程的会话文件也留一份队列（localStorage 那份才是首帧来源，这份是兜底）
        saveSessionPlayList(this._playList);
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

    /** 有歌进了队列：只用来通知播放条弹提示，不参与任何播放逻辑 */
    private notifyPlayListAdded() {
        setAtom(playListAddedAtom, store.get(playListAddedAtom) + 1);
    }

    /**
     * 追加到播放队列。**已经在队列里的歌不会再塞一份**（按 platform+id 认），
     * 同一批里重复的也只留第一份——否则播放列表面板里会出现两行同名歌、两行都标着正在播放。
     *
     * @returns 真正进队列的条数（调用方据此给准确反馈，别说「已添加 3 首」结果只进了 1 首）
     */
    addAll(
        musicItems: IMusic.IMusicItem[],
        beforeIndex?: number,
        shouldShuffle?: boolean,
    ): number {
        const inQueue = new Set(this._playList.map(playListKey));
        const valid = toQueueableList(musicItems).filter(
            (it) => !inQueue.has(playListKey(it)),
        );
        const list = [...this._playList];
        const insertAt = beforeIndex === undefined ? list.length : beforeIndex;
        if (shouldShuffle) {
            valid.sort(() => Math.random() - 0.5);
        }
        list.splice(insertAt, 0, ...valid);
        this._playList = list;
        setAtom(playListAtom, this._playList);
        if (valid.length) {
            this.notifyPlayListAdded();
        }
        this.persistPlayList();
        return valid.length;
    }

    add(musicItem: IMusic.IMusicItem | IMusic.IMusicItem[], beforeIndex?: number) {
        const items = Array.isArray(musicItem) ? musicItem : [musicItem];
        return this.addAll(items, beforeIndex);
    }

    /**
     * 插到当前这首之后。已经在队列里的歌是**挪过来**而不是再塞一份：
     * 「下一首播放」点了之后没反应，比多出一行重复更糟。
     */
    addNext(musicItem: IMusic.IMusicItem | IMusic.IMusicItem[]) {
        const items = Array.isArray(musicItem) ? musicItem : [musicItem];
        const keys = new Set(items.filter(isQueueable).map(playListKey));
        if (keys.size) {
            this._playList = this._playList.filter((it) => !keys.has(playListKey(it)));
        }
        const currentIndex = this.getMusicIndexInPlayList(this._currentMusic);
        return this.addAll(items, currentIndex + 1);
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
        // 历史原样留着：删的是队列里的成员，不是「刚才听过它」这件事。
        // 一起删掉的话，上一首会退到队列下标上，从被删那首的位置跳去别处。
        if (removingCurrent) {
            if (list.length === 0) {
                // 移除的就是正在播这首：没有"下一首"可跳，只能整个停下
                await this.clearPlayListAndStop();
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

    /**
     * 清空播放队列，**正在播的这首继续播**。
     *
     * 队列空了以后 `_currentMusic` 是个不在队列里的"孤儿"，几处下游都靠
     * `getMusicIndexInPlayList` 返回 -1 来兜底：`addNext` 插到队首、`getNextIndex`
     * 从第一首开始、`play` 新歌时会自动重新入列。
     * 在途的音源解析不能作废（`pendingPlayId`）——那正是当前这首歌；
     * 进度记忆同样留着，它还要继续播，退出时该记住听到哪儿。
     */
    clearPlayList() {
        this._playList = [];
        setAtom(playListAtom, []);
        this.persistPlayList();
        // 历史留着：清掉的是队列，不是「听过」。当前这首还在播，它前面那几首
        // 照样是「刚才播过的」，按上一首要能回去（回去时不塞回空队列，见 skipToPrevious）。
    }

    /** 清空队列并且彻底停下：连当前这首歌也不要了（移除最后一首、删除正在播放的本地文件） */
    async clearPlayListAndStop() {
        this._currentMusic = null;
        // 任何在途的加载都要作废，否则停下后它还会把解析结果挂上来
        this.pendingPlayId = "";
        this.isLoading = false;
        this.autoSkipCount = 0;
        setAtom(currentMusicAtom, null);
        setAtom(musicStateAtom, "stopped");
        setAtom(progressAtom, { position: 0, duration: 0 });
        this.detachAudio();
        this.clearPlayList();
        // 停下 + 队列清空 = 这一段收听整个作废，历史再留着就只有一个不在任何队列里的幽灵
        this._history = [];
        // 歌都不要了：进度记忆和会话文件一起作废，别留一段没落盘的进度
        clearAllProgress();
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
                    // 等待期间旧歌已经被停掉（静音中），所以这里给单次调用加个更紧的超时，
                    // 免得一个卡死的音源让播放器一直静音等满 30s（甚至两个音质 60s）
                    const source = (await Promise.race([
                        pluginCall(
                            plugin.hash,
                            "getMediaSource",
                            musicItem,
                            quality,
                        ) as Promise<IPlugin.IMediaSourceResult | null>,
                        new Promise<never>((_, reject) =>
                            setTimeout(
                                () => reject(new Error("音源响应超时")),
                                MEDIA_SOURCE_TIMEOUT,
                            ),
                        ),
                    ])) as IPlugin.IMediaSourceResult | null;
                    if (source?.url) {
                        return {
                            src: buildRemoteMediaUrl({
                                url: source.url,
                                headers: source.headers,
                                userAgent: source.userAgent,
                                // 缓存键用歌曲身份而非直链：直链可能带时效参数，下次就换了
                                cacheKey: {
                                    platform: musicItem.platform,
                                    id: musicItem.id,
                                    quality,
                                },
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
            return {
                src: buildRemoteMediaUrl({
                    url: musicItem.url,
                    cacheKey: {
                        platform: musicItem.platform,
                        id: musicItem.id,
                        quality: "",
                    },
                }),
            };
        }
        return null;
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

    /**
     * @param addToPlayList 不在队列里的歌要不要顺手插进队列（默认插）。
     *   上一首回到一首已被移出队列的歌时传 false：歌照常放出来，但别复活在队列末尾。
     */
    async play(
        musicItem?: IMusic.IMusicItem | null,
        forcePlay?: boolean,
        addToPlayList = true,
    ) {
        if (!musicItem && !this._currentMusic) {
            return;
        }
        const target = musicItem ?? this._currentMusic!;
        // playId 带自增序号：同一毫秒内的连续调用也能区分
        const playId = `${target.platform}-${target.id}-${Date.now()}-${++this.playSeq}`;
        this.pendingPlayId = playId;

        const isNew = !this.isCurrentMusic(target);
        const willLoad = isNew || !!forcePlay;
        /**
         * 起播位置 = 启动时还原出来的那个位置（其余情况都是 0）。
         * 那条记录只在退出前写过一次，所以「重启后按播放接着听」走的正是这里；
         * 用掉即作废（见下面 applyStartPosition），之后暂停再播不会重复跳回去。
         */
        const resumePosition = this.isCurrentMusic(target) ? this.pendingStartPosition : 0;

        if (!this.autoSkipping) {
            // 用户主动发起的播放：把"连续失败"的计数清零
            this.autoSkipCount = 0;
        }

        if (isNew) {
            this.stallNudges = 0;
            if (addToPlayList && !this.isInPlayList(target)) {
                this.add(target);
            }
            this._currentMusic = target;
            this.pushHistory(target);
            setAtom(currentMusicAtom, target);
            this.emit(TrackPlayerEvents.CurrentMusicChanged, target);
            setMusicHistory(target);
            this.persistPlayList();
            // 进度条先摆到续播位置，别先显示 00:00 再跳回去
            setAtom(progressAtom, { position: resumePosition, duration: target.duration ?? 0 });
        }

        if (willLoad) {
            // 关键：解析音源可能耗时很久，这一步就把上一首停掉。
            // 否则「点下一首 → 旧歌继续响到新歌就绪」，或者解析失败后旧歌永远响下去。
            this.beginLoading();
        }

        try {
            const resolved = await this.resolveMediaUrl(target);
            if (this.pendingPlayId !== playId) {
                // 已经被后面的播放请求取代（连点下一首、快速点列表），丢弃这次结果
                return;
            }
            if (!resolved) {
                throw new Error("音源没有返回可播放的链接");
            }
            const audio = this.audio;
            if (!audio) {
                return;
            }
            audio.src = resolved.src;
            audio.playbackRate = this._rate;
            // 紧接着 src 赋值就摆进度：此时还处于 HAVE_NOTHING，浏览器会把它当成
            // 「默认起播位置」，元数据一到就按这个偏移取流（见 applyStartPosition）
            this.applyStartPosition(audio, resumePosition);
            // 起播位置已经摆进 audio：再用一次就是「暂停后重新解析」时又跳回那个位置
            this.pendingStartPosition = 0;
            await this.updateMediaSession(target);
            if (this.pendingPlayId !== playId) {
                return;
            }
            this.isLoading = false;
            await audio.play();
            if (this.pendingPlayId === playId) {
                setAtom(musicStateAtom, "playing");
            }
        } catch (e: any) {
            if (this.pendingPlayId !== playId) {
                // 失败来自一次已被取代的请求，不该弹提示、也不该自动跳歌
                return;
            }
            await this.handlePlayFailure(target, describePlayError(e));
        }
    }

    private resume() {
        const audio = this.audio;
        if (!audio) {
            return;
        }
        if (!audio.src) {
            // 失败后 / 恢复的会话没有音源：不能直接 play()，要走完整的解析流程
            if (this._currentMusic) {
                this.play(this._currentMusic, true);
            }
            return;
        }
        audio.play().catch((e) => {
            console.warn("[trackPlayer] resume failed", e?.name ?? e);
        });
    }

    async pause() {
        if (this.isLoading) {
            // 加载途中按暂停 = 取消这次加载，否则解析完成后它还会自己响起来
            this.cancelLoading();
            return;
        }
        this.audio?.pause();
        setAtom(musicStateAtom, "paused");
    }

    async togglePlay() {
        if (this.isLoading) {
            // 正在换歌/加载：再点一次即取消这次加载
            this.cancelLoading();
            return;
        }
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

    /**
     * 记一笔播放历史。同一首连续出现只算一条：从历史里回到它、
     * 或者失败后重播同一首时，否则会留下一格空历史，按一次上一首没反应。
     */
    private pushHistory(musicItem: IMusic.IMusicItem) {
        const last = this._history[this._history.length - 1];
        if (last && last.id === musicItem.id && last.platform === musicItem.platform) {
            return;
        }
        this._history.push(musicItem);
        if (this._history.length > MAX_HISTORY) {
            this._history = this._history.slice(-MAX_HISTORY);
        }
    }

    /**
     * 取出「刚才播的那首」，并把当前这首从历史里退场。
     *
     * 退场是为了让连按上一首一路往回走（C → B → A），而不是在两首之间来回弹：
     * 不退场的话回到 B 之后，历史末尾又变成 B 前面那个 C。
     * 历史末尾不是当前歌曲时（重启后只有还原的当前歌曲）不退，交给队列下标兜底。
     */
    private takePreviousFromHistory() {
        const prev = this._history[this._history.length - 2];
        if (!prev) {
            return null;
        }
        if (this.isCurrentMusic(this._history[this._history.length - 1])) {
            this._history.pop();
        }
        return prev;
    }

    async skipToPrevious() {
        const prev = this.takePreviousFromHistory();
        if (prev) {
            // prev 可能已经不在队列里（被删过、或这之后换过队列）：照样播它，但不塞回队列
            await this.play(prev, true, this.isInPlayList(prev));
            return;
        }
        // 没有历史（刚启动、或已经退到这段收听的第一首）：退回队列里的前一首
        if (!this.isInPlayList(this._currentMusic)) {
            // 当前这首本来就不在队列里（刚由历史回到一首被移出队列的歌）：
            // 队列下标对它没有意义，按位置兜底会凭空跳到队列第一首，不如就地停住。
            return;
        }
        const nextIndex = await this.getNextIndex(-1);
        if (nextIndex >= 0) {
            await this.play(this._playList[nextIndex], true);
        }
    }

    /**
     * 「播放全部」从哪一首开始：随机播放模式（`repeatMode === "queue"`）下随机挑一首，
     * 否则就是列表第一首。
     *
     * 只决定**第一首**，队列顺序原样保留；后续切歌在随机模式下本来就走 `getNextIndex`
     * 的随机分支，这里再把整份队列打乱一遍反而重复。
     */
    pickPlayAllStart(list: IMusic.IMusicItem[]) {
        if (this._repeatMode !== "queue" || list.length < 2) {
            return list[0];
        }
        return list[Math.floor(Math.random() * list.length)];
    }

    /**
     * 整队替换并从这首开始播。
     *
     * @param listId 这份列表的稳定标识（由各列表页给出，见 `MusicList` 的 `listId`）。
     *   队列已经是这份列表时——同一标识、且要播的这首就在队列里——直接切歌：
     *   不重写队列（省掉整张列表跟着重渲染），也不弹「已添加到歌单列表」。
     *   中途往队列里追加 / 移除过歌曲也算「已经是这份列表」，标识只认来源不认内容。
     * @param forceReplace 「播放全部」这类明确指令传 true：即使队列已经是这份列表
     *   也重新铺一遍，把中途手动加进来的歌清掉。列表里点歌不传，走上面的复用判断。
     */
    async playWithReplacePlayList(
        musicItem: IMusic.IMusicItem,
        newPlayList: IMusic.IMusicItem[],
        listId = "",
        forceReplace = false,
    ) {
        const alreadyThisList =
            !forceReplace &&
            !!listId &&
            this._currentListId === listId &&
            this.isInPlayList(musicItem);
        if (!alreadyThisList) {
            this._playList = toQueueableList(newPlayList);
            this._currentListId = listId;
            setAtom(playListAtom, this._playList);
            // 历史不动：换了队列不等于「刚才没播过上一份的最后一首」。
            // 新队列里的这一首会由 play() 记进历史。
            this.notifyPlayListAdded();
            // 这里必须自己落盘一次：队列已经变了，但接着的 play() 在「点的就是当前这首」
            // 时走 isNew=false 分支、不会 persist，那份旧队列就会在重启后还魂。
            this.persistPlayList();
        }
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
            return;
        }
        // 重启后还没开始播、音源也没加载：先把进度记下来，起播时会接着这里
        // （否则用户看到进度条停在 1:23 却拖不动，拖了也没人理）。
        // 同样是「只记一次」：退出前 collectSessionProgress 会原样带上这个位置。
        if (this._currentMusic) {
            this.pendingStartPosition = position;
            setAtom(progressAtom, { position, duration: this._currentMusic.duration || 0 });
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
        const next = Math.min(Math.max(volume, 0), 1);
        if (this.audio) {
            this.audio.volume = next;
        }
        localStorage.setItem("volume", String(next));
        setAtom(volumeAtom, next);
    }

    getVolume() {
        return this.audio?.volume ?? getStoredVolume();
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

function formatSeconds(position: number) {
    const total = Math.max(0, Math.floor(position));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
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
export function useVolume() {
    return useAtomValue(volumeAtom);
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
