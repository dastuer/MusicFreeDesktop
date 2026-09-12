import { protocol } from "electron";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import axios from "axios";
import { coverMimeOf, isCoverFileName } from "./coverCache";

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

async function handleRemoteMedia(rawPayload: string, request: Request) {
    let payload: { url: string; headers?: Record<string, string>; userAgent?: string };
    try {
        payload = JSON.parse(b64urlDecode(rawPayload));
    } catch {
        return new Response("bad request", { status: 400 });
    }
    console.log(`[mediaProtocol] -> ${payload.url.slice(0, 100)} range=${request.headers.get("range")}`);    const headers: Record<string, string> = { ...(payload.headers ?? {}) };
    if (payload.userAgent) {
        headers["User-Agent"] = payload.userAgent;
    }
    const range = request.headers.get("range");
    if (range) {
        headers["Range"] = range;
    }
    if (!headers["User-Agent"]) {
        headers["User-Agent"] =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
    }

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
