import { protocol } from "electron";
import fs from "fs";
import path from "path";
import { PassThrough, Readable } from "stream";
import axios from "axios";
import { coverMimeOf, isCoverFileName } from "./coverCache";
import mediaCache from "./mediaCache";
import MediaDownloader from "./mediaDownloader";

/**
 * mfs:// 自定义协议
 *  - mfs://media/<base64url(JSON)>  代理远程音频流（携带插件返回的 Referer/UA 等请求头，支持 Range 拖动进度条）
 *  - mfs://local/<base64url(path)>  本地文件流（支持 Range）
 *  - mfs://cover/<file>             本地音乐的内嵌封面（扫描时已落盘到 data/covers）
 */

function b64urlDecode(input: string): string {
    const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
    return Buffer.from(
        input.replace(/-/g, "+").replace(/_/g, "/") + pad,
        "base64",
    ).toString("utf-8");
}

function audioMimeOf(filePath: string): string {
    if (filePath.endsWith(".flac")) {
        return "audio/flac";
    }
    if (filePath.endsWith(".ogg")) {
        return "audio/ogg";
    }
    if (filePath.endsWith(".wav")) {
        return "audio/wav";
    }
    if (filePath.endsWith(".m4a")) {
        return "audio/mp4";
    }
    return "audio/mpeg";
}

/**
 * 通用本地文件响应：支持 Range（拖进度条）。
 * 全部走异步 fs：老实现用 statSync 在主进程线程上同步取 stat，
 * 播放时 Chromium 会连发多次 Range 请求，每次都同步读盘，正是卡顿来源之一。
 */
async function serveFile(
    filePath: string,
    request: Request,
    mime: string,
    cacheControl?: string,
): Promise<Response> {
    let stat: fs.Stats;
    try {
        stat = await fs.promises.stat(filePath);
    } catch {
        return new Response("not found", { status: 404 });
    }
    if (!stat.isFile()) {
        return new Response("not found", { status: 404 });
    }
    const total = stat.size;
    const baseHeaders: Record<string, string> = {
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
    };
    if (cacheControl) {
        baseHeaders["Cache-Control"] = cacheControl;
    }

    const rangeHeader = request.headers.get("range");
    if (rangeHeader) {
        const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
        const start = match?.[1] ? parseInt(match[1], 10) : 0;
        const end = match?.[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
        const stream = fs.createReadStream(filePath, { start, end });
        return new Response(Readable.toWeb(stream) as any, {
            status: 206,
            headers: {
                ...baseHeaders,
                "Content-Range": `bytes ${start}-${end}/${total}`,
                "Content-Length": String(end - start + 1),
            },
        });
    }
    const stream = fs.createReadStream(filePath);
    return new Response(Readable.toWeb(stream) as any, {
        status: 200,
        headers: { ...baseHeaders, "Content-Length": String(total) },
    });
}

async function handleLocalFile(rawPath: string, request: Request) {
    const localPath = b64urlDecode(rawPath);
    return serveFile(localPath, request, audioMimeOf(localPath));
}

/** 封面：文件名是扫描时算好的 md5，内容不变，可以长缓存 */
async function handleCover(
    rawFileName: string,
    coverDir: string,
    request: Request,
): Promise<Response> {
    if (!coverDir) {
        return new Response("cover dir not ready", { status: 500 });
    }
    const fileName = decodeURIComponent(rawFileName);
    // 只接受 <md5>.<ext> 形式的纯文件名，挡掉 ../ 目录穿越
    if (!isCoverFileName(fileName)) {
        return new Response("bad request", { status: 400 });
    }
    const filePath = path.join(coverDir, fileName);
    return serveFile(
        filePath,
        request,
        coverMimeOf(fileName),
        "public, max-age=31536000, immutable",
    );
}

/**
 * 只有「从头、且结尾开放」的请求才走缓存。
 * 拖动进度条要的是 bytes=N-，为那 2 MB 去下整首歌不划算；bytes=0-1 这类探测请求同理。
 */
function isFromStartOpenRange(range: string | null): boolean {
    if (!range) {
        return true;
    }
    return /^bytes=0-\s*$/i.test(range.trim());
}

type RemotePayload = {
    url: string;
    headers?: Record<string, string>;
    userAgent?: string;
    /** 缓存键：音源直链可能带时效参数，只有歌曲身份才是稳定的 */
    cacheKey?: { platform: string; id: string; quality?: string };
};

function buildUpstreamHeaders(payload: RemotePayload, range: string | null) {
    const headers: Record<string, string> = { ...(payload.headers ?? {}) };
    if (payload.userAgent) {
        headers["User-Agent"] = payload.userAgent;
    }
    if (range) {
        headers["Range"] = range;
    }
    if (!headers["User-Agent"]) {
        headers["User-Agent"] =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    }
    return headers;
}

/** 不带缓存的纯转发（缓存关闭、拖动进度条、或缓存写入失败时的兜底） */
async function plainProxy(
    payload: RemotePayload,
    headers: Record<string, string>,
): Promise<Response> {
    try {
        // net.fetch 对部分 CDN（如 bilibili mcdn P2P 节点）会报 ERR_INVALID_ARGUMENT，
        // 改用 axios stream 代理，完整透传状态码与关键响应头
        const resp = await axios.get(payload.url, {
            headers,
            responseType: "stream",
            timeout: 20000,
            maxRedirects: 5,
            validateStatus: () => true,
        });
        console.log(
            `[mediaProtocol] <- ${resp.status} ${payload.url.slice(0, 80)} ct=${resp.headers["content-type"]} len=${resp.headers["content-length"]}`,
        );
        const respHeaders: Record<string, string> = {
            "Content-Type": (resp.headers["content-type"] as string) ?? "application/octet-stream",
            "Accept-Ranges": "bytes",
        };
        if (resp.headers["content-length"]) {
            respHeaders["Content-Length"] = String(resp.headers["content-length"]);
        }
        if (resp.headers["content-range"]) {
            respHeaders["Content-Range"] = String(resp.headers["content-range"]);
        }
        // axios 会自动解压，不能把上游的 content-encoding 透传给播放器
        return new Response(Readable.toWeb(resp.data) as any, {
            status: resp.status,
            headers: respHeaders,
        });
    } catch (e: any) {
        console.error("[mediaProtocol] fetch failed", payload.url.slice(0, 80), e?.message);
        return new Response(String(e?.message ?? e), { status: 502 });
    }
}

const FOLLOW_CHUNK = 256 * 1024;
const FOLLOW_POLL_MS = 40;

function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
}

