import React, { useEffect, useState } from "react";
import MediaHeader from "@/components/base/MediaHeader";
import MusicList from "@/components/base/MusicList";
import { ipcInvoke } from "@/core/ipc";
import { TrackPlayerSingleton } from "@/core/trackPlayer";
import { showToast } from "@/components/base/Toast";

/**
 * 本地音乐：选择文件夹扫描，播放本地文件
 */

export default function LocalMusicPage() {
    const [musicList, setMusicList] = useState<IMusic.IMusicItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [folder, setFolder] = useState<string>("");

    const refresh = () => {
        ipcInvoke("localMusic:getSavedMusicList").then((list) => {
            setMusicList(list ?? []);
        });
    };

    useEffect(() => {
        refresh();
    }, []);

    const pickAndScan = async () => {
        const folderPath = await ipcInvoke("localMusic:pickFolder");
        if (!folderPath) {
            return;
        }
        setFolder(folderPath);
        setLoading(true);
        const result = await ipcInvoke("localMusic:scan", folderPath);
        if (result?.success) {
            setMusicList(result.data);
            // 持久化（去掉 base64 封面）
            await ipcInvoke("config:set", "localMusic.list", result.data);
            showToast(`已找到 ${result.data.length} 首本地音乐`);
        } else {
            showToast(`扫描失败：${result?.message ?? "未知错误"}`);
        }
        setLoading(false);
    };

    return (
        <div>
            <MediaHeader
                artwork={musicList[0]?.artwork}
                title="本地音乐"
                description={folder || "扫描本地文件夹中的音乐文件（mp3 / flac / wav / m4a 等）"}
                musicList={musicList}
                meta={[musicList.length ? `共 ${musicList.length} 首` : ""].filter(Boolean)}
                extraActions={
                    <button className="btn-ghost" onClick={pickAndScan}>
                        选择文件夹扫描
                    </button>
                }
            />
            <MusicList
                musicList={musicList}
                loading={loading}
                isEnd
                localMode
                onMusicChanged={refresh}
            />
        </div>
    );
}
