import { getConfig, setConfig } from "./appConfig";

/**
 * 「上次播放的歌曲 + 听到哪儿」。
 *
 * 只记**当前正在听的那一首**。重启后 `setup()` 把播放栏和进度条摆回退出前的样子
 * （**不自动出声**），用户按播放时再从那里接着听。
 *
 * 为什么只留一条而不是每首歌一条：需求就是「重启后回到上次的位置」。
 * 按歌留存会让「随手点开一首很久没听的歌」也从半截开始放，不符合直觉。
 *
 * ## 两份存储，各司其职
 *
 * | 位置 | 作用 |
 * | --- | --- |
 * | localStorage `playProgress` / `currentMusic` / `playList` | **首帧来源**。`setup()` 同步读，重启后进度条第一帧就在正确位置，不等 IPC 往返 |
 * | 主进程 `data/session.json`（`electron/services/sessionStore.ts`） | **兜底**。退出时由主进程主动来要一份最新进度；与 origin 无关 |
 *
 * 为什么要有第二份（localStorage 看着已经够了）：
 *
 * 1. **localStorage 按 origin 隔离，而 dev 实例（`http://localhost:5173`）与打包版（`file://`）
 *    不是同一个 origin**，两者却共用同一份 userData。开发时在 dev 里听歌、再用打包版打开，
 *    盘上那份进度「就是不在」，看着就是「重启后经常恢复不了」。
 * 2. localStorage 的写入是**异步提交**的（Chromium 侧有自己的 commit 时机），进程被强杀 /
 *    崩溃 / 系统收走时最后那次写可能没落盘。而会话文件是渲染进程回执后主进程**同步**写下去的。
 * 3. 只靠渲染进程自己写，主进程在退出前没法兜底：现在退出流程会等渲染进程回一次话
 *    （`session:flush` → 写盘 → `session:saved`），拿到的是「退出那一刻」的准确位置。
 *
 * 启动时两份都读，谁的 `updatedAt` 新用谁（见 `TrackPlayer.setup()`）。
 *
 * ## 落盘时机
 *
 * 播放中每 15 秒一次，由 **`timeupdate` 上的墙钟判断**驱动（不用定时器）：
 * 窗口在后台时 Chromium 会把定时器节流到 ~60 秒一次（实测过：用户真实数据里
 * 播放进度就是每 60 秒才落一次盘），而媒体事件不受节流影响。
 * 暂停 / 换歌 / 拖动 / 播完 / 切后台 / 关窗前一律立刻落盘。
 *
 * 记录里只有数字和歌曲身份，不含音频与封面（超大的内联封面会被丢掉），
 * 不会触发「内联 base64 撑爆存储」那条硬约束。
 */

export interface IPlayProgressRecord {
    /** 歌曲身份：平台 + id（绝不用 URL / localPath，直链带时效） */
    platform: string;
    id: string;
    /** 只为人肉排查时直读 localStorage，不参与任何判定 */
    title: string;
    /** 上次听到的位置（秒） */
    position: number;
    /** 当时的音频总时长（秒），0 表示未知 */
    duration: number;
    /** 最后更新时间 */
    updatedAt: number;
}

const STORAGE_KEY = "playProgress";
/** 播放中最多这么久落盘一次；暂停 / 换歌 / 退出应用时立即落盘 */
const FLUSH_INTERVAL = 15000;
/** 开头这几秒不值得记，避免「点开听两秒又换歌」把之前的好进度覆盖掉 */
export const MIN_REMEMBER_POSITION = 5;
/** 距结尾不足这么多秒视为已听完，下次从头播 */
const END_GAP = 5;
/**
 * 会话文件里内联封面的体积上限。播放列表落盘时也有同样的处理
 * （见 `TrackPlayer.persistPlayList`）：超过就是「整张图塞成 base64」，不该进任何持久化。
 */
const MAX_SESSION_ARTWORK = 64 * 1024;

