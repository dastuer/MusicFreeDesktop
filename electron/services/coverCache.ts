import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * 封面缓存：把封面实体落成 data/covers 下的图片文件，数据里只留 `mfs://cover/<file>` 短链。
 *
 * 为什么必须这么做：实测用户的音乐库内嵌封面平均 3.7 MB/首（最大 11 MB 的 PNG），
 * 音源插件也会把整张封面塞进 `coverImg`（观察到 13 MB 的 base64）。
 * 这些串一旦进入列表 / localStorage / store.json：
 *   - 185 首本地音乐的列表能到 590 MB，超过 V8 单字符串上限（~512 MB），
 *     JSON.stringify 直接抛 RangeError -> 保存静默失败、页面卡在「加载中」；
 *   - 播放列表每次增删都整体写入 localStorage，leveldb 日志被撑到几十 MB；
 *   - Chromium 的 MediaImage 会报 "src exceeds maximum URL length"，封面反而显示不出来。
 *
 * 文件名约定（同一目录下靠前缀区分，方便清理时各管各的）：
 *   local-<md5>.<ext>   本地音乐扫描出的内嵌封面，可随扫描重建，可安全清理
 *   plugin-<md5>.<ext>  音源插件返回的 base64 封面，按内容寻址（相同封面自动去重）
 */

export const COVER_URL_PREFIX = "mfs://cover/";

/**
 * 文件名形如 <local|plugin>-<32位md5>.<ext>。
 * 前缀可省略——中间版本写过一批裸 md5 命名的封面，必须继续能认出来，
 * 否则用户已经扫描好的列表会集体掉封面（前缀缺失不影响安全性，仍然是严格的 md5+扩展名）。
 */
const COVER_FILE_RE = /^(?:(?:local|plugin)-)?[a-f0-9]{32}\.[a-z0-9]+$/i;

/** 老的裸 md5 命名（没有命名空间前缀），只需要清理，不需要区分归属 */
const LEGACY_COVER_FILE_RE = /^[a-f0-9]{32}\.[a-z0-9]+$/i;

const COVER_EXT_BY_MIME: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
};

const COVER_MIME_BY_EXT: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
};

/**
 * 缩略图最长边。列表里最大只显示 180px，320px 足够；实测 1200x1200 的 97 KB 封面
 * 压完是 320x320 的 9 KB，122 首合计从 442 MB 降到 2.6 MB。
 */
const COVER_THUMB_MAX = 320;
const COVER_THUMB_QUALITY = 82;

/**
 * 体积阈值：超过它的 `data:` URL 不留在数据里。
 * 小于这个尺寸的内联图（如内置示例曲目的 SVG 封面几千字节）留着更省事。
 */
export const MAX_INLINE_DATA_URL = 64 * 1024;

function hashOf(input: string) {
    return crypto.createHash("md5").update(input).digest("hex");
}

/** 懒取 electron.nativeImage：纯 Node 环境（单测）下拿不到，退化为存原图 */
function getNativeImage(): any {
    try {
        const electron = require("electron");
        return electron?.nativeImage ?? null;
    } catch {
        return null;
    }
}

/** 拆解 data:image/xxx;base64,... */
export function parseDataUrl(dataUrl: string): { mime: string; data: Buffer } | null {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
    if (!match) {
        return null;
    }
    try {
        return { mime: match[1].toLowerCase(), data: Buffer.from(match[2], "base64") };
    } catch {
        return null;
    }
}

/** 是不是体积过大的内联 data URL（这种一律不该留在列表 / 持久化数据里） */
export function isOversizedDataUrl(artwork?: string): boolean {
    return typeof artwork === "string" && artwork.length > MAX_INLINE_DATA_URL;
}

