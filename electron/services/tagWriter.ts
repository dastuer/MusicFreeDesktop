import fs from "fs";

/**
 * 原生标签写入器（零依赖）：给下载完成的音频补 ID3v2.3（MP3）/
 * Vorbis Comment + PICTURE（FLAC）标签与歌词；同时供本地歌词匹配读内嵌歌词/封面。
 *
 * 为什么自己写：music-metadata 只读不写；node-id3 / flac-metadata 这类库
 * 内部动态 require 原生码表模块，esbuild --bundle --minify 打包主进程时解析不到。
 * 字节格式是公开标准（ID3v2.3.0 / FLAC metaflags / Vorbis comment），手写一次全平台随应用分发。
 *
 * 原则：写失败就放弃，绝不留坏文件 —— 所有帧、块、长度全部在内存里拼好才落盘。
 * FLAC 的音频帧靠同步码（0xFFF8）自定位、STREAMINFO 不记字节总长，所以改块区长度
 * 不需要动 STREAMINFO；但 SEEKTABLE 记的是音频帧的绝对字节偏移，块区一变长就全错，
 * 处理方式只有一个：丢弃（下载文件几乎不含 SEEKTABLE）。
 */

export interface ITagPicture {
    format: string; // mime："image/jpeg" / "image/png"
    data: Buffer;
}

export interface IAudioTags {
    title?: string;
    artists?: string[];
    album?: string;
    year?: string;
    genre?: string;
    trackNo?: number;
    /** 歌词（LRC 文本）。MP3 写 USLT，FLAC 写 LYRICS 字段 */
    lyrics?: string;
    picture?: ITagPicture;
}

// ---------- 公共小工具 ----------

/** ID3v2 synchsafe：大端、每字节只用低 7 位 */
function synchsafe(n: number): Buffer {
    return Buffer.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f]);
}

function synchsafeRead(buf: Buffer, offset: number): number {
    return (
        ((buf[offset] & 0x7f) << 21) |
        ((buf[offset + 1] & 0x7f) << 14) |
        ((buf[offset + 2] & 0x7f) << 7) |
        (buf[offset + 3] & 0x7f)
    );
}

function be32(n: number): Buffer {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32BE(n >>> 0, 0);
    return b;
}

function le32(n: number): Buffer {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
}

/** Latin-1 编码（ID3v2.3 文本帧用）：超出 0xFF 的字符变 "?" */
function encodeLatin1(s: string): Buffer {
    const out: number[] = [];
    for (const ch of s) {
        const cp = ch.codePointAt(0)!;
        out.push(cp <= 0xff ? cp : 0x3f);
    }
    return Buffer.from(out);
}

function encodeUtf16Bom(s: string): Buffer {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
}

/** 从 UTF-16（自动识别 BOM）解出字符串，截到第一个 NUL 单元为止 */
function decodeUtf16(buf: Buffer): string {
    let start = 0;
    let little = true;
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        little = true;
        start = 2;
    } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        little = false;
        start = 2;
    }
    const body = buf.subarray(start);
    const units: number[] = [];
    for (let i = 0; i + 1 < body.length; i += 2) {
        const code = little ? body.readUInt16LE(i) : body.readUInt16BE(i);
        if (code === 0) {
            break;
        }
        units.push(code);
    }
    return String.fromCharCode(...units);
}

function guessMime(data: Buffer): string | null {
    if (data.subarray(0, 3).toString("hex") === "ffd8ff") {
        return "image/jpeg";
    }
    if (data.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
        return "image/png";
    }
    return null;
}

// ---------- 文件类型嗅探 ----------

type AudioKind = "mp3" | "flac";

function sniffKind(filePath: string): AudioKind | null {
    let fd: number | null = null;
    try {
        fd = fs.openSync(filePath, "r");
        const head = Buffer.alloc(4);
        if (fs.readSync(fd, head, 0, 4, 0) < 4) {
            return null;
        }
        if (head.subarray(0, 3).toString("latin1") === "ID3" || head[0] === 0xff) {
            return "mp3";
        }
        if (head.subarray(0, 4).toString("latin1") === "fLaC") {
            return "flac";
        }
        return null;
    } catch {
        return null;
    } finally {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            } catch {
                // ignore
            }
        }
    }
}

