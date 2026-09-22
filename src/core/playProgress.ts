import { getConfig, setConfig } from "./appConfig";

/**
 * 「上次听到哪儿」——**只在退出应用前记一次**。
 *
 * 需求很直接：退出时听到哪儿，下次启动进度条就停在哪儿（不出声，等用户按播放）。
 * 所以整份记录只有一条，写入时机也只有一个 —— 退出前那一次握手。
 * 没有「播放中每 N 秒落一次盘」、没有「暂停 / 拖动 / 切后台顺手补一次」。
 *
 * ## 退出前那次握手
 *
 * 主进程在 `before-quit` / 窗口 `close` 时先 `preventDefault()` 挂起退出，发
 * `session:flush` 给渲染进程（`electron/main.ts` 的 requestSessionFlush）；这里收到后
 * 向播放器**现场**要一份「当前歌曲 + 位置」（`bindProgressPersistence` 传进来的收集器），
 * 写进主进程的 `data/session.json`（`session:save` 由主进程同步落盘），再回 `session:saved`，
 * 主进程才真正 quit。**回执必须在写盘之后发**，早一步就丢掉退出那一刻的位置。
 *
 * 位置不是从「上次落盘的记录」里读的，而是退出那一刻从 `<audio>` 上现取的，
 * 所以不存在「记录落后几秒」的问题，也就不需要播放中的周期性写入。
 *
 * ## 为什么放在主进程而不是 localStorage
 *
 * - localStorage 按 origin 隔离，dev（`http://localhost:5173`）与打包版（`file://`）
 *   不是同一个 origin，却共用同一份 userData；来回切就会出现「进度就是不在」。
 * - 退出这条路上主进程是同步 tmp + rename 写盘的，不依赖 Chromium 的异步提交。
 * - 启动时 preload 用 `sendSync` 同步取回（`window.mfp.initialSession`），第一帧就能
 *   把进度条摆到正确位置，不需要等 IPC 往返。
 *
 * ## 代价
 *
 * 只在退出时写，意味着崩溃 / 强制杀死进程时这次播放的进度不会被记住。
 * 这是「只在退出前保存」这个需求本身的取舍，不是实现上的遗漏。
 *
 * 播放队列是另一回事，仍在队列变化时写入（见 `saveSessionPlayList`）。
 */

/** 退出前由播放器现场提供的「当前歌曲 + 听到哪儿」 */
export interface IProgressSnapshot {
    music: IMusic.IMusicItem;
    position: number;
    duration: number;
}

export interface IPlayProgressRecord extends IProgressSnapshot {
    updatedAt: number;
}

/** 开头这几秒不值得记：避免「点开听两秒就退出」下次还从 2 秒开始 */
const MIN_REMEMBER_POSITION = 5;
/** 距结尾不足这么多秒视为已听完，下次从头播 */
const END_GAP = 5;
/**
 * 会话文件里内联封面的体积上限。播放列表落盘时也有同样的处理
 * （见 `TrackPlayer.persistPlayList`）：超过就是「整张图塞成 base64」，不该进任何持久化。
 */
const MAX_SESSION_ARTWORK = 64 * 1024;

export const REMEMBER_PROGRESS_KEY = "rememberProgress";

/** 收集器由播放器注册：退出时才知道当时在听哪首、听到哪儿 */
let collector: (() => IProgressSnapshot | null) | null = null;
/** 内存里的记录：启动时来自会话文件，之后每次写入更新（设置页展示用） */
let cached: IPlayProgressRecord | null = null;
let loaded = false;
let bound = false;

function keyOf(musicItem?: { platform?: string; id?: string } | null): string {
    if (!musicItem?.platform || !musicItem?.id) {
        return "";
    }
    return `${musicItem.platform}:${musicItem.id}`;
}

function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

/** 落进会话文件的歌曲条目：丢掉超大的内联封面（列表落盘时同理） */
function slimMusic(musicItem: IMusic.IMusicItem): IMusic.IMusicItem {
    return typeof musicItem.artwork === "string" &&
        musicItem.artwork.length > MAX_SESSION_ARTWORK
        ? { ...musicItem, artwork: "" }
        : musicItem;
}

