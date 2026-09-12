import fs from "fs";
import path from "path";
import * as musicMetadata from "music-metadata";
import configStoreInstance from "./configStore";
import coverCache, {
    COVER_URL_PREFIX,
    coverFileNameFromArtwork,
    coverMimeOf,
    isLegacyCoverFileName,
    isOversizedDataUrl,
    sniffImageMime,
} from "./coverCache";

const { parseFile } = musicMetadata as any;

/**
 * 本地音乐扫描：遍历文件夹中的音频文件，解析 ID3 / FLAC 元数据与内嵌封面
 *
 * 封面不内联：扫描时压成缩略图落到 data/covers，musicItem.artwork 只存 mfs://cover 短链。
 * 具体原因见 coverCache.ts 顶部注释。
 */
const AUDIO_EXTS = [".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".wma", ".ape"];

/**
 * 解析元数据的并发上限。
 * 不能无条件 Promise.all：一万首歌会同时打开一万个文件句柄，直接触发 EMFILE。
 */
const PARSE_CONCURRENCY = 8;

/**
 * 隐藏文件/目录判定，统一走这一处：
 *  - dot 文件与 dot 目录：.DS_Store、.hidden.mp3、.Trashes
 *  - macOS AppleDouble 资源分叉：._song.mp3（同样以 . 开头，被上面覆盖）
 * 注意 path.extname(".hidden") 返回空串，所以只在文件名层面判断不可靠
 */
function isHidden(name: string) {
    return name.startsWith(".");
}

class LocalMusicService {
    private configStore!: typeof configStoreInstance;
    /** 本轮扫描引用到的封面文件，扫描结束后用来清理孤儿 */
    private referencedCovers = new Set<string>();

    setup(configStore: typeof configStoreInstance, dataDir: string) {
        this.configStore = configStore;
        coverCache.setup(dataDir);
    }

    /** 封面缓存目录，交给 mfs 协议读取 */
    getCoverDir() {
        return coverCache.getDir();
    }

    async scan(folderPath: string): Promise<any[]> {
        const filePaths: string[] = [];
        await this.collectAudioFiles(folderPath, filePaths);
        this.referencedCovers = new Set();
        await coverCache.ensureDir();
        const list = await this.parseAll(filePaths);
        // 清掉上一轮扫描留下的、本轮没人引用的封面文件
        await coverCache.pruneLocal(this.referencedCovers);
        return list;
    }

    /**
     * 历史数据瘦身：早期版本把封面 base64 直接内联在 artwork 里，
     * 上千首歌能让 store.json 膨胀到几百 MB —— 启动解析慢，每次 set 重写更慢。
     * 启动时把这类内联封面解码写盘、换成短链，只做一次。
     * 不做这一步的话，老用户即使升级了代码，已有的巨型列表还是会把界面拖垮。
     */
    async migrateLegacyArtwork(): Promise<number> {
        const list = this.getSavedMusicList();
        if (!Array.isArray(list) || !list.length) {
            return 0;
        }
        const legacy = list.filter(
            (it: any) => typeof it?.artwork === "string" && it.artwork.startsWith("data:"),
        );
        if (!legacy.length) {
            return 0;
        }
        await coverCache.ensureDir();
        let migrated = 0;
        for (const it of legacy) {
            // 大图落盘换短链；小图（内置示例曲目的 SVG 等）留着更省事
            if (!isOversizedDataUrl(it.artwork)) {
                continue;
            }
            const link = await coverCache.putDataUrl(it.artwork);
            if (link) {
                it.artwork = link;
            } else {
                it.artwork = "";
            }
            migrated += 1;
        }
        if (migrated) {
            this.saveMusicList(list);
        }
        return migrated;
    }

    /**
     * 播放历史瘦身：历史条目里同样会残留插件塞的大体积 base64 封面
     * （observed：migu 音源返回 13 MB 的 PNG，播放一次就写一次 store.json）。
     * 能对上现役本地音乐的，换成封面短链；否则直接丢掉封面。
     */
    async migrateHistoryArtwork(): Promise<number> {
        const history = this.configStore.get("musicHistory", []);
        if (!Array.isArray(history) || !history.length) {
            return 0;
        }
        const localList = this.getSavedMusicList();
        let migrated = 0;
        for (const it of history) {
            if (!isOversizedDataUrl(it?.artwork)) {
                continue;
            }
            const local = it.localPath
                ? localList.find((x: any) => x.localPath === it.localPath)
                : null;
            const link = local
                ? coverFileNameFromArtwork(local.artwork)
                    ? local.artwork
                    : null
                : await coverCache.putDataUrl(it.artwork);
            it.artwork = link ?? "";
            migrated += 1;
        }
        if (migrated) {
            this.configStore.set("musicHistory", history);
        }
        return migrated;
    }

    /**
     * 封面文件整理：中间版本把封面原图直接落盘了（实测 122 首 = 442 MB 的 PNG，
     * 3.7 MB/首），而且用裸 md5 命名。这里把它们压成 320px 缩略图、改成 local- 前缀，
     * 同步更新列表里的 artwork，并删掉旧文件。
     * key 用「路径 + mtime」——和 scan 完全一致，所以之后再扫描会直接命中这些文件。
     * 最后按当前列表引用清一遍孤儿：不等用户重新扫描也能把历史垃圾丢掉。
     */
    async migrateLegacyCoverFiles(): Promise<number> {
        const list = this.getSavedMusicList();
        if (!Array.isArray(list) || !list.length) {
            return 0;
        }
        const targets = list.filter((it: any) => {
            const name = coverFileNameFromArtwork(it.artwork);
            return !!name && isLegacyCoverFileName(name);
        });

        let migrated = 0;
        const toDelete = new Set<string>();
        if (targets.length) {
            await coverCache.ensureDir();
            for (const it of targets) {
                const oldName = coverFileNameFromArtwork(it.artwork)!;
                const oldFile = path.join(coverCache.getDir(), oldName);
                let bytes: Buffer;
                try {
                    bytes = await fs.promises.readFile(oldFile);
                } catch {
                    continue; // 文件已不在，交给协议层 404 兜底
                }
                const mime = sniffImageMime(bytes) || coverMimeOf(oldName);
                let key = `legacy:${oldName}`;
                if (it.localPath) {
                    try {
                        const stat = await fs.promises.stat(it.localPath);
                        key = `${it.localPath}:${Math.round(stat.mtimeMs)}`;
                    } catch {
                        // 源文件不在了，保留 legacy key
                    }
                }
                const newName = await coverCache.putCover("local", key, bytes, mime);
                if (!newName) {
                    continue;
                }
                it.artwork = COVER_URL_PREFIX + newName;
                if (newName !== oldName) {
                    toDelete.add(oldName);
                }
                migrated += 1;
            }
            this.saveMusicList(list);
        }

        for (const name of toDelete) {
            await coverCache.remove(name);
        }

        // 按列表当前引用对账，清掉没人引用的本地封面（含老格式裸 md5）
        const referenced = new Set<string>();
        for (const it of this.getSavedMusicList()) {
            const name = coverFileNameFromArtwork(it.artwork);
            if (name) {
                referenced.add(name);
            }
        }
        const pruned = await coverCache.pruneLocal(referenced);
        if (pruned) {
            console.log(`[localMusic] 清理未引用的封面文件 ${pruned} 个`);
        }
        return migrated;
    }

    /**
     * 递归收集音频文件路径。
     * 用异步 readdir 而不是 readdirSync：扫描发生在主进程，同步遍历大目录会
     * 阻塞事件循环，整个应用（含播放）都会卡住。
     */
    private async collectAudioFiles(dir: string, out: string[]): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            // 无权限 / 目录已删除：跳过整棵子树，不影响其余目录
            return;
        }
        for (const entry of entries) {
            if (isHidden(entry.name)) {
                continue;
            }
            if (entry.isDirectory()) {
                await this.collectAudioFiles(path.join(dir, entry.name), out);
                continue;
            }
            // 符号链接的 isDirectory() 为 false，因此不会递归进软链目录，天然避免成环
            const ext = path.extname(entry.name).toLowerCase();
            if (AUDIO_EXTS.includes(ext)) {
                out.push(path.join(dir, entry.name));
            }
        }
    }

    /** 限量并发解析，结果按下标回填，保证与文件遍历顺序一致 */
    private async parseAll(filePaths: string[]): Promise<any[]> {
        const results: any[] = new Array(filePaths.length);
        let cursor = 0;
        const worker = async () => {
            while (cursor < filePaths.length) {
                const index = cursor;
                cursor += 1;
                results[index] = await this.buildMusicItem(filePaths[index]);
            }
        };
        const workerCount = Math.min(PARSE_CONCURRENCY, filePaths.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
        return results;
    }

    private async buildMusicItem(localPath: string) {
        const base = path.basename(localPath, path.extname(localPath));
        const musicItem: any = {
            id: localPath,
            platform: "本地音乐",
            title: base,
            artist: "未知歌手",
            album: "未知专辑",
            duration: 0,
            artwork: "",
            localPath,
        };
        try {
            const meta = await parseFile(localPath, { duration: true });
            if (meta.common.title) {
                musicItem.title = meta.common.title;
            }
            if (meta.common.artist) {
                musicItem.artist = meta.common.artist;
            }
            if (meta.common.album) {
                musicItem.album = meta.common.album;
            }
            musicItem.duration = meta.format.duration ?? 0;
            const cover = meta.common.picture?.[0];
            if (cover?.data) {
                const fileName = await this.cacheCover(localPath, cover);
                if (fileName) {
                    musicItem.artwork = COVER_URL_PREFIX + fileName;
                }
            }
        } catch {
            // 解析失败时保留文件名占位
        }
        return musicItem;
    }

    /**
     * 把内嵌封面压成缩略图后落盘，返回文件名。
     * key 用「路径 + mtime」：同一个文件重复扫描得到同一个文件名（幂等），
     * 文件换封面后 mtime 变化会生成新文件，不会读到旧图。
     */
    private async cacheCover(
        localPath: string,
        cover: { format?: string; data: Uint8Array },
    ): Promise<string | null> {
        let mtimeMs = 0;
        try {
            mtimeMs = (await fs.promises.stat(localPath)).mtimeMs;
        } catch {
            // 拿不到 stat 不致命，退回只按路径哈希
        }
        const fileName = await coverCache.putCover(
            "local",
            `${localPath}:${Math.round(mtimeMs)}`,
            cover.data,
            String(cover.format ?? "").toLowerCase(),
        );
        if (fileName) {
            this.referencedCovers.add(fileName);
        }
        return fileName;
    }

    getSavedMusicList(): any[] {
        return this.configStore.get("localMusic.list", []);
    }

    saveMusicList(list: any[]) {
        this.configStore.set("localMusic.list", list);
    }

    /**
     * 当前播放歌曲用：把封面文件读成 base64 data URL。
     * macOS 控制中心 / 触控栏取不到 mfs:// 自定义协议，只能给 data URL。
     * 只对「正在播放的这一首」调用，不会拖累整个列表。
     */
    readCover(localPath: string): string | null {
        try {
            const list = this.getSavedMusicList();
            const found = list.find((it: any) => it.localPath === localPath);
            const name = coverFileNameFromArtwork(found?.artwork);
            return name ? coverCache.readAsDataUrl(name) : null;
        } catch {
            return null;
        }
    }

    /** 删除本地音乐文件并从已保存列表移除，返回成功删除的数量（-1 表示用户取消） */
    async deleteMusic(localPaths: string[]): Promise<number> {
        const pathSet = new Set(localPaths);
        const list = this.getSavedMusicList();
        const remaining: any[] = [];
        for (const it of list) {
            if (pathSet.has(it.localPath)) {
                // 顺手删掉它的封面缓存，避免残留孤儿文件
                const name = coverFileNameFromArtwork(it.artwork);
                if (name) {
                    await coverCache.remove(name);
                }
            } else {
                remaining.push(it);
            }
        }
        let deleted = 0;
        for (const p of localPaths) {
            try {
                await fs.promises.unlink(p);
                deleted += 1;
            } catch (e: any) {
                if (e?.code !== "ENOENT") {
                    throw e;
                }
                deleted += 1; // 文件本来就不存在，视为已删除
            }
        }
        this.saveMusicList(remaining);
        return deleted;
    }
}

export default new LocalMusicService();
