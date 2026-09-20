import fs from "fs";
import path from "path";

/**
 * 「上次播放会话」落盘：`userData/data/session.json`
 *
 * 存三样东西：正在听的那首歌的**完整条目**、听到哪儿、以及播放队列。
 * 重启时渲染进程先用它把播放栏和进度条摆回退出前的样子（见 `src/core/playProgress.ts`）。
 *
 * ## 为什么要在 localStorage 之外再存一份
 *
 * 渲染进程侧本来就把播放列表写进 localStorage 了，但 localStorage 有两个绕不过去的坑：
 *
 * 1. **它按 origin 隔离，而 dev 与打包版不是同一个 origin**：dev 实例是
 *    `http://localhost:5173`，打包版是 `file://`，两者却共用同一份 userData
 *    （见 DEVELOPMENT.md 4.3 关于目录名的说明）。开发时在 dev 里听歌、再用打包版启动，
 *    盘上那份进度「就是不在」——看着像功能时灵时不灵。
 * 2. **写入是异步提交的**（Chromium 侧有自己的 commit 时机），进程被强杀 / 崩溃 / 系统
 *    直接杀掉时，最后那次写可能没落盘。
 *
 * 播放进度的规则更干脆：**只在退出前记一次**（见 `src/core/playProgress.ts`）。
 * 所以退出时由主进程主动要一次（`session:flush` → 渲染进程回写 → `session:saved`），
 * 写进这个与 origin 无关的小文件；启动时渲染进程再通过 `session:getSync` 同步取回，
 * 第一帧就能把进度条摆到上次的位置。
 *
 * ## 为什么不塞进 configStore 的 store.json
 *
 * 那个文件里装着本地音乐索引、歌单、播放历史（已 170 KB 量级且会继续长），
 * 每次保存都同步重写一遍整份大文件会卡住主进程、音频跟着抖——
 * 正是 `configStore.ts` 注释里警告的那条路。这里只写几百字节到几 KB。
 */

/** 会话快照结构。渲染进程只传自己改动的那几个字段，主进程做浅合并。 */
export interface ISessionSnapshot {
    version: number;
    /** 正在播放的歌曲（完整 IMusicItem，含 localPath / artwork 短链，供重启后直接解析音源） */
    music: any | null;
    /** 上次听到的位置（秒） */
    position: number;
    /** 当时的音频总时长（秒），0 表示未知 */
    duration: number;
    /** 上面三个字段的更新时间，用于与 localStorage 那份比新旧 */
    musicUpdatedAt: number;
    /** 播放队列（兜底用；正常还是以 localStorage 的 playList 为准） */
    playList: any[] | null;
    playListUpdatedAt: number;
}

const VERSION = 1;

function emptySnapshot(): ISessionSnapshot {
    return {
        version: VERSION,
        music: null,
        position: 0,
        duration: 0,
        musicUpdatedAt: 0,
        playList: null,
        playListUpdatedAt: 0,
    };
}

class SessionStore {
    private filePath = "";
    private snapshot: ISessionSnapshot = emptySnapshot();

    setup(dataDir: string) {
        this.filePath = path.join(dataDir, "session.json");
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
                this.snapshot = { ...emptySnapshot(), ...raw, version: VERSION };
            }
        } catch (e) {
            // 文件坏了就当没有会话：这只是「回到上次播放」的锦上添花，不能挡住启动
            console.warn("[sessionStore] 读取失败，忽略历史会话", e);
            this.snapshot = emptySnapshot();
        }
    }

    getSnapshot(): ISessionSnapshot {
        return this.snapshot;
    }

    /**
     * 合并式写入并**立即同步落盘**。
     * 调用频率很低（播放进度只在退出前写一次，播放队列在队列变化时写），
     * 内容只有几百字节，同步写不会成为负担；换来的是「写下去就一定在盘上」。
     */
    save(partial: Partial<ISessionSnapshot>) {
        const next: ISessionSnapshot = { ...this.snapshot };
        for (const key of Object.keys(partial) as (keyof ISessionSnapshot)[]) {
            const value = partial[key];
            if (value !== undefined) {
                (next as any)[key] = value;
            }
        }
        next.version = VERSION;
        this.snapshot = next;
        this.flushNow();
        return next;
    }

    /**
     * 落盘。先写临时文件再 rename：rename 在同一文件系统内是原子的，
     * 避免写到一半被杀留下半个 JSON（下次启动解析失败 = 会话丢失）。
     */
    flushNow() {
        if (!this.filePath) {
            return;
        }
        try {
            const tmpPath = `${this.filePath}.tmp`;
            fs.writeFileSync(tmpPath, JSON.stringify(this.snapshot), "utf-8");
            fs.renameSync(tmpPath, this.filePath);
        } catch (e) {
            console.error("[sessionStore] 写盘失败", e);
        }
    }
}

export default new SessionStore();
