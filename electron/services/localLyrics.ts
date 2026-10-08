import fs from "fs";
import path from "path";
import axios from "axios";
import * as iconv from "iconv-lite";
import coverCache from "./coverCache";
import localMusic from "./localMusic";
import { readEmbeddedLyrics, writeTags } from "./tagWriter";

/**
 * 本地歌曲的歌词/封面补全（配合渲染进程的 localLyricMatch 联网匹配）：
 *
 * 读取优先级（readLyric）：
 *   1. 内嵌歌词：MP3 USLT / FLAC LYRICS（tagWriter 解析，零依赖）
 *   2. 同名 .lrc：同目录下 `<音频名>.lrc`，或 `<歌手 - 标题>.lrc`
 *      （GBK/GB18030 老文件很常见：先按 UTF-8 解，没解出时间轴就换 GB18030）
 *
 * 回写（applyRemote）：联网匹配成功后，把歌词与封面**写进文件本身**
 * （MP3→ID3v2.3 USLT+APIC，FLAC→LYRICS+PICTURE），下次直接走「内嵌」路径读到。
 * 写不进去的格式（m4a/wav/ogg…）退回同目录 `.lrc` 边车文件；
 * 封面同时落一份进封面缓存并更新本地音乐列表的 artwork，列表页立刻有图。
 */

const LRC_TIME_REG = /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/;

function sanitize(name: string) {
    return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
}

/** 从路径名里剥掉下载时写上的音质标记（如 `歌手 - 标题 [high].mp3`） */
function stripQualityTag(base: string) {
    return base.replace(/\s*\[[^\]]*\]$/, "");
}

function decodeLrcBuffer(buf: Buffer): string | null {
    const utf8 = buf.toString("utf8");
    if (LRC_TIME_REG.test(utf8)) {
        return utf8;
    }
    // 无 BOM 的 UTF-16 先试一下（少见但有），再退 GB18030（GBK 的超集）
    try {
        const gb = iconv.decode(buf, "gb18030");
        if (LRC_TIME_REG.test(gb)) {
            return gb;
        }
    } catch {
        // ignore
    }
    const text = utf8.replace(/^\uFEFF/, "");
    return LRC_TIME_REG.test(text) ? text : null;
}

/** 同目录找同名 .lrc：先精确同名，再「歌手 - 标题」与剥音质名 */
function readSidecarLrc(localPath: string, title?: string, artist?: string): string | null {
    const dir = path.dirname(localPath);
    const base = path.basename(localPath, path.extname(localPath));
    const candidates = [
        path.join(dir, `${base}.lrc`),
        path.join(dir, `${stripQualityTag(base)}.lrc`),
    ];
    if (title && artist) {
        candidates.push(
            path.join(dir, `${sanitize(`${artist} - ${title}`)}.lrc`),
            path.join(dir, `${sanitize(`${title} - ${artist}`)}.lrc`),
        );
    }
    for (const candidate of candidates) {
        try {
            if (!fs.existsSync(candidate)) {
                continue;
            }
            const text = decodeLrcBuffer(fs.readFileSync(candidate));
            if (text) {
                return text;
            }
        } catch {
            // 读不了就当没有
        }
    }
    return null;
}