/** 播放器把 out 写满时在这里等它腾地方；out 被关掉/出错也要能立刻退出 */
function waitDrain(out: PassThrough) {
    return new Promise<void>((resolve) => {
        const done = () => {
            out.off("drain", done);
            out.off("close", done);
            out.off("error", done);
            resolve();
        };
        out.once("drain", done);
        out.once("close", done);
        out.once("error", done);
    });
}

/**
 * 把「正在增长的 .part 文件」喂给播放器。
 *
 * 播放器读得慢只会卡在这一层（waitDrain），不会回头去拖上游的下载速度——
 * 这正是修复「播到一半卡死」的关键：上游连接不会因为播放器读得慢而长时间空转，
 * 也就不会静默断流；真断了由 MediaDownloader 续传，播放器这边只看到文件在变长。
 */
async function followPartFile(
    partPath: string,
    out: PassThrough,
    dl: MediaDownloader,
    state: { stopped: boolean },
) {
    let handle: fs.promises.FileHandle | null = null;
    let pos = 0;
    try {
        // 写流是异步 open 的，文件可能还没落地，短暂重试几次
        for (let i = 0; i < 100 && !handle; i += 1) {
            try {
                handle = await fs.promises.open(partPath, "r");
            } catch {
                await sleep(FOLLOW_POLL_MS);
            }
        }
        if (!handle) {
            out.destroy(new Error("缓存文件不可用"));
            return;
        }
        while (!state.stopped && !out.destroyed) {
            if (dl.total > 0 && pos >= dl.total) {
                out.end();
                return;
            }
            const buf = Buffer.allocUnsafe(FOLLOW_CHUNK);
            const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
            if (bytesRead > 0) {
                pos += bytesRead;
                if (!out.write(buf.subarray(0, bytesRead))) {
                    await waitDrain(out);
                }
                continue;
            }
            if (dl.isDone) {
                // 下载已结束但文件没读满：明确报错，让播放器走「下一首」兜底，
                // 而不是把响应体永远挂着让播放器无限等待（旧实现就是这么卡住的）
                if (dl.total > 0 && pos < dl.total) {
                    out.destroy(dl.error ?? new Error("上游数据不完整"));
                } else {
                    out.end();
                }
                return;
            }
            await sleep(FOLLOW_POLL_MS);
        }
    } catch (e: any) {
        try {
            out.destroy(e);
        } catch {
            // ignore
        }
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

/**
 * 写穿式缓存。
 *
 * 数据流是「上游 →（全速）→ .part 文件 →（跟随读取）→ 播放器」，两段完全解耦：
 *  - 上游侧由 MediaDownloader 负责，静默断流会按磁盘实际字节自动续传；
 *  - 播放器侧由 followPartFile 负责，它读得慢只会让自己等，不会影响上游。
 *
 * 返回 null 表示这轮没接住（上游首个响应就失败），调用方回退到纯转发。
 * 注意：一进来就持有 mediaCache 的 busy 标记，所有失败分支都必须 release。
 */
async function cachedProxy(
    payload: RemotePayload,
    headers: Record<string, string>,
    hash: string,
    cacheKey: { platform: string; id: string; quality?: string },
): Promise<Response | null> {
    await mediaCache.ensureDir();
    const partPath = mediaCache.partPath(hash);
    const have = mediaCache.resumableBytes(hash);

    const dl = new MediaDownloader({
        url: payload.url,
        headers,
        partPath,
        startBytes: have,
    });

    const first = await dl.ready;
    if (!first || !first.ok) {
        dl.stop();
        mediaCache.release(hash);
        return null;
    }

    if (!mediaCache.readMeta(hash)) {
        mediaCache.writeMeta(hash, {
            key: hash,
            platform: cacheKey.platform,
            id: cacheKey.id,
            quality: cacheKey.quality ?? "",
            total: first.total,
            received: dl.received,
            contentType: first.contentType,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
    }

    const out = new PassThrough();
    const state = { stopped: false };
    let settled = false;
    const finalize = () => {
        if (settled) {
            return;
        }
        settled = true;
        void mediaCache.finalize(hash, dl.received, dl.total);
    };
    // 下载结束（收满转正 / 中途放弃记断点）后收尾，顺带释放 busy 标记
    void dl.settled.then(finalize);
    // 播放器断开（切歌 / 拖动 / 长时间不读）：停掉下载，保留断点下次续传
    out.on("close", () => {
        state.stopped = true;
        setImmediate(() => dl.stop());
    });

    void followPartFile(partPath, out, dl, state);

    const total = dl.total;
    // 请求带了 Range（而且一定是 bytes=0- 这种开放区间，见 handleRemoteMedia 的前置判断）
    // 就按 206 回，body 正好是 [0, total) 这一整段；否则 200。
    // 注意 Content-Range 只能出现在 206 里，放到 200 上会让播放器直接报格式错误。
    const status = headers["Range"] ? 206 : 200;
    const respHeaders: Record<string, string> = {
        "Content-Type": first.contentType || "audio/mpeg",
        "Accept-Ranges": "bytes",
    };
    if (total > 0) {
        respHeaders["Content-Length"] = String(total);
        if (status === 206) {
            respHeaders["Content-Range"] = `bytes 0-${total - 1}/${total}`;
        }
    }
    return new Response(Readable.toWeb(out) as any, { status, headers: respHeaders });
}

async function handleRemoteMedia(rawPayload: string, request: Request) {
    let payload: RemotePayload;
    try {
        payload = JSON.parse(b64urlDecode(rawPayload));
    } catch {
        return new Response("bad request", { status: 400 });
    }
    const range = request.headers.get("range");
    console.log(`[mediaProtocol] -> ${payload.url.slice(0, 100)} range=${range}`);
    const headers = buildUpstreamHeaders(payload, range);

    const cacheKey = payload.cacheKey;
    const canCache =
        mediaCache.isEnabled() && !!cacheKey?.platform && !!cacheKey?.id;
    if (canCache) {
        const hash = mediaCache.hash(cacheKey!.platform, cacheKey!.id, cacheKey!.quality ?? "");
        // 整首已缓存：完全走磁盘，秒开、拖动即时、也不再依赖音源
        if (mediaCache.hasComplete(hash)) {
            mediaCache.touch(hash);
            const meta = mediaCache.readMeta(hash);
            console.log(`[mediaProtocol] cache hit ${cacheKey!.id} (${hash.slice(0, 8)})`);
            return serveFile(
                mediaCache.completePath(hash),
                request,
                meta?.contentType || "audio/mpeg",
            );
        }
        // 只缓存「从头、结尾开放」的请求；拖动进度条（bytes=N-）没命中完整缓存时走原路透传。
        // 注意 cachedProxy 内部负责释放 busy 标记，返回 null 表示没接住、要回退。
        if (isFromStartOpenRange(range) && mediaCache.acquire(hash)) {
            try {
                const cached = await cachedProxy(payload, headers, hash, cacheKey!);
                if (cached) {
                    return cached;
                }
            } catch (e: any) {
                mediaCache.release(hash);
                console.error("[mediaProtocol] cache write failed, fallback", e?.message);
            }
        }
    }
    return plainProxy(payload, headers);
}

export function registerMediaProtocol(options: { coverDir?: string } = {}) {
    const coverDir = options.coverDir ?? "";
    protocol.handle("mfs", async (request) => {
        const url = new URL(request.url);
        // url.host = media / local / cover, pathname = /<payload>
        const kind = url.host;
        const raw = url.pathname.replace(/^\//, "");
        if (kind === "local") {
            return handleLocalFile(raw, request);
        }
        if (kind === "cover") {
            return handleCover(raw, coverDir, request);
        }
        return handleRemoteMedia(raw, request);
    });
}

/** 生成可播放的 mfs url（渲染进程也通过它构造） */
export function buildMediaUrl(
    payload: { url: string; headers?: Record<string, string>; userAgent?: string },
): string {
    const b64 = Buffer.from(JSON.stringify(payload), "utf-8")
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    return `mfs://media/${b64}`;
}