/** ---------- 设置项 ---------- */

/** 「记忆播放进度」：关掉后既不记也不续，已有记录保留（重新打开即可用） */
export function isRememberProgressEnabled(): boolean {
    return getConfig(REMEMBER_PROGRESS_KEY, true) !== false;
}

export function setRememberProgressEnabled(enabled: boolean) {
    setConfig(REMEMBER_PROGRESS_KEY, !!enabled);
}

/** ---------- 会话文件（主进程 data/session.json） ---------- */

/** 启动时的会话文件快照（preload 在主进程那边同步读好的） */
export function getInitialSession(): IPlaySessionSnapshot | null {
    const snapshot = window.mfp?.initialSession ?? null;
    if (!snapshot || typeof snapshot !== "object") {
        return null;
    }
    const hasMusic = !!snapshot.music && typeof snapshot.music === "object";
    const hasPlayList = Array.isArray(snapshot.playList) && snapshot.playList.length > 0;
    if (!hasMusic && !hasPlayList) {
        return null;
    }
    return { ...snapshot, music: hasMusic ? snapshot.music : null };
}

/**
 * 启动时的还原数据：上次退出时在听的那首歌 + 听到哪儿。
 *
 * - 开关关掉时仍然还原歌曲，但位置归 0。
 * - 会话文件里没有歌（首次启动 / 文件损坏）时，退回 localStorage 的 `currentMusic`，
 *   只还原「上次在听哪首」，没有位置可言。
 * - 位置太靠前、或上次已经听到结尾，都当成「从头播」（position = 0）。
 */
export function getRestoredSession(): IProgressSnapshot | null {
    const snapshot = getInitialSession();
    const music = snapshot?.music ?? getStoredCurrentMusic();
    if (!music?.platform || !music?.id) {
        return null;
    }
    let position = 0;
    // 位置只对得上「会话文件里跟这首歌一起写下的那个」：换了歌的位置不能张冠李戴
    if (
        isRememberProgressEnabled() &&
        snapshot?.music &&
        keyOf(snapshot.music) === keyOf(music)
    ) {
        const raw = Number(snapshot.position);
        const duration = Number(snapshot.duration) || 0;
        if (
            Number.isFinite(raw) &&
            raw >= MIN_REMEMBER_POSITION &&
            !(duration > 0 && raw > duration - END_GAP)
        ) {
            position = raw;
        }
    }
    return {
        music,
        position,
        duration: Number(snapshot?.duration) || music.duration || 0,
    };
}

function readCached(): IPlayProgressRecord | null {
    if (!loaded) {
        loaded = true;
        const snapshot = getInitialSession();
        const music = snapshot?.music;
        const raw = Number(snapshot?.position);
        cached =
            music?.platform && music?.id && Number.isFinite(raw) && raw > 0
                ? {
                      music,
                      position: raw,
                      duration: Number(snapshot?.duration) || 0,
                      updatedAt: Number(snapshot?.musicUpdatedAt) || 0,
                  }
                : null;
    }
    return cached;
}

/**
 * 把「歌曲 + 位置」推给主进程落盘（主进程收到就同步写文件，所以 resolve 后数据一定在盘上）。
 * 传 null = 会话整体作废。
 */
function writeSession(snapshot: IProgressSnapshot | null): Promise<void> {
    const music = snapshot?.music;
    const next: IPlayProgressRecord | null =
        music?.platform && music?.id
            ? {
                  music: slimMusic(music),
                  position: Math.max(0, round1(Number(snapshot?.position) || 0)),
                  duration: Math.max(0, round1(Number(snapshot?.duration) || 0)),
                  updatedAt: Date.now(),
              }
            : null;
    cached = next;
    loaded = true;
    if (!window.mfp?.invoke) {
        return Promise.resolve();
    }
    const payload = next
        ? {
              music: next.music,
              position: next.position,
              duration: next.duration,
              musicUpdatedAt: next.updatedAt,
          }
        : { music: null, position: 0, duration: 0, musicUpdatedAt: Date.now() };
    // 失败（主进程正忙 / 应用正在退出）不影响播放，只是这次没写进会话文件
    return Promise.resolve(window.mfp.invoke("session:save", payload)).then(
        () => undefined,
        () => undefined,
    );
}