/** 把封面压成缩略图。压不动（格式不认识 / 缩完更大）就原样返回 */
export function shrinkCover(data: Uint8Array, mime: string): { data: Buffer; ext: string } {
    const raw = Buffer.from(data);
    const fallbackExt = COVER_EXT_BY_MIME[mime] ?? ".jpg";
    const nativeImage = getNativeImage();
    if (!nativeImage?.createFromBuffer) {
        return { data: raw, ext: fallbackExt };
    }
    try {
        const image = nativeImage.createFromBuffer(raw);
        if (image.isEmpty()) {
            return { data: raw, ext: fallbackExt };
        }
        const { width, height } = image.getSize();
        const resized =
            Math.max(width, height) > COVER_THUMB_MAX
                ? width >= height
                    ? image.resize({ width: COVER_THUMB_MAX })
                    : image.resize({ height: COVER_THUMB_MAX })
                : image;
        const jpeg = resized.toJPEG(COVER_THUMB_QUALITY);
        // 压完反而更大说明原图本来就小，保留原图更清晰
        if (jpeg && jpeg.length < raw.length) {
            return { data: jpeg, ext: ".jpg" };
        }
        return { data: raw, ext: fallbackExt };
    } catch {
        return { data: raw, ext: fallbackExt };
    }
}

/** 从 artwork 短链里取出文件名；不是短链（历史数据里的 base64）返回 null */
export function coverFileNameFromArtwork(artwork?: string): string | null {
    if (!artwork || !artwork.startsWith(COVER_URL_PREFIX)) {
        return null;
    }
    const name = artwork.slice(COVER_URL_PREFIX.length);
    return COVER_FILE_RE.test(name) ? name : null;
}

/** 协议层用：只接受 <前缀>-<md5>.<ext> 形式的纯文件名，挡掉目录穿越 */
export function isCoverFileName(fileName: string): boolean {
    return COVER_FILE_RE.test(fileName);
}

/** 封面文件扩展名 -> content-type */
export function coverMimeOf(fileName: string): string {
    return COVER_MIME_BY_EXT[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 按魔数判断图片类型。
 * 不要相信文件名后缀——中间版本把 JPEG 存成过 .png，
 * 迁移时如果按后缀取 mime，就会和 scan 算出的扩展名对不上，来回生成两套文件。
 */
export function sniffImageMime(data: Uint8Array): string {
    const b = data;
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
        return "image/jpeg";
    }
    if (
        b.length >= 8 &&
        b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
        b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
    ) {
        return "image/png";
    }
    if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
        return "image/gif";
    }
    if (
        b.length >= 12 &&
        b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
    ) {
        return "image/webp";
    }
    if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) {
        return "image/bmp";
    }
    if (
        b.length >= 4 &&
        ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) ||
            (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a))
    ) {
        return "image/tiff";
    }
    return "";
}

export type CoverNamespace = "local" | "plugin";

/** 是不是老格式的裸 md5 文件名（没有命名空间前缀） */
export function isLegacyCoverFileName(fileName: string): boolean {
    return LEGACY_COVER_FILE_RE.test(fileName);
}

class CoverCache {
    private dir = "";

    setup(dataDir: string) {
        this.dir = path.join(dataDir, "covers");
    }

    getDir() {
        return this.dir;
    }

    async ensureDir(): Promise<void> {
        try {
            await fs.promises.mkdir(this.dir, { recursive: true });
        } catch {
            // 建不出目录就退化成「无封面」
        }
    }

    /**
     * 写入封面（幂等：同名文件已存在就跳过），返回文件名。
     * `key` 决定文件名——同一个 key 永远映射到同一个文件。
     */
    async putCover(
        namespace: CoverNamespace,
        key: string,
        data: Uint8Array,
        mime: string,
    ): Promise<string | null> {
        if (!this.dir) {
            return null;
        }
        const { data: out, ext } = shrinkCover(data, mime);
        const fileName = `${namespace}-${hashOf(key)}${ext}`;
        const dest = path.join(this.dir, fileName);
        try {
            await fs.promises.access(dest);
            return fileName;
        } catch {
            // 不存在，继续写
        }
        try {
            await fs.promises.writeFile(dest, out);
            return fileName;
        } catch {
            return null;
        }
    }