// ==================================================================
// ID3v2.3（MP3）
// ==================================================================

function id3Frame(id: string, payload: Buffer): Buffer {
    return Buffer.concat([
        Buffer.from(id, "latin1"),
        be32(payload.length), // v2.3 帧长是普通大端 u32（不是 synchsafe）
        Buffer.from([0, 0]), // flags
        payload,
    ]);
}

/** 文本帧：纯 ASCII 走 Latin-1（旧播放器/Windows 兼容最好），含中文再上 UTF-16 */
function id3TextFrame(id: string, text: string): Buffer | null {
    if (!text) {
        return null;
    }
    const latin = encodeLatin1(text);
    if (latin.toString("latin1") === text) {
        return id3Frame(id, Buffer.concat([Buffer.from([0]), latin]));
    }
    return id3Frame(id, Buffer.concat([Buffer.from([1]), encodeUtf16Bom(text), Buffer.from([0, 0])]));
}

/**
 * USLT 布局（ID3v2.3）：encoding(1) + language(3 字节定长，无 NUL！) +
 * 描述（按 encoding 的 NUL 终止符结尾）+ 歌词文本。
 */
function id3Uslt(text: string): Buffer | null {
    if (!text) {
        return null;
    }
    const latin = encodeLatin1(text);
    if (latin.toString("latin1") === text) {
        // enc=0：空描述 = 单字节 NUL
        return id3Frame(
            "USLT",
            Buffer.concat([Buffer.from([0]), Buffer.from("eng", "latin1"), Buffer.from([0]), latin]),
        );
    }
    // enc=1：空描述 = 双字节 NUL（偶数个八位组），歌词 = BOM + UTF-16LE + 双 NUL 终止
    return id3Frame(
        "USLT",
        Buffer.concat([
            Buffer.from([1]),
            Buffer.from("eng", "latin1"),
            Buffer.from([0, 0]),
            encodeUtf16Bom(text),
            Buffer.from([0, 0]),
        ]),
    );
}

function id3Apic(picture: ITagPicture): Buffer | null {
    if (!picture?.data?.length) {
        return null;
    }
    const mime = /^image\/(jpeg|png)$/.test(picture.format) ? picture.format : guessMime(picture.data);
    if (!mime) {
        return null;
    }
    return id3Frame(
        "APIC",
        Buffer.concat([
            Buffer.from([0]), // encoding: Latin-1
            Buffer.from(mime, "latin1"),
            Buffer.from([0]), // mime NUL
            Buffer.from([3]), // picture type: cover (front)
            Buffer.from([0]), // 空描述（Latin-1 下单字节 NUL）
            picture.data,
        ]),
    );
}

interface IId3v2Info {
    version: 2 | 3 | 4;
    /** 整个 tag（header + frames + 可选 footer）的字节数 */
    size: number;
}

function readId3v2Header(head: Buffer): IId3v2Info | null {
    if (head.length < 10 || head.subarray(0, 3).toString("latin1") !== "ID3") {
        return null;
    }
    const version = head[3] as 2 | 3 | 4;
    const flags = head[5];
    return { version, size: 10 + synchsafeRead(head, 6) + ((flags & 0x10) ? 10 : 0) };
}

/** 文本帧解码：按 encoding 字节选 Latin-1 / UTF-16 / UTF-8，截到第一个 NUL */
function decodeId3Text(body: Buffer): string {
    const enc = body[0];
    const rest = body.subarray(1);
    if (enc === 0) {
        const nul = rest.indexOf(0);
        return (nul >= 0 ? rest.subarray(0, nul) : rest).toString("latin1").trim();
    }
    if (enc === 1) {
        return decodeUtf16(rest).trim();
    }
    const nul = rest.indexOf(0);
    return (nul >= 0 ? rest.subarray(0, nul) : rest).toString("utf8").trim();
}

