import fs from "fs";
import path from "path";
import axios from "axios";
import { shell } from "electron";
import configStoreInstance from "./configStore";
import pluginHost from "./pluginHost";
import { fetchArtworkBytes } from "./localLyrics";
import { writeTags } from "./tagWriter";
import type { IAudioTags } from "./tagWriter";

/**
 * 下载服务：
 *  - 下载队列（并发 2），音质可选
 *  - 进度事件推送给渲染进程
 *  - 任务记录持久化，重启后可在下载管理中查看/重试
 *  - 下载完成后写标签：标题/歌手/专辑/年份 + 内嵌封面 + 歌词（USLT/LYRICS）。
 *    标签只覆盖 mp3/flac（tagWriter 手写格式）；其他格式与「写失败」退回同名 .lrc 边车。
 *    标签内容先下载文件、再解析歌词/封面（尽力而为，任何一步失败都不影响下载本身完成）。
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
    /** 下载完成后标签写入成功（mp3/flac 内嵌）；false/缺省 = 没写或写了 .lrc 边车 */
    tagsWritten?: boolean;
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
    /**
     * 在途下载的中止器：removeTask 取消 running 任务时用它掐断 axios 流。
     * 没有这一步的话「取消」只是把状态改成 failed 让 pump 跳过，
     * 正在写的流会继续跑完并 rename 成品——记录没了、文件却在，成孤儿。
     */
    private controllers = new Map<string, AbortController>();

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
            // 进行中的任务标记取消：中止在途流（半截 .part 随中止删掉），状态改 failed 由 pump 跳过
            if (task.status === "running") {
                task.status = "failed";
                task.error = "已取消";
                this.controllers.get(taskId)?.abort();
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
        // 取消登记：removeTask 通过 controller.abort() 掐断这次下载
        const controller = new AbortController();
        this.controllers.set(task.id, controller);
        try {
            await this.runTaskBody(task, source, headers, tmpPath, controller.signal);
        } finally {
            this.controllers.delete(task.id);
        }
        task.status = "completed";
        task.progress = 100;
        // 写标签（尽力而为）：失败只记一笔，不影响下载本身完成
        try {
            await this.embedTags(task);
        } catch (e: any) {
            console.warn(`[download] 写标签失败 ${task.filename}:`, e?.message ?? e);
        }
    }

    /**
     * 下载完成后把元数据写进文件：标题/歌手/专辑/年份 + 封面 + 歌词。
     * 歌词走这首歌自己的音源插件（getLyric）；封面走条目 artwork。
     * 非 mp3/flac（写不了标签）时歌词退同名 .lrc 边车。
     */
    private async embedTags(task: IDownloadTask) {
        const filePath = task.filePath;
        if (!filePath || !fs.existsSync(filePath)) {
            return;
        }
        const item = task.musicItem as any;
        const artists: string[] = Array.isArray(item.artist)
            ? item.artist.map(String)
            : String(item.artist ?? "")
                  .split(/[/、,;&]/)
                  .map((s) => s.trim())
                  .filter(Boolean);

        const tags: IAudioTags = {
            title: item.title || undefined,
            artists: artists.length ? artists : undefined,
            album: item.album || undefined,
            year: item.year ? String(item.year).slice(0, 4) : undefined,
        };

        // 歌词：插件 getLyric 优先（rawLrc / lrc 直链两形态都接）
        try {
            const plugin = pluginHost.getByPlatform(item.platform);
            const getLyric = plugin?.instance?.getLyric;
            if (plugin && typeof getLyric === "function") {
                const lyricSource = await getLyric.call(plugin.instance, item);
                const rawLrc = String(lyricSource?.rawLrc ?? "");
                tags.lyrics =
                    rawLrc ||
                    (lyricSource?.lrc
                        ? await axios
                              .get(String(lyricSource.lrc), { timeout: 10000, responseType: "text" })
                              .then((r) => String(r.data ?? ""))
                              .catch(() => "")
                        : "");
                // 译文有就并进同一份 LRC（同一时间轴加一行），没译文就是原文
                const translation = String(lyricSource?.translation ?? "");
                if (translation) {
                    tags.lyrics = `${tags.lyrics}\n${translation}`.trim();
                }
            }
        } catch {
            // 拿不到歌词不影响写其余标签
        }

        // 封面：条目 artwork（短链/远程/data URL 都认）
        if (item.artwork) {
            const fetched = await fetchArtworkBytes(String(item.artwork));
            if (fetched?.mime) {
                tags.picture = { format: fetched.mime, data: fetched.data };
            }
        }

        const wrote = writeTags(filePath, tags);
        if (!wrote && tags.lyrics) {
            // 写不进标签的格式（m4a/wav/ogg…）：留一份同名 .lrc，播放器/手机都能读
            const lrcPath = `${filePath.slice(0, -path.extname(filePath).length)}.lrc`;
            fs.writeFileSync(lrcPath, tags.lyrics, "utf8");
        }
        if (wrote) {
            task.tagsWritten = true;
        }
    }

    /** runTask 主体；单独拆出来是为了 finally 里稳定注销取消登记 */
    private async runTaskBody(
        task: IDownloadTask,
        source: Awaited<ReturnType<typeof pluginHost.resolveMedia>>,
        headers: Record<string, string>,
        tmpPath: string,
        signal: AbortSignal,
    ) {
        const resp = await axios.get(source!.url, {
            headers,
            responseType: "stream",
            timeout: 30000,
            maxRedirects: 5,
            validateStatus: () => true,
            signal,
        });
        if (resp.status >= 400) {
            throw new Error(`下载源响应异常 (${resp.status})`);
        }
        const total = Number(resp.headers["content-length"] ?? 0) || 0;
        const ext = extFromUrl(source!.url, resp.headers["content-type"] as string | undefined);
        const filename = sanitizeFilename(
            `${task.musicItem.artist} - ${task.musicItem.title} [${task.quality}].${ext}`,
        );
        task.filename = filename;
        const finalPath = path.join(this.downloadDir, filename);
        task.filePath = finalPath;

        await new Promise<void>((resolve, reject) => {
            const out = fs.createWriteStream(tmpPath);
            let received = 0;
            let lastNotify = 0;
            // 取消时：中止响应流、关掉写句柄，写句柄 close 后删掉半截 .part（Windows
            // 上文件未关删不掉），然后按「已取消」收场
            let aborted = false;
            const onAbort = () => {
                aborted = true;
                try {
                    resp.data.destroy();
                } catch {
                    // ignore
                }
                out.destroy();
                reject(new Error("已取消"));
            };
            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener("abort", onAbort, { once: true });
            }
            out.on("close", () => {
                signal.removeEventListener("abort", onAbort);
                if (aborted) {
                    try {
                        if (fs.existsSync(tmpPath)) {
                            fs.unlinkSync(tmpPath);
                        }
                    } catch {
                        // ignore
                    }
                }
            });
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
    }
}

export default new DownloadService();