    /**
     * 把内联的 data URL 封面落成文件，返回 `mfs://cover/<file>` 短链。
     * 按内容寻址：相同封面（多个音源返回同一张图）自动复用同一个文件。
     */
    async putDataUrl(dataUrl: string): Promise<string | null> {
        const parsed = parseDataUrl(dataUrl);
        if (!parsed) {
            return null;
        }
        await this.ensureDir();
        const fileName = await this.putCover("plugin", dataUrl, parsed.data, parsed.mime);
        return fileName ? COVER_URL_PREFIX + fileName : null;
    }

    async remove(fileName: string): Promise<void> {
        if (!this.dir || !isCoverFileName(fileName)) {
            return;
        }
        try {
            await fs.promises.unlink(path.join(this.dir, fileName));
        } catch {
            // 文件本来就不在（例如已被清理）
        }
    }

    /** 读成 base64 data URL（给 macOS 控制中心/触控栏用，它取不到 mfs:// 自定义协议） */
    readAsDataUrl(fileName: string): string | null {
        if (!this.dir || !isCoverFileName(fileName)) {
            return null;
        }
        try {
            const data = fs.readFileSync(path.join(this.dir, fileName));
            return `data:${coverMimeOf(fileName)};base64,${data.toString("base64")}`;
        } catch {
            return null;
        }
    }

    /**
     * 清理「本地音乐」命名空间里本轮扫描没引用到的封面。
     * 包含两种情况：`local-*`，以及老格式的裸 md5 文件名。
     * 只动这两类：`plugin-*` 是按内容寻址的，没有"本轮扫描"这个概念，
     * 误删会让已经浏览过的列表集体掉封面。它们单个只有几十 KB 且自动去重，量可控。
     */
    async pruneLocal(referenced: Set<string>): Promise<number> {
        let entries: string[];
        try {
            entries = await fs.promises.readdir(this.dir);
        } catch {
            return 0;
        }
        const doomed = entries.filter(
            (name) =>
                (name.startsWith("local-") || isLegacyCoverFileName(name)) &&
                !referenced.has(name),
        );
        await Promise.all(
            doomed.map(async (name) => {
                try {
                    await fs.promises.unlink(path.join(this.dir, name));
                } catch {
                    // ignore
                }
            }),
        );
        return doomed.length;
    }

    /**
     * 删除所有没被引用到的封面文件（不限命名空间），返回删除数量与释放字节。
     *
     * 缓存清理只走这条路：正在使用的封面一律不动。
     * 之前图省事「整个目录清空」，结果列表里的 artwork 短链全部指向不存在的文件，
     * 界面上 182 首歌集体掉封面 —— 而封面只在下次扫描时才会重建，等于把缓存清成了故障。
     */
    async pruneUnreferenced(referenced: Set<string>): Promise<{ removed: number; freed: number }> {
        let entries: string[];
        try {
            entries = await fs.promises.readdir(this.dir);
        } catch {
            return { removed: 0, freed: 0 };
        }
        const doomed = entries.filter(
            (name) => isCoverFileName(name) && !referenced.has(name),
        );
        if (!doomed.length) {
            return { removed: 0, freed: 0 };
        }
        const sizes = await Promise.all(
            doomed.map(async (name) => {
                try {
                    const size = (await fs.promises.lstat(path.join(this.dir, name))).size;
                    await fs.promises.unlink(path.join(this.dir, name));
                    return size;
                } catch {
                    return 0;
                }
            }),
        );
        return {
            removed: doomed.length,
            freed: sizes.reduce((a, b) => a + b, 0),
        };
    }

    /** 当前目录里「本地命名空间」的文件名（含老格式裸 md5），用于启动时对账 */
    async listLocalFiles(): Promise<string[]> {
        try {
            return (await fs.promises.readdir(this.dir)).filter(
                (name) => name.startsWith("local-") || isLegacyCoverFileName(name),
            );
        } catch {
            return [];
        }
    }
}

export default new CoverCache();