export const REMEMBER_PROGRESS_KEY = "rememberProgress";

let record: IPlayProgressRecord | null = null;
/** 记录对应的**完整**歌曲条目（含 artist / duration / localPath），只给会话文件用 */
let fullMusic: IMusic.IMusicItem | null = null;
let loaded = false;
let dirty = false;
/** 上次落盘时间（墙钟，不是定时器） */
let lastFlushAt = 0;
let persistenceBound = false;

function keyOf(musicItem?: { platform?: string; id?: string } | null): string {
    if (!musicItem?.platform || !musicItem?.id) {
        return "";
    }
    return `${musicItem.platform}:${musicItem.id}`;
}

/** 落进会话文件的歌曲条目：丢掉超大的内联封面（列表落盘时同理） */
function slimMusic(musicItem: IMusic.IMusicItem): IMusic.IMusicItem {
    return typeof musicItem.artwork === "string" &&
        musicItem.artwork.length > MAX_SESSION_ARTWORK
        ? { ...musicItem, artwork: "" }
        : musicItem;
}

/**
 * 把 localStorage 里的值收成一条记录。
 * 早期版本是按「每首歌一条」的映射存的，这里取最近更新的那条、丢弃其余；
 * 完全不认识的旧结构一律当作没记过（下一次写入会整体覆盖掉）。
 */
function normalize(raw: any): IPlayProgressRecord | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return null;
    }
    const single = (item: any, platform?: string, id?: string): IPlayProgressRecord | null => {
        const position = Number(item?.position);
        if (!Number.isFinite(position)) {
            return null;
        }
        return {
            platform: platform ?? String(item.platform ?? ""),
            id: id ?? String(item.id ?? ""),
            title: typeof item.title === "string" ? item.title : "",
            position,
            duration: Number(item.duration) || 0,
            updatedAt: Number(item.updatedAt) || 0,
        };
    };

    if (typeof raw.platform === "string" && typeof raw.id === "string") {
        return single(raw);
    }
    const values = Object.values(raw);
    if (!values.length) {
        return null;
    }
    const newest = values.reduce((a: any, b: any) =>
        (Number(b?.updatedAt) || 0) > (Number(a?.updatedAt) || 0) ? b : a,
    ) as any;
    const key = Object.keys(raw).find((k) => raw[k] === newest) ?? "";
    const [platform, ...rest] = key.split(":");
    return single(newest, platform, rest.join(":"));
}

function read(): IPlayProgressRecord | null {
    if (!loaded) {
        loaded = true;
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            record = raw ? normalize(JSON.parse(raw)) : null;
        } catch {
            // 数据坏了就当没记过，不让它挡住播放
            record = null;
        }
    }
    return record;
}

function write(next: IPlayProgressRecord | null) {
    record = next;
    if (!next) {
        fullMusic = null;
    }
    loaded = true;
    dirty = true;
}

/** ---------- 会话文件（主进程 data/session.json） ---------- */

/** 把当前进度推给主进程落盘（主进程收到就同步写文件，所以 resolve 后数据一定在盘上） */
function pushSession(): Promise<void> {
    if (!record || !window.mfp?.invoke) {
        return Promise.resolve();
    }
    const payload = {
        music: fullMusic ?? {
            platform: record.platform,
            id: record.id,
            title: record.title,
        },
        position: record.position,
        duration: record.duration,
        musicUpdatedAt: record.updatedAt,
    };
    // 失败（主进程正忙 / 应用正在退出）不影响播放，只是这次没写进会话文件
    return Promise.resolve(window.mfp.invoke("session:save", payload)).then(
        () => undefined,
        () => undefined,
    );
}

/** 立即落盘（暂停、换歌、拖动、退出前调用） */
export function flushProgress(): Promise<void> {
    if (dirty) {
        dirty = false;
        try {
            if (record) {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
            } else {
                localStorage.removeItem(STORAGE_KEY);
            }
        } catch {
            // 写不进去（配额满）不影响播放，只是这次进度没记住；会话文件那份还在
        }
    }
    lastFlushAt = Date.now();
    return pushSession();
}

