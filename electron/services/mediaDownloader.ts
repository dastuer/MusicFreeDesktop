import fs from "fs";
import axios from "axios";

/**
 * 后台下载器：把一首歌以「网络速度」写进 .part 文件。
 *
 * 为什么必须和播放器解耦：
 * `mfs://media` 原来是「上游 → 播放器」直连（或 pipe）。播放器把自己读够了的数据
 * 就停下不读（Chromium 的读前缓冲约 2 分钟音频，320 kbps 下约 4.8 MB），于是
 * 上游的响应被背压卡住、连接长时间空转，CDN / NAT 会**静默丢掉**这条连接
 * （没有 FIN、没有 RST，客户端永远等不到数据也等不到错误）。
 * 实测症状就是「播放到一半自动暂停，拖一下进度条才能继续」。
 *
 * 所以这里反过来：下载不看播放器脸色，一路灌到磁盘；播放器改成读这个还在增长的
 * 本地文件。上游真的断了就按磁盘上的实际字节续传（Range: bytes=N-）。
 */

/** 上游多久没有新字节就判定为断流。CDN 静默丢连接很常见，必须能自愈。 */
const UPSTREAM_STALL_MS = 20000;
/** 一首歌最多续传几次，避免对着彻底坏掉的音源空转 */
const MAX_RECONNECT = 4;
const RETRY_DELAY_MS = 300;

export interface FirstResponseInfo {
    ok: boolean;
    status: number;
    /** 整首歌字节数，未知为 0 */
    total: number;
    contentType: string;
}

export interface DownloaderOptions {
    url: string;
    /** 已含 Referer / UA / Range 等，Range 由下载器自己覆盖 */
    headers: Record<string, string>;
    partPath: string;
    /** 续传起点（已落盘字节）；首播为 0 */
    startBytes: number;
}

type SessionResult = "complete" | "retry" | "fatal" | "aborted";

function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
}

export default class MediaDownloader {
    private stopped = false;
    private done = false;
    private failed: Error | null = null;
    private bytes: number;
    private _total = 0;
    private _contentType = "audio/mpeg";
    private reconnects = 0;
    private firstInfo: FirstResponseInfo | null = null;
    private abortCurrent: (() => void) | null = null;

    /** 首个响应头到手（或明确失败）后 resolve —— 调用方据此准备响应头 */
    readonly ready: Promise<FirstResponseInfo | null>;
    /** 下载彻底结束（完成 / 放弃）后 resolve */
    readonly settled: Promise<void>;
    private resolveReady!: (v: FirstResponseInfo | null) => void;
    private resolveSettled!: () => void;

    constructor(private opts: DownloaderOptions) {
        this.bytes = opts.startBytes;
        this.ready = new Promise((r) => (this.resolveReady = r));
        this.settled = new Promise((r) => (this.resolveSettled = r));
        void this.run();
    }

    get received() {
        return this.bytes;
    }
    get total() {
        return this._total;
    }
    get contentType() {
        return this._contentType;
    }
    get error() {
        return this.failed;
    }
    get isDone() {
        return this.done;
    }

    stop() {
        this.stopped = true;
        this.abortCurrent?.();
    }

    private async run() {
        let readySent = false;
        while (!this.stopped && !this.done) {
            const result = await this.session(this.bytes, (info) => {
                if (!readySent) {
                    readySent = true;
                    this.resolveReady(info);
                }
            });
            if (!readySent) {
                readySent = true;
                this.resolveReady(
                    this.firstInfo ?? {
                        ok: false,
                        status: 0,
                        total: 0,
                        contentType: this._contentType,
                    },
                );
            }
            if (result === "complete") {
                this.done = true;
                break;
            }
            if (result === "aborted") {
                break;
            }
            if (result === "fatal") {
                this.failed = this.failed ?? new Error("上游不可用");
                break;
            }
            // retry：静默断流 / 连接被关 / 数据不完整，按磁盘实际大小接着下
            this.reconnects += 1;
            if (this.reconnects > MAX_RECONNECT) {
                this.failed = new Error("上游多次中断");
                break;
            }
            await sleep(RETRY_DELAY_MS);
        }
        this.resolveSettled();
    }