/** 拉封面字节（data: / http(s) / mfs://cover 短链）。mime 只认 jpeg/png（标签只嵌这两种），其余给空串 */
export async function fetchArtworkBytes(artwork: string): Promise<{ data: Buffer; mime: string } | null> {
    try {
        if (artwork.startsWith("data:image")) {
            const match = /^data:(image\/(jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(artwork);
            if (!match) {
                return null;
            }
            return { data: Buffer.from(match[3], "base64"), mime: match[1] };
        }
        if (artwork.startsWith("mfs://cover/")) {
            const fileName = decodeURIComponent(artwork.slice("mfs://cover/".length));
            if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
                return null;
            }
            const filePath = path.join(coverCache.getDir(), fileName);
            if (!fs.existsSync(filePath)) {
                return null;
            }
            const data = fs.readFileSync(filePath);
            const mime = data.subarray(0, 3).toString("hex") === "ffd8ff" ? "image/jpeg" : "image/png";
            return { data, mime };
        }
        if (/^https?:\/\//.test(artwork)) {
            const resp = await axios.get(artwork, {
                responseType: "arraybuffer",
                timeout: 15000,
                maxContentLength: 8 * 1024 * 1024,
            });
            const data = Buffer.from(resp.data);
            const head = data.subarray(0, 3).toString("hex");
            if (head === "ffd8ff") {
                return { data, mime: "image/jpeg" };
            }
            if (data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
                return { data, mime: "image/png" };
            }
            // webp/gif 等嵌不进标签，但可以直接进封面缓存给界面用
            return { data, mime: "" };
        }
        return null;
    } catch {
        return null;
    }
}

export default {
    /** 读本地文件已有的歌词（内嵌优先，其次同名 .lrc）。没有返回 null */
    readLyric(payload: { localPath: string; title?: string; artist?: string }): string | null {
        const { localPath, title, artist } = payload ?? ({} as any);
        if (!localPath || !fs.existsSync(localPath)) {
            return null;
        }
        return readEmbeddedLyrics(localPath) ?? readSidecarLrc(localPath, title, artist);
    },

    /**
     * 联网匹配成功后回写：歌词/封面进文件（写不进就 .lrc 边车），
     * 封面同时进缓存并更新 localMusic.list 的 artwork。
     * 返回新 artwork 短链（没封面任务时返回 null）。
     */
    async applyRemote(payload: {
        localPath: string;
        lyrics?: string;
        artworkUrl?: string;
    }): Promise<{ ok: boolean; artwork?: string; embeddedLyrics?: boolean; sidecarLrc?: boolean; message?: string }> {
        const { localPath, lyrics, artworkUrl } = payload ?? ({} as any);
        if (!localPath || !fs.existsSync(localPath)) {
            return { ok: false, message: "文件不存在" };
        }

        // 封面字节先备好：一份嵌进标签，一份进封面缓存给界面
        let pic: { data: Buffer; mime: string } | null = null;
        let cacheable: { data: Buffer } | null = null;
        if (artworkUrl) {
            const fetched = await fetchArtworkBytes(artworkUrl);
            if (fetched) {
                cacheable = { data: fetched.data };
                if (fetched.mime) {
                    pic = { data: fetched.data, mime: fetched.mime };
                }
            }
        }

        const embedded = writeTags(localPath, {
            lyrics: lyrics || undefined,
            picture: pic ? { format: pic.mime, data: pic.data } : undefined,
        });

        let sidecarLrc = false;
        if (lyrics && !embedded) {
            // 标签写不进去（非 mp3/flac）：退同名 .lrc 边车
            try {
                const lrcPath = `${localPath.slice(0, -path.extname(localPath).length)}.lrc`;
                fs.writeFileSync(lrcPath, lyrics, "utf8");
                sidecarLrc = true;
            } catch {
                // 磁盘都不让写就算了
            }
        }

        let artwork: string | undefined;
        if (cacheable) {
            await coverCache.ensureDir();
            let mtimeMs = 0;
            try {
                mtimeMs = Math.round((await fs.promises.stat(localPath)).mtimeMs);
            } catch {
                // ignore
            }
            const fileName = await coverCache.putCover(
                "local",
                `${localPath}:${mtimeMs}:remote`,
                cacheable.data,
                pic?.mime || "image/jpeg",
            );
            if (fileName) {
                artwork = `mfs://cover/${fileName}`;
                // 列表里的 artwork 同步换掉，本地音乐页立刻有图
                const list = localMusic.getSavedMusicList();
                const entry = list.find((it: any) => it.localPath === localPath);
                if (entry) {
                    entry.artwork = artwork;
                    localMusic.saveMusicList(list);
                }
            }
        }

        return { ok: true, artwork, embeddedLyrics: embedded && !!lyrics, sidecarLrc };
    },
};