/** USLT 解码：language(3 字节定长) NUL-终止描述 NUL-终止文本。与文本帧不同：多一个语言段 */
function decodeId3Uslt(body: Buffer): string {
    const enc = body[0];
    let i = 1 + 3; // 跳过语言码
    if (enc === 1) {
        // UTF-16：描述与文本都按双字节码元走，终止符 = 双 NUL
        const readNullTerminated = (start: number): { text: string; next: number } => {
            const units: number[] = [];
            let j = start;
            while (j + 1 < body.length) {
                const code = body.readUInt16LE(j);
                j += 2;
                if (code === 0) {
                    break;
                }
                units.push(code);
            }
            return { text: String.fromCharCode(...units), next: j };
        };
        const desc = readNullTerminated(i);
        // 文本自带 BOM（我们的写入带；别人的可能不带，decodeUtf16 都兜住）
        const text = readNullTerminated(desc.next);
        return text.text.trim();
    }
    // Latin-1 / UTF-8：描述与文本各以单字节 NUL 结束
    while (i < body.length && body[i] !== 0) {
        i++;
    }
    const rest = body.subarray(i + 1);
    const nul = rest.indexOf(0);
    const textBuf = nul >= 0 ? rest.subarray(0, nul) : rest;
    return textBuf.toString(enc === 0 ? "latin1" : "utf8").trim();
}

function decodeId3Apic(body: Buffer): ITagPicture | null {
    const enc = body[0];
    let i = 1;
    let mime = "";
    while (i < body.length && body[i] !== 0) {
        mime += String.fromCharCode(body[i]);
        i++;
    }
    i++; // mime NUL
    i++; // picture type
    if (enc === 1) {
        while (i + 1 < body.length && !(body[i] === 0 && body[i + 1] === 0)) {
            i += 2;
        }
        i += 2;
    } else {
        while (i < body.length && body[i] !== 0) {
            i++;
        }
        i++;
    }
    const data = Buffer.from(body.subarray(i)); // 拷贝出独立缓冲，别攥着整个文件 buffer
    if (!data.length) {
        return null;
    }
    if (/^image\/(jpeg|png)$/.test(mime)) {
        return { format: mime, data };
    }
    const guessed = guessMime(data);
    return guessed ? { format: guessed, data } : null;
}

/** v2.2 三字符帧号 → v2.3 四字符 */
const ID3V2_ID_MAP: Record<string, string> = {
    TT2: "TIT2",
    TAL: "TALB",
    TP1: "TPE1",
    TYE: "TYER",
    TRK: "TRCK",
    TCO: "TCON",
    WLT: "USLT",
    PIC: "APIC",
};

interface IId3Extracted extends IAudioTags {
    /** USLT 与 tags.lyrics 分开留：兜底合并时口径清楚 */
    uslt?: string;
}