    /**
     * 一次上游连接的生命周期。
     * 结束/断流时会把写流 flush 干净，并用**磁盘实际大小**校正 this.bytes，
     * 否则写缓冲里的字节会让续传偏移跑过头，文件中间留下空洞。
     */
    private session(
        startOffset: number,
        onFirst: (info: FirstResponseInfo) => void,
    ): Promise<SessionResult> {
        return new Promise<SessionResult>((resolve) => {
            let settled = false;
            let stream: any = null;
            let file: fs.WriteStream | null = null;
            let idleTimer: NodeJS.Timeout | null = null;

            const clearIdle = () => {
                if (idleTimer) {
                    clearTimeout(idleTimer);
                    idleTimer = null;
                }
            };

            const finish = (result: SessionResult) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearIdle();
                this.abortCurrent = null;
                if (stream) {
                    try {
                        stream.destroy?.();
                    } catch {
                        // ignore
                    }
                }
                const done = () => {
                    try {
                        this.bytes = fs.statSync(this.opts.partPath).size;
                    } catch {
                        // 文件还没建出来，保持原值
                    }
                    resolve(result);
                };
                // 等真正落盘再 resolve，续传偏移才准
                if (file && !file.destroyed) {
                    file.end(done);
                } else {
                    done();
                }
            };

            this.abortCurrent = () => finish("aborted");

            const armIdle = () => {
                clearIdle();
                idleTimer = setTimeout(() => finish("retry"), UPSTREAM_STALL_MS);
            };

            const headers: Record<string, string> = { ...this.opts.headers };
            if (startOffset > 0) {
                headers["Range"] = `bytes=${startOffset}-`;
            } else {
                delete headers["Range"];
            }

            axios
                .get(this.opts.url, {
                    headers,
                    responseType: "stream",
                    timeout: 20000,
                    maxRedirects: 5,
                    validateStatus: () => true,
                })
                .then((resp) => {
                    const status = resp.status;
                    if (status >= 400) {
                        // 416：请求的区间已在文件末尾之外，说明本地其实已经完整
                        const complete = status === 416 && startOffset > 0;
                        if (!complete) {
                            this.failed = new Error(`上游响应异常 (${status})`);
                        }
                        if (complete) {
                            this._total = startOffset;
                        }
                        const info: FirstResponseInfo = {
                            ok: complete,
                            status,
                            total: this._total || startOffset,
                            contentType: this._contentType,
                        };
                        this.firstInfo = this.firstInfo ?? info;
                        onFirst(info);
                        finish(complete ? "complete" : "fatal");
                        return;
                    }

                    const cr = resp.headers["content-range"] as string | undefined;
                    const crMatch = cr ? /\/(\d+)\s*$/.exec(cr) : null;
                    const len = Number(resp.headers["content-length"] ?? 0) || 0;
                    if (crMatch) {
                        this._total = parseInt(crMatch[1], 10);
                    } else if (status === 200) {
                        this._total = len;
                    } else if (startOffset > 0) {
                        this._total = startOffset + len;
                    }
                    this._contentType =
                        (resp.headers["content-type"] as string) ?? this._contentType;

                    const info: FirstResponseInfo = {
                        ok: true,
                        status,
                        total: this._total,
                        contentType: this._contentType,
                    };
                    this.firstInfo = info;

                    if (this.stopped) {
                        onFirst(info);
                        finish("aborted");
                        return;
                    }

                    // 上游不认 Range（回了 200 全量）时只能从头重写
                    const append = status === 206 && startOffset > 0;
                    const base = append ? startOffset : 0;
                    this.bytes = base;

                    file = fs.createWriteStream(this.opts.partPath, {
                        flags: append ? "a" : "w",
                    });
                    file.on("error", () => finish("fatal"));
                    // 先建好写流再放行 ready：调用方拿到 ready 后会立刻去读这个文件
                    onFirst(info);
                    stream = resp.data;
                    stream.on("data", (chunk: Buffer) => {
                        this.bytes += chunk.length;
                        armIdle();
                    });
                    const ended = () =>
                        finish(
                            this._total > 0 && this.bytes < this._total ? "retry" : "complete",
                        );
                    stream.on("end", ended);
                    stream.on("error", () => finish("retry"));
                    stream.on("close", () => {
                        if (!settled) {
                            ended();
                        }
                    });
                    armIdle();
                    // pipe 到磁盘：这里的背压只跟磁盘有关，和播放器无关
                    stream.pipe(file);
                })
                .catch((e: any) => {
                    this.failed = e;
                    const info: FirstResponseInfo = {
                        ok: false,
                        status: 0,
                        total: this._total,
                        contentType: this._contentType,
                    };
                    this.firstInfo = this.firstInfo ?? info;
                    onFirst(info);
                    finish("fatal");
                });
        });
    }
}