/**
 * 绑定「非正常时机」的落盘点。
 * 播放中的节流写会丢掉最后一小段，这里在窗口即将关闭 / 应用被切到后台时补齐；
 * 另外接住主进程在退出前发来的 `session:flush`（那时渲染进程还活着，能给出准确位置）。
 */
export function bindProgressPersistence() {
    if (persistenceBound) {
        return;
    }
    persistenceBound = true;
    window.addEventListener("beforeunload", flushProgress);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
            flushProgress();
        }
    });
    window.mfp?.onSessionFlush?.(async () => {
        // 主进程已经 preventDefault 挂起了退出流程，就等这一份。
        // 必须等写盘的 Promise resolve 再回执：回执一到主进程就会继续 quit，
        // 早回执 = 最后一段进度没落盘（这正是原来看起来「时灵时不灵」的地方）。
        await flushProgress();
        window.mfp?.notifySessionSaved?.();
    });
}

/** ---------- 设置项 ---------- */

/** 「记忆播放进度」：关掉后既不记也不续，已有记录保留（重新打开即可用） */
export function isRememberProgressEnabled(): boolean {
    return getConfig(REMEMBER_PROGRESS_KEY, true) !== false;
}

export function setRememberProgressEnabled(enabled: boolean) {
    setConfig(REMEMBER_PROGRESS_KEY, !!enabled);
    if (!enabled) {
        // 关掉开关就不该再往盘上写
        flushProgress();
    }
}

/** ---------- 读 / 写 ---------- */

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

/** 原始记录（不做任何有效性过滤），启动时用来和会话文件比新旧 */
export function getRawProgress(): IPlayProgressRecord | null {
    return read();
}

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

/** localStorage 里的当前歌曲（首帧来源），没有则 null */
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

/** 会话整体作废（清空播放列表 / 设置页「清除」） */
function resetSession() {
    record = null;
    fullMusic = null;
    loaded = true;
    dirty = false;
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // ignore
    }
    // 只清「歌曲 + 进度」，**不动会话文件里的播放队列**：设置页那个「清除」清的是进度记忆，
    // 队列还有没有是另一回事（清空播放列表时 persistPlayList 会自己把空队列写过去）
    invokeSilently("session:save", {
        music: null,
        position: 0,
        duration: 0,
        musicUpdatedAt: Date.now(),
    });
}

/**
 * 取这首歌可以续播的位置。
 * 返回 null 表示：没记过、记的是别的歌、位置太靠前、或上次已经听到结尾。
 */
export function getSavedProgress(
    musicItem?: { platform?: string; id?: string } | null,
): { position: number; duration: number } | null {
    if (!isRememberProgressEnabled()) {
        return null;
    }
    const key = keyOf(musicItem);
    const current = read();
    if (!key || !current || `${current.platform}:${current.id}` !== key) {
        return null;
    }
    const { position, duration } = current;
    if (!Number.isFinite(position) || position < MIN_REMEMBER_POSITION) {
        return null;
    }
    if (duration > 0 && position > duration - END_GAP) {
        return null;
    }
    return { position, duration };
}

/**
 * 记一次进度。
 * 播放中反复调用（timeupdate 频率）没问题：只改内存，落盘按墙钟节流
 * （用 `timeupdate` 当节拍而不是定时器：窗口在后台时定时器会被节流到 60 秒一次）。
 * `force` 用于用户主动拖动进度条 —— 此时即使落在开头也要覆盖旧记录。
 */