/** 遍历现有 ID3v2（2/3/4）提取内容：写标签时 tags 没给的字段用它兜底 */
function extractId3Frames(buf: Buffer, version: 2 | 3 | 4): IId3Extracted {
    const out: Partial<IId3Extracted> = {};
    const headerSize = version === 2 ? 6 : 10;
    let p = 10;
    while (p + headerSize <= buf.length) {
        const rawId = buf.subarray(p, p + (version === 2 ? 3 : 4)).toString("latin1");
        const validId = version === 2 ? /^[A-Z0-9]{3}$/.test(rawId) : /^[A-Z0-9]{4}$/.test(rawId);
        if (!validId) {
            break; // 零填充 / 帧表结束
        }
        const id = version === 2 ? ID3V2_ID_MAP[rawId] : rawId;
        const size =
            version === 2
                ? (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5]
                : version === 4
                  ? synchsafeRead(buf, p + 4)
                  : buf.readUInt32BE(p + 4);
        const body = buf.subarray(p + headerSize, p + headerSize + size);
        if (size <= 0 || body.length < size) {
            break;
        }
        switch (id) {
            case "TIT2":
                out.title = decodeId3Text(body);
                break;
            case "TALB":
                out.album = decodeId3Text(body);
                break;
            case "TCON":
                out.genre = decodeId3Text(body);
                break;
            case "TPE1":
                // ID3v2.3 多艺术家以「/」分隔
                out.artists = decodeId3Text(body)
                    .split("/")
                    .map((s) => s.trim())
                    .filter(Boolean);
                break;
            case "TRCK": {
                const n = parseInt(decodeId3Text(body), 10);
                if (n > 0) out.trackNo = n;
                break;
            }
            case "TYER":
            case "TDRC":
                out.year = decodeId3Text(body).slice(0, 4);
                break;
            case "APIC":
                if (!out.picture) {
                    out.picture = decodeId3Apic(body) ?? undefined;
                }
                break;
            case "USLT":
                out.uslt = decodeId3Uslt(body);
                break;
        }
        p += headerSize + size;
    }
    return out as IId3Extracted;
}

/** 只读一个 MP3 的 ID3v2 区（体积上限防坏文件） */
function readMp3Tag(filePath: string): { version: 2 | 3 | 4; extracted: IId3Extracted } | null {
    let fd: number | null = null;
    try {
        fd = fs.openSync(filePath, "r");
        const head = Buffer.alloc(10);
        if (fs.readSync(fd, head, 0, 10, 0) < 10) {
            return null;
        }
        const tag = readId3v2Header(head);
        if (!tag || tag.size > 16 * 1024 * 1024) {
            return null;
        }
        const tagBuf = Buffer.alloc(tag.size);
        let read = 0;
        while (read < tag.size) {
            const n = fs.readSync(fd, tagBuf, read, tag.size - read, read);
            if (n <= 0) {
                break;
            }
            read += n;
        }
        return { version: tag.version, extracted: extractId3Frames(tagBuf, tag.version) };
    } catch {
        return null;
    } finally {
        if (fd !== null) {
            try {
                fs.closeSync(fd);
            } catch {
                // ignore
            }
        }
    }
}

/**
 * 重写 MP3 的标签区：丢弃旧 ID3v2 与 ID3v1，生成新 ID3v2.3，音频体原样保留。
 * tags 没给的字段用旧标签兜底；旧 USLT 在新歌词缺失时保留。
 */
function rewriteMp3(filePath: string, tags: IAudioTags): boolean {
    const buf = fs.readFileSync(filePath);
    const old = readId3v2Header(buf.subarray(0, Math.min(buf.length, 10)));
    let audioStart = 0;
    if (old) {
        audioStart = old.size;
    }
    let audioEnd = buf.length;
    if (buf.length - audioStart >= 128 && buf.subarray(buf.length - 128, buf.length - 125).toString("latin1") === "TAG") {
        audioEnd = buf.length - 128; // 丢 ID3v1
    }
    const audio = buf.subarray(audioStart, audioEnd);
    const existing = old ? extractId3Frames(buf.subarray(0, audioStart), old.version) : {};

    const merged: IAudioTags & { uslt?: string } = {
        title: tags.title || existing.title,
        artists: tags.artists?.length ? tags.artists : existing.artists,
        album: tags.album || existing.album,
        year: tags.year || existing.year,
        genre: tags.genre || existing.genre,
        trackNo: tags.trackNo ?? existing.trackNo,
        picture: tags.picture ?? existing.picture,
        uslt: tags.lyrics ?? existing.uslt,
    };

    const frames = [
        id3TextFrame("TIT2", merged.title ?? ""),
        id3TextFrame("TALB", merged.album ?? ""),
        id3TextFrame("TCON", merged.genre ?? ""),
        // ID3v2.3 规范：TPE1 多艺术家用「/」分隔（Windows 资源管理器/播放器都按此切）
        id3TextFrame("TPE1", merged.artists?.join("/") ?? ""),
        id3TextFrame("TYER", merged.year ?? ""),
        id3TextFrame("TRCK", merged.trackNo ? String(merged.trackNo) : ""),
        id3Uslt(merged.uslt ?? ""),
        merged.picture ? id3Apic(merged.picture) : null,
    ].filter((f): f is Buffer => !!f);

    if (!frames.length) {
        return false;
    }
    const body = Buffer.concat(frames);
    fs.writeFileSync(
        filePath,
        Buffer.concat([
            Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([3, 0, 0]), synchsafe(body.length)]),
            body,
            audio,
        ]),
    );
    return true;
}

