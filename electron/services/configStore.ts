import fs from "fs";
import path from "path";

type Store = Record<string, any>;

/** 写入防抖窗口：这段时间内的多次 set 只会落盘一次 */
const FLUSH_DELAY = 400;

/**
 * 主进程持久化存储：userData/data/store.json
 * 提供 key-value 存取，供设置、歌单、历史等使用
 *
 * 写盘策略：set/remove 只改内存并标记「待写」，延迟合并后一次性落盘。
 * 老实现是每次 set 都同步 JSON.stringify + writeFileSync 整个 store：
 * 任何一次设置都等于重写全量数据，播放一首歌（写播放历史）就会同步写一遍大文件，
 * 主进程被卡住，音频自然跟着抖。
 */
class ConfigStore {
    private baseDir = "";
    private filePath = "";
    private store: Store = {};
    private flushTimer: NodeJS.Timeout | null = null;

    setup(baseDir: string) {
        this.baseDir = baseDir;
        this.filePath = path.join(baseDir, "store.json");
        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }
        try {
            if (fs.existsSync(this.filePath)) {
                this.store = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
            }
        } catch {
            this.store = {};
        }
    }

    /** 标记待写：合并短时间内的多次修改，只落盘一次 */
    private scheduleFlush() {
        if (this.flushTimer) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flushNow();
        }, FLUSH_DELAY);
        // 不因此阻止进程退出（退出前有 before-quit 兜底 flushNow）
        this.flushTimer.unref?.();
    }

    /**
     * 立即落盘。先写临时文件再 rename：rename 在同一文件系统内是原子的，
     * 避免写到一半崩溃/断电留下半个 JSON，下次启动直接解析失败丢全部数据。
     * 注意不缩进：这个文件纯机读，紧凑输出体积更小、stringify 也更快。
     */
    flushNow() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (!this.filePath) {
            return;
        }
        try {
            const tmpPath = `${this.filePath}.tmp`;
            fs.writeFileSync(tmpPath, JSON.stringify(this.store), "utf-8");
            fs.renameSync(tmpPath, this.filePath);
        } catch (e) {
            console.error("[configStore] flush failed", e);
        }
    }

    get(key: string, defaultValue?: any) {
        if (key in this.store) {
            return this.store[key];
        }
        return defaultValue;
    }

    set(key: string, value: any) {
        this.store[key] = value;
        this.scheduleFlush();
        return value;
    }

    remove(key: string) {
        delete this.store[key];
        this.scheduleFlush();
    }

    getAll(): Store {
        return this.store;
    }
}

export default new ConfigStore();