export function rememberProgress(
    musicItem: { platform?: string; id?: string; title?: string } | null | undefined,
    position: number,
    duration: number,
    force = false,
) {
    if (!isRememberProgressEnabled()) {
        return;
    }
    const key = keyOf(musicItem);
    if (!musicItem || !key || !Number.isFinite(position) || position < 0) {
        return;
    }
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;

    if (force && position <= 0) {
        // 用户把进度拖回开头 = 下次从头播
        write(null);
        flushProgress();
        return;
    }
    if (!force) {
        // 开头这几秒不记，也不清掉已有记录（换歌时 audio 会先归零并触发事件）
        if (position < MIN_REMEMBER_POSITION) {
            return;
        }
        // 已经听到结尾（或拖到结尾）：不再更新，读的时候（getSavedProgress）会当成「从头播」
        if (safeDuration > 0 && position > safeDuration - END_GAP) {
            return;
        }
    }
    write({
        platform: String(musicItem.platform),
        id: String(musicItem.id),
        title: typeof musicItem.title === "string" ? musicItem.title : "",
        position: Math.round(position * 10) / 10,
        duration: Math.round(safeDuration * 10) / 10,
        updatedAt: Date.now(),
    });
    fullMusic = slimMusic(musicItem as IMusic.IMusicItem);

    // 墙钟节流：到点了就顺手落一次盘（timeupdate 每次都会走到这里）
    if (Date.now() - lastFlushAt >= FLUSH_INTERVAL) {
        flushProgress();
    }
}

/**
 * 换歌：把记录整体切到新歌（位置 0）并立刻落盘。
 *
 * 两条理由：
 * - **进度记忆只保留「当前正在听的那一首」**，切歌就该丢掉上一首的（否则下次启动会跳回它的位置）。
 * - 「歌曲」和「进度」必须永远是一对：只删记录的话，从切歌到新歌播满 5 秒之间盘上是空的，
 *   这段窗口里退出应用，重启后会「有歌但没有任何进度」，看起来就是进度没恢复。
 */
export function markSessionSong(
    musicItem: IMusic.IMusicItem,
    duration?: number,
) {
    const key = keyOf(musicItem);
    if (!key) {
        return;
    }
    write({
        platform: String(musicItem.platform),
        id: String(musicItem.id),
        title: typeof musicItem.title === "string" ? musicItem.title : "",
        position: 0,
        duration: Number.isFinite(duration) && (duration ?? 0) > 0 ? (duration as number) : 0,
        updatedAt: Date.now(),
    });
    fullMusic = slimMusic(musicItem);
    flushProgress();
}

/**
 * 丢掉记录（内部会立刻落盘，调用方不用再 `flushProgress()`）。
 * - 传 `musicItem`：只在记录确实属于它时才丢（避免误删刚切过去那首的进度）
 * - 不传：无条件丢掉
 *
 * 注意「切歌」不走这里：切歌要的是**把记录切到新歌**（`markSessionSong`），
 * 而不是留下一段空窗（见该函数注释）。
 */
export function forgetProgress(musicItem?: { platform?: string; id?: string } | null) {
    const current = read();
    if (!current) {
        return;
    }
    const key = keyOf(musicItem);
    if (key && `${current.platform}:${current.id}` !== key) {
        return;
    }
    write(null);
    flushProgress();
}

/** 当前是否记得某一首的位置（设置页展示用） */
export function getRememberedProgress(): { title: string; position: number } | null {
    const current = read();
    if (!current || !Number.isFinite(current.position)) {
        return null;
    }
    // 刚切过来的那首是 0（`markSessionSong` 会把记录摆成新歌 + 位置 0），没记的必要
    if (current.position < MIN_REMEMBER_POSITION) {
        return null;
    }
    // 距结尾不足 END_GAP 的当成已听完：下次是从头播，显示一个「听到 4:29」反而是误报
    if (current.duration > 0 && current.position > current.duration - END_GAP) {
        return null;
    }
    return { title: current.title, position: current.position };
}

/** 设置页「清除已记忆的进度」/ 清空播放列表 */
export function clearAllProgress() {
    resetSession();
}
