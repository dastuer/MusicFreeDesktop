import { protocol } from "electron";
import fs from "fs";
import { Readable } from "stream";
import axios from "axios";

/**
 * mfs:// 自定义协议
 *  - mfs://media/<base64url(JSON)>  代理远程音频流（携带插件返回的 Referer/UA 等请求头，支持 Range 拖动进度条）
 *  - mfs://local/<base64url(path)>  本地文件流（支持 Range）
 */

function b64urlDecode(input: string): string {
    const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
    return Buffer.from(
        input.replace(/-/g, "+").replace(/_/g, "/") + pad,
        "base64",
    ).toString("utf-8");
}

async function handleLocalFile(rawPath: string, request: Request) {
    const localPath = b64urlDecode(rawPath);
    if (!fs.existsSync(localPath)) {
        return new Response("not found", { status: 404 });
    }
    const stat = fs.statSync(localPath);
    const total = stat.size;
    const mime = localPath.endsWith(".flac")
        ? "audio/flac"
        : localPath.endsWith(".ogg")
            ? "audio/ogg"
            : localPath.endsWith(".wav")
                ? "audio/wav"
                : localPath.endsWith(".m4a")
                    ? "audio/mp4"
                    : "audio/mpeg";
    const rangeHeader = request.headers.get("range");
    const baseHeaders: Record<string, string> = {
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
    };

    if (rangeHeader) {
        const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
        const start = match?.[1] ? parseInt(match[1], 10) : 0;
        const end = match?.[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
        const stream = fs.createReadStream(localPath, { start, end });
        return new Response(Readable.toWeb(stream) as any, {
            status: 206,
            headers: {
                ...baseHeaders,
                "Content-Range": `bytes ${start}-${end}/${total}`,
                "Content-Length": String(end - start + 1),
            },
        });
    }
    const stream = fs.createReadStream(localPath);
    return new Response(Readable.toWeb(stream) as any, {
        status: 200,
        headers: { ...baseHeaders, "Content-Length": String(total) },
    });
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

export function registerMediaProtocol() {
    protocol.handle("mfs", async (request) => {
        const url = new URL(request.url);
        // url.host = media / local, pathname = /<payload>
        const kind = url.host;
        const raw = url.pathname.replace(/^\//, "");
        if (kind === "local") {
            return handleLocalFile(raw, request);
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
