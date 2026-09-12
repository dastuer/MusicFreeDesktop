import fs from "fs";
import path from "path";
import * as musicMetadata from "music-metadata";
import configStoreInstance from "./configStore";

const { parseFile } = musicMetadata as any;

/**
 * 本地音乐扫描：遍历文件夹中的音频文件，解析 ID3 / FLAC 元数据与内嵌封面
 */
const AUDIO_EXTS = [".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".wma", ".ape"];

class LocalMusicService {
    private configStore!: typeof configStoreInstance;

    setup(configStore: typeof configStoreInstance) {
        this.configStore = configStore;
    }

    async scan(folderPath: string): Promise<any[]> {
        const musicList: any[] = [];
        const walk = (dir: string) => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!entry.name.startsWith(".")) {
                        walk(fullPath);
                    }
                    continue;
                }
                const ext = path.extname(entry.name).toLowerCase();
                if (AUDIO_EXTS.includes(ext)) {
                    musicList.push(this.buildMusicItem(fullPath));
                }
            }
        };
        walk(folderPath);
        return Promise.all(musicList);
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
                musicItem.$coverData = `data:${cover.format};base64,${Buffer.from(cover.data).toString("base64")}`;
                musicItem.artwork = musicItem.$coverData;
            }
        } catch {
            // 解析失败时保留文件名占位
        }
        return musicItem;
    }

    getSavedMusicList(): any[] {
        return this.configStore.get("localMusic.list", []);
    }

    saveMusicList(list: any[]) {
        // 封面 base64 太大，持久化时去掉，播放时按需读取
        this.configStore.set(
            "localMusic.list",
            list.map((it) => ({ ...it, $coverData: undefined })),
        );
    }

    readCover(localPath: string): string | null {
        try {
            const list = this.getSavedMusicList();
            const found = list.find((it: any) => it.localPath === localPath);
            if (found?.artwork?.startsWith("data:")) {
                return found.artwork;
            }
            return null;
        } catch {
            return null;
        }
    }

    /** 删除本地音乐文件并从已保存列表移除，返回成功删除的数量（-1 表示用户取消） */
    async deleteMusic(localPaths: string[]): Promise<number> {
        const pathSet = new Set(localPaths);
        const list = this.getSavedMusicList();
        const remaining = list.filter((it: any) => !pathSet.has(it.localPath));
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