/**
 * 退出前的那一次保存 —— 全应用唯一一处写播放进度的地方。
 *
 * 播放器还没起来 / 当前没有歌时**什么都不写**：那种情况下「没有进度」是假象
 * （比如页面刚加载完就被关掉），写下去会把上次退出时记的好记录清掉。
 */
export function flushProgress(): Promise<void> {
    if (!isRememberProgressEnabled()) {
        return Promise.resolve();
    }
    const snapshot = collector?.() ?? null;
    if (!snapshot?.music?.platform || !snapshot.music.id) {
        return Promise.resolve();
    }
    return writeSession(snapshot);
}

/**
 * 绑定退出时的落盘点，并登记「向谁要当前进度」。
 *
 * 主进程已经 `preventDefault` 挂起了退出流程，就等这一份：必须等写盘的 Promise
 * resolve 之后再回执，回执一到主进程就会继续 quit。
 */
export function bindProgressPersistence(collect: () => IProgressSnapshot | null) {
    collector = collect;
    if (bound) {
        return;
    }
    bound = true;
    // 页面卸载（dev 热重载、窗口真正关闭）也等于「退出」，顺手补一次
    window.addEventListener("beforeunload", () => {
        void flushProgress();
    });
    window.mfp?.onSessionFlush?.(async () => {
        await flushProgress();
        window.mfp?.notifySessionSaved?.();
    });
}

/** ---------- 播放队列（与进度无关，队列变化时写） ---------- */

/** localStorage 里的播放队列（首帧来源），没有则 null */
export function getStoredPlayList(): IMusic.IMusicItem[] | null {
    try {
        const raw = localStorage.getItem("playList");
        if (!raw) {
            return null;
        }
        const list = JSON.parse(raw);
        return Array.isArray(list) ? list : null;
    } catch {
        return null;
    }
}

/** localStorage 里的当前歌曲（会话文件缺失时的兜底），没有则 null */
export function getStoredCurrentMusic(): IMusic.IMusicItem | null {
    try {
        const raw = localStorage.getItem("currentMusic");
        if (!raw) {
            return null;
        }
        const music = JSON.parse(raw);
        return music && typeof music === "object" ? music : null;
    } catch {
        return null;
    }
}

/** 发一条不关心结果的 IPC（主进程正忙 / 正在退出时失败也无所谓） */
function invokeSilently(channel: string, ...args: any[]) {
    try {
        Promise.resolve(window.mfp?.invoke?.(channel, ...args)).catch(() => undefined);
    } catch {
        // ignore
    }
}

/**
 * 播放队列落盘时同步给主进程一份（歌单是「用户资产」级别的东西，
 * 会话文件丢了它最多只影响「重启后能不能继续上一首的队列」，但顺手的事）。
 */
export function saveSessionPlayList(playList: IMusic.IMusicItem[]) {
    invokeSilently(
        "session:save",
        {
            playList: playList.slice(0, 500).map((item) => (item ? slimMusic(item) : item)),
            playListUpdatedAt: Date.now(),
        },
    );
}

/** ---------- 查询 / 清除 ---------- */

/** 当前是否记得某一首的位置（设置页展示用） */
export function getRememberedProgress(): { title: string; position: number } | null {
    const current = readCached();
    if (!current) {
        return null;
    }
    if (current.position < MIN_REMEMBER_POSITION) {
        return null;
    }
    // 距结尾不足 END_GAP 的当成已听完：下次是从头播，显示一个「听到 4:29」反而是误报
    if (current.duration > 0 && current.position > current.duration - END_GAP) {
        return null;
    }
    return { title: current.music?.title ?? "", position: current.position };
}

/** 设置页「清除已记忆的进度」/ `clearPlayListAndStop()`：只清歌曲与进度，不动播放队列 */
export function clearAllProgress() {
    return writeSession(null);
}
