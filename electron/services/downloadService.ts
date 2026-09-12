import fs from "fs";
import path from "path";
import axios from "axios";
import { shell } from "electron";
import configStoreInstance from "./configStore";
import pluginHost from "./pluginHost";

/**
 * 下载服务：
 *  - 下载队列（并发 2），音质可选
 *  - 进度事件推送给渲染进程
 *  - 任务记录持久化，重启后可在下载管理中查看/重试
 */

const CONCURRENCY = 2;

export type DownloadStatus = "pending" | "running" | "completed" | "failed";

export interface IDownloadTask {
    id: string;
    musicItem: {
        id: string;
        platform: string;
        title: string;
        artist: string;
        artwork?: string;
        duration?: number;
    };
    quality: string;
    status: DownloadStatus;
    progress: number; // 0-100
    filename: string;
    filePath?: string;
    error?: string;
    createdAt: number;
}

function sanitizeFilename(name: string) {
    return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
}

function extFromUrl(url: string, contentType?: string): string {
    const m = /\.(mp3|flac|m4a|wav|ogg|ape)(\?|$)/i.exec(url);
    if (m) {
        return m[1].toLowerCase();
    }
    const ct = (contentType ?? "").toLowerCase();
    if (ct.includes("flac")) return "flac";
    if (ct.includes("mp4") || ct.includes("m4a")) return "m4a";
    if (ct.includes("ogg")) return "ogg";
    if (ct.includes("wav")) return "wav";
    return "mp3";
}

class DownloadService {
    private tasks: IDownloadTask[] = [];
    private downloadDir = "";
    private configStore!: typeof configStoreInstance;
    private notify: (() => void) | null = null;
    private running = 0;
    private saveTimer: NodeJS.Timeout | null = null;
    private notifyTimer: NodeJS.Timeout | null = null;

    setup(downloadDir: string, configStore: typeof configStoreInstance, notify: () => void) {
        this.configStore = configStore;
        // 用户在设置中配置过下载目录则优先使用
        this.downloadDir = configStore.get("download.dir", downloadDir);
        this.notify = notify;
        if (!fs.existsSync(this.downloadDir)) {
            fs.mkdirSync(this.downloadDir, { recursive: true });
        }
        // 恢复历史任务：running/pending 重置为 failed（可重试）
        const saved: IDownloadTask[] = configStore.get("download.tasks", []);
        this.tasks = saved.map((t) =>
            t.status === "running" || t.status === "pending"
                ? { ...t, status: "failed" as const, error: "应用重启中断，可重试" }
                : t,
        );
    }