// ==================================================================
// FLAC（Vorbis Comment + PICTURE）
// ==================================================================

/** Vorbis 字符串：小端 u32 长度 + utf8 */
function vorbisString(s: string): Buffer {
    const body = Buffer.from(s, "utf8");
    return Buffer.concat([le32(body.length), body]);
}

interface IFlacBlock {
    /** 块类型（0..126），last-flag 已剥掉 */
    type: number;
    body: Buffer;
}

interface IFlacParsed {
    blocks: IFlacBlock[];
    /** 块区之后的音频数据起点 */
    audioOffset: number;
}

function parseFlac(buf: Buffer): IFlacParsed {
    const blocks: IFlacBlock[] = [];
    let p = 4; // "fLaC"
    let last = false;
    while (!last && p + 4 <= buf.length) {
        const flags = buf[p];
        last = (flags & 0x80) !== 0;
        const len = (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
        if (p + 4 + len > buf.length) {
            throw new Error("flac truncated");
        }
        blocks.push({ type: flags & 0x7f, body: buf.subarray(p + 4, p + 4 + len) });
        p += 4 + len;
    }
    return { blocks, audioOffset: p };
}

function vorbisField(body: Buffer, key: string): string | undefined {
    let p = 0;
    const vendorLen = body.readUInt32LE(p);
    p += 4 + vendorLen;
    const count = body.readUInt32LE(p);
    p += 4;
    let found: string | undefined;
    for (let i = 0; i < count && p + 4 <= body.length; i++) {
        const len = body.readUInt32LE(p);
        p += 4;
        const field = body.subarray(p, p + len).toString("utf8");
        p += len;
        const eq = field.indexOf("=");
        if (eq > 0 && field.slice(0, eq).toUpperCase() === key) {
            found = field.slice(eq + 1);
        }
    }
    return found;
}

/**
 * PICTURE 块（全部大端）：type(4) mime(4+n) desc(4+n) w h depth colors(4×4) dataLen(4) data。
 * 返回 null 表示块损坏（截断/不支持的图格式）。
 */
function decodeFlacPicture(body: Buffer): ITagPicture | null {
    try {
        let p = 4; // picture type
        const mimeLen = body.readUInt32BE(p);
        p += 4;
        const mime = body.subarray(p, p + mimeLen).toString("latin1");
        p += mimeLen;
        const descLen = body.readUInt32BE(p);
        p += 4 + descLen;
        p += 16; // width/height/depth/colors
        const dataLen = body.readUInt32BE(p);
        p += 4;
        const data = Buffer.from(body.subarray(p, p + dataLen));
        if (data.length < dataLen || !data.length) {
            return null;
        }
        if (/^image\/(jpeg|png)$/.test(mime)) {
            return { format: mime, data };
        }
        const guessed = guessMime(data);
        return guessed ? { format: guessed, data } : null;
    } catch {
        return null;
    }
}

function buildFlacPicture(pic: ITagPicture): Buffer | null {
    const mime = /^image\/(jpeg|png)$/.test(pic.format) ? pic.format : guessMime(pic.data);
    if (!mime || !pic.data?.length) {
        return null;
    }
    return Buffer.concat([
        be32(3), // cover (front)
        vorbisStringBe(mime),
        vorbisStringBe(""), // description
        be32(0),
        be32(0),
        be32(0),
        be32(0),
        be32(pic.data.length), // PICTURE 块内所有整数都是 big-endian
        pic.data,
    ]);
}

/** PICTURE 里的字符串是 big-endian 前缀（Vorbis comment 才是小端），单独一个 helper */
function vorbisStringBe(s: string): Buffer {
    const body = Buffer.from(s, "utf8");
    return Buffer.concat([be32(body.length), body]);
}

interface IFlacExtracted extends IAudioTags {}

function extractFlacVorbis(body: Buffer): IFlacExtracted {
    const out: IFlacExtracted = {};
    const title = vorbisField(body, "TITLE");
    if (title) out.title = title;
    const album = vorbisField(body, "ALBUM");
    if (album) out.album = album;
    const artist = vorbisField(body, "ARTIST");
    if (artist) {
        // Vorbis 注释惯例：多 ARTIST 字段；但单字段多艺术家的文件也常见（/ 分隔）
        out.artists = artist.split("/").map((s) => s.trim()).filter(Boolean);
    }
    const date = vorbisField(body, "DATE");
    if (date) out.year = date.slice(0, 4);
    const genre = vorbisField(body, "GENRE");
    if (genre) out.genre = genre;
    const track = vorbisField(body, "TRACKNUMBER");
    if (track) {
        const n = parseInt(track, 10);
        if (n > 0) out.trackNo = n;
    }
    const lyrics = vorbisField(body, "LYRICS");
    if (lyrics) out.lyrics = lyrics;
    return out;
}

function buildVorbisComment(merged: IAudioTags): Buffer {
    const fields: string[] = [];
    const add = (k: string, v?: string) => {
        if (v) fields.push(`${k}=${v}`);
    };
    add("TITLE", merged.title);
    // Vorbis 惯例：多艺术家 = 多个 ARTIST 字段（比单字段塞分隔符更标准）
    for (const artist of merged.artists ?? []) {
        add("ARTIST", artist);
    }
    add("ALBUM", merged.album);
    add("DATE", merged.year);
    add("GENRE", merged.genre);
    if (merged.trackNo) add("TRACKNUMBER", String(merged.trackNo));
    add("LYRICS", merged.lyrics);
    return Buffer.concat([vorbisString("MusicFreeDesktop"), le32(fields.length), ...fields.map(vorbisString)]);
}

function readFlac(filePath: string): { blocks: IFlacBlock[]; audioOffset: number } | null {
    try {
        const buf = fs.readFileSync(filePath);
        if (buf.subarray(0, 4).toString("latin1") !== "fLaC") {
            return null;
        }
        return parseFlac(buf);
    } catch {
        return null;
    }
}

/**
 * 重写 FLAC 块区：新 VORBIS_COMMENT + 新/旧 PICTURE，保留其余块。
 * - STREAMINFO 不动：FLAC 不在任何地方记「音频字节总长」，帧靠同步码自定位。
 * - SEEKTABLE 丢弃：它记录音频帧的绝对字节偏移，块区长度一变就全错，
 *   而我们无法重算偏移。下载来的文件基本没有这个块，正常路径零代价。
 * tags 没给的字段用旧标签/旧封面兜底；旧 LYRICS 在新歌词缺失时保留。
 */
function rewriteFlac(filePath: string, tags: IAudioTags): boolean {
    const parsed = readFlac(filePath);
    if (!parsed) {
        return false;
    }
    let existing: IFlacExtracted = {};
    let oldPicture: ITagPicture | undefined;
    for (const block of parsed.blocks) {
        if (block.type === 4) {
            existing = extractFlacVorbis(block.body);
        } else if (block.type === 6 && !oldPicture) {
            oldPicture = decodeFlacPicture(block.body) ?? undefined;
        }
    }
    const merged: IAudioTags = {
        title: tags.title || existing.title,
        artists: tags.artists?.length ? tags.artists : existing.artists,
        album: tags.album || existing.album,
        year: tags.year || existing.year,
        genre: tags.genre || existing.genre,
        trackNo: tags.trackNo ?? existing.trackNo,
        lyrics: tags.lyrics ?? existing.lyrics,
        picture: tags.picture ?? oldPicture,
    };

    const vorbis = buildVorbisComment(merged);
    const picture = merged.picture ? buildFlacPicture(merged.picture) : null;
    if (merged.picture && !picture) {
        return false; // 封面格式不认识：整次放弃，不写坏文件
    }

    // 保留 STREAMINFO 之外的其它既有块（PADDING 之类），丢掉 VORBIS/PICTURE/SEEKTABLE 重建
    const keep = parsed.blocks
        .filter((b) => b.type !== 0 && b.type !== 3 && b.type !== 4 && b.type !== 6)
        .map((b) => ({ type: b.type, body: b.body }));
    const streamInfo = parsed.blocks.find((b) => b.type === 0);
    if (!streamInfo) {
        return false;
    }

    // 块序：STREAMINFO 必须第一，其余在 PICTURE/VORBIS 之前
    const ordered = [{ type: 0, body: streamInfo.body }, ...keep];
    if (picture) {
        ordered.push({ type: 6, body: picture });
    }
    ordered.push({ type: 4, body: vorbis });

    const chunk: Buffer[] = [Buffer.from("fLaC", "latin1")];
    ordered.forEach((b, i) => {
        const header = Buffer.allocUnsafe(4);
        header[0] = (i === ordered.length - 1 ? 0x80 : 0) | b.type;
        header[1] = (b.body.length >> 16) & 0xff;
        header[2] = (b.body.length >> 8) & 0xff;
        header[3] = b.body.length & 0xff;
        chunk.push(header, b.body);
    });
    const fileBuf = fs.readFileSync(filePath);
    chunk.push(fileBuf.subarray(parsed.audioOffset));
    fs.writeFileSync(filePath, Buffer.concat(chunk));
    return true;
}

// ---------- 统一入口 ----------

/**
 * 写标签（原地替换）。mp3→ID3v2.3（含 USLT/APIC），flac→Vorbis Comment+PICTURE。
 * 其余格式（m4a/wav/ogg…）不碰，返回 false，由调用方决定是否退而写 .lrc。
 */
export function writeTags(filePath: string, tags: IAudioTags): boolean {
    const kind = sniffKind(filePath);
    if (kind === "mp3") {
        return rewriteMp3(filePath, tags);
    }
    if (kind === "flac") {
        return rewriteFlac(filePath, tags);
    }
    return false;
}

/** 读内嵌歌词（USLT / LYRICS / FLAC PICTURE description 的 base64 老格式不管——那是畸形样本，别惯着） */
export function readEmbeddedLyrics(filePath: string): string | null {
    const kind = sniffKind(filePath);
    if (kind === "mp3") {
        const tag = readMp3Tag(filePath);
        return tag?.extracted.uslt?.trim() || null;
    }
    if (kind === "flac") {
        const parsed = readFlac(filePath);
        if (!parsed) {
            return null;
        }
        for (const block of parsed.blocks) {
            if (block.type === 4) {
                const lyrics = vorbisField(block.body, "LYRICS");
                if (lyrics?.trim()) {
                    return lyrics;
                }
            }
        }
        return null;
    }
    return null;
}

/** 读内嵌封面（列表 artwork 短链失效时的兜底） */
export function readEmbeddedPicture(filePath: string): ITagPicture | null {
    const kind = sniffKind(filePath);
    if (kind === "mp3") {
        const tag = readMp3Tag(filePath);
        return tag?.extracted.picture ?? null;
    }
    if (kind === "flac") {
        const parsed = readFlac(filePath);
        if (!parsed) {
            return null;
        }
        for (const block of parsed.blocks) {
            if (block.type === 6) {
                const pic = decodeFlacPicture(block.body);
                if (pic) {
                    return pic;
                }
            }
        }
    }
    return null;
}