    private persist() {
        if (this.saveTimer) {
            return;
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            try {
                this.configStore.set("download.tasks", this.tasks);
            } catch {
                // ignore
            }
        }, 500);
    }

    private pushEvent() {
        if (this.notifyTimer) {
            return;
        }
        this.notifyTimer = setTimeout(() => {
            this.notifyTimer = null;
            this.notify?.();
        }, 300);
    }

    getSerializedTasks(): IDownloadTask[] {
        return this.tasks;
    }

    getDownloadDir() {
        return this.downloadDir;
    }

    /**
     * 仍在排队 / 下载中的任务 id。
     * 临时文件以 `<taskId>.part` 命名，缓存清理要跳过这些，
     * 否则会把正在写的文件删掉，下载直接失败。
     */
    getActiveTaskIds(): string[] {
        return this.tasks
            .filter((t) => t.status === "pending" || t.status === "running")
            .map((t) => t.id);
    }

    /** 更改默认下载目录（持久化，后续下载保存到新目录） */
    setDownloadDir(dir: string) {
        this.downloadDir = dir;
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.configStore.set("download.dir", dir);
    }

    /** 批量添加下载任务，返回新增数量 */
    addTasks(
        musicItems: Array<{
            id: string;
            platform: string;
            title: string;
            artist: string;
            artwork?: string;
            duration?: number;
            [k: string]: any;
        }>,
        quality: string,
    ): number {
        let added = 0;
        for (const item of musicItems) {
            const key = `${item.platform}-${item.id}`;
            const exists = this.tasks.some(
                (t) =>
                    t.musicItem.id === item.id &&
                    t.musicItem.platform === item.platform &&
                    (t.status === "completed" ||
                        t.status === "running" ||
                        t.status === "pending"),
            );
            if (exists) {
                continue;
            }
            this.tasks.unshift({
                id: `${key}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                // 保留完整媒体项：插件解析音源依赖 bvid/cid 等额外字段
                musicItem: { ...item },
                quality,
                status: "pending",
                progress: 0,
                filename: "",
                createdAt: Date.now(),
            });
            added++;
        }
        if (added) {
            this.persist();
            this.pushEvent();
            this.pump();
        }
        return added;
    }

    retryTask(taskId: string) {
        const task = this.tasks.find((t) => t.id === taskId);
        if (task && (task.status === "failed" || task.status === "completed")) {
            task.status = "pending";
            task.progress = 0;
            task.error = undefined;
            this.persist();
            this.pushEvent();
            this.pump();
        }
    }

    removeTask(taskId: string, deleteFile = false) {
        const idx = this.tasks.findIndex((t) => t.id === taskId);
        if (idx >= 0) {
            const task = this.tasks[idx];
            // 进行中的任务标记取消：running 状态时只把状态改成 failed 由 pump 跳过
            if (task.status === "running") {
                task.status = "failed";
                task.error = "已取消";
            }
            if (deleteFile && task.filePath) {
                try {
                    if (fs.existsSync(task.filePath)) {
                        fs.unlinkSync(task.filePath);
                    }
                } catch {
                    // 文件删除失败不阻塞记录移除
                }
            }
            this.tasks.splice(idx, 1);
            this.persist();
            this.pushEvent();
        }
    }

    clearCompleted() {
        this.tasks = this.tasks.filter((t) => t.status !== "completed");
        this.persist();
        this.pushEvent();
    }

    openInFolder(taskId: string) {
        const task = this.tasks.find((t) => t.id === taskId);
        if (task?.filePath && fs.existsSync(task.filePath)) {
            shell.showItemInFolder(task.filePath);
        }
    }

    private pump() {
        while (this.running < CONCURRENCY) {
            const next = this.tasks.find((t) => t.status === "pending");
            if (!next) {
                break;
            }
            next.status = "running";
            this.running++;
            this.runTask(next)
                .catch((e) => {
                    next.status = "failed";
                    next.error = e?.message ?? String(e);
                })
                .finally(() => {
                    this.running--;
                    this.persist();
                    this.pushEvent();
                    this.pump();
                });
        }
    }

    private async runTask(task: IDownloadTask) {
        const { musicItem, quality } = task;
        // 解析音源
        const source = await pluginHost.resolveMedia(musicItem, quality);
        if (!source?.url) {
            throw new Error("无法获取下载链接（该音质可能不可用）");
        }
        // 先拿文件头确定扩展名和大小
        const headers: Record<string, string> = {
            "User-Agent":
                source.userAgent ??
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            ...(source.headers ?? {}),
        };
        const tmpPath = path.join(this.downloadDir, `${task.id}.part`);
        const resp = await axios.get(source.url, {
            headers,
            responseType: "stream",
            timeout: 30000,
            maxRedirects: 5,
            validateStatus: () => true,
        });
        if (resp.status >= 400) {
            throw new Error(`下载源响应异常 (${resp.status})`);
        }
        const total = Number(resp.headers["content-length"] ?? 0) || 0;
        const ext = extFromUrl(source.url, resp.headers["content-type"] as string | undefined);
        const filename = sanitizeFilename(
            `${musicItem.artist} - ${musicItem.title} [${quality}].${ext}`,
        );
        task.filename = filename;
        const finalPath = path.join(this.downloadDir, filename);
        task.filePath = finalPath;

        await new Promise<void>((resolve, reject) => {
            const out = fs.createWriteStream(tmpPath);
            let received = 0;
            let lastNotify = 0;
            resp.data.on("data", (chunk: Buffer) => {
                received += chunk.length;
                if (total > 0) {
                    task.progress = Math.min(99, Math.round((received / total) * 100));
                    const now = Date.now();
                    if (now - lastNotify > 400) {
                        lastNotify = now;
                        this.pushEvent();
                    }
                }
            });
            resp.data.pipe(out);
            out.on("finish", () => resolve());
            out.on("error", reject);
            resp.data.on("error", reject);
        });
        if (fs.existsSync(finalPath)) {
            fs.unlinkSync(finalPath);
        }
        fs.renameSync(tmpPath, finalPath);
        task.status = "completed";
        task.progress = 100;
    }
}

export default new DownloadService();
