import React, { useEffect, useState } from "react";
import Icon from "@/components/base/Icon";
import MediaHeader from "@/components/base/MediaHeader";
import MusicList from "@/components/base/MusicList";
import { showLocalMatchPanel } from "@/components/base/LocalMatchPanel";
import { showToast } from "@/components/base/Toast";
import { ipcInvoke } from "@/core/ipc";
import {
    cancelLocalBatchMatch,
    clearLocalBatchMatch,
    localBatchMatchAtom,
    onLocalArtworkUpdated,
} from "@/core/localMusicMatch";
import { useAtomValue } from "jotai";

/**
 * 本地音乐：选择文件夹扫描，播放本地文件
 */

export default function LocalMusicPage() {
    const [musicList, setMusicList] = useState<IMusic.IMusicItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [folder, setFolder] = useState<string>("");
    /** 上次扫描的文件夹（持久化），「刷新」按它重扫；没扫过时为空、不显示刷新按钮 */
    const [savedFolder, setSavedFolder] = useState<string>("");
    /** 多选模式：入口在头部「…」更多菜单里，状态由 MediaHeader 和 MusicList 共享（同歌单/榜单详情页） */
    const [selectMode, setSelectMode] = useState(false);
    /** 批量匹配会话（模块级，离开页面再回来进度还在） */
    const batchMatch = useAtomValue(localBatchMatchAtom);

    const refresh = () => {
        ipcInvoke("localMusic:getSavedMusicList").then((list) => {
            setMusicList(list ?? []);
        });
    };

    useEffect(() => {
        (async () => {
            const saved = (await ipcInvoke("localMusic:getSavedMusicList")) ?? [];
            // 上次扫描的文件夹读出来：头部描述显示路径，「刷新」也知道扫哪里
            const lastFolder = await ipcInvoke("config:get", "localMusic.folder", "");
            if (typeof lastFolder === "string" && lastFolder) {
                setFolder(lastFolder);
                setSavedFolder(lastFolder);
            }
            if (saved.length) {
                setMusicList(saved);
                return;
            }
            // 没有已保存列表时，默认扫描下载目录
            const downloadDir = await ipcInvoke("download:getDir");
            if (!downloadDir) {
                return;
            }
            setFolder(downloadDir);
            setSavedFolder(downloadDir);
            ipcInvoke("config:set", "localMusic.folder", downloadDir);
            setLoading(true);
            const result = await ipcInvoke("localMusic:scan", downloadDir);
            if (result?.success) {
                setMusicList(result.data);
                await ipcInvoke("config:set", "localMusic.list", result.data);
                if (result.data?.length) {
                    showToast(`已从下载目录扫描到 ${result.data.length} 首本地音乐`);
                }
            }
            setLoading(false);
        })();
    }, []);

    // 匹配成功写回封面后，把列表里同一路径的条目原位换图（单曲/批量两个入口都走这里）
    useEffect(
        () =>
            onLocalArtworkUpdated((localPath, artwork) => {
                setMusicList((prev) =>
                    prev.map((it) =>
                        it.localPath === localPath ? { ...it, artwork } : it,
                    ),
                );
            }),
        [],
    );

    // 批量匹配尘埃落定：弹总结、收掉进度条（会话在别的页面跑完也一样）
    useEffect(() => {
        if (!batchMatch || batchMatch.status === "running") {
            return;
        }
        const { status, done, total, matchedCount, skippedCount, missedCount, errorCount } =
            batchMatch;
        if (status === "canceled") {
            showToast(`已取消匹配（已处理 ${done}/${total}）`);
        } else {
            const extra = errorCount ? `，失败 ${errorCount} 首` : "";
            showToast(
                `匹配完成：写入 ${matchedCount} 首，跳过 ${skippedCount} 首，未命中 ${missedCount} 首${extra}`,
            );
        }
        clearLocalBatchMatch();
    }, [batchMatch?.status]);

    const pickAndScan = async () => {
        const folderPath = await ipcInvoke("localMusic:pickFolder");
        if (!folderPath) {
            return;
        }
        setFolder(folderPath);
        setSavedFolder(folderPath);
        ipcInvoke("config:set", "localMusic.folder", folderPath);
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

    /** 刷新：重扫上次选择的文件夹。后端做增量，mtime 没变的直接复用，秒级完成 */
    const refreshScan = async () => {
        if (!savedFolder || loading) {
            return;
        }
        setLoading(true);
        const result = await ipcInvoke("localMusic:rescan", savedFolder);
        if (result?.success) {
            const { list, added, removed, updated } = result.data ?? {};
            setMusicList(list ?? []);
            const changes = [
                added ? `新增 ${added} 首` : "",
                removed ? `移除 ${removed} 首` : "",
                updated ? `更新 ${updated} 首` : "",
            ]
                .filter(Boolean)
                .join("，");
            showToast(changes ? `刷新完成：${changes}` : `列表已是最新，共 ${list?.length ?? 0} 首`);
        } else {
            showToast(`刷新失败：${result?.message ?? "未知错误"}`);
        }
        setLoading(false);
    };

    /** 批量匹配进度条里的计数文案：命中/跳过/未命中（有失败再单独提一句） */
    const batchPct = batchMatch?.total
        ? Math.round((batchMatch.done / batchMatch.total) * 100)
        : 0;
    const batchSub = batchMatch
        ? [
              `已处理 ${batchMatch.done}/${batchMatch.total}`,
              `写入 ${batchMatch.matchedCount}`,
              `跳过 ${batchMatch.skippedCount}`,
              `未命中 ${batchMatch.missedCount}`,
              batchMatch.errorCount ? `失败 ${batchMatch.errorCount}` : "",
          ]
              .filter(Boolean)
              .join(" · ")
        : "";

    return (
        <div>
            <MediaHeader
                artwork={musicList[0]?.artwork}
                title="本地音乐"
                description={folder || "扫描本地文件夹中的音乐文件（mp3 / flac / wav / m4a 等）"}
                musicList={musicList}
                meta={[musicList.length ? `共 ${musicList.length} 首` : ""].filter(Boolean)}
                listId="localMusic"
                moreMenuItems={
                    musicList.length > 0
                        ? [
                              {
                                  title: "批量匹配歌词封面",
                                  icon: "refresh",
                                  onClick: () =>
                                      showLocalMatchPanel({
                                          mode: "batch",
                                          items: musicList,
                                      }),
                              },
                              {
                                  title: "多选",
                                  icon: "check",
                                  onClick: () => setSelectMode(true),
                              },
                          ]
                        : []
                }
                extraActions={
                    <>
                        {savedFolder && (
                            <button
                                className="btn-ghost"
                                disabled={loading}
                                title={`重新扫描 ${savedFolder}`}
                                onClick={refreshScan}
                            >
                                <Icon name="refresh" size={14} />
                                刷新
                            </button>
                        )}
                        <button className="btn-ghost" onClick={pickAndScan}>
                            选择文件夹扫描
                        </button>
                    </>
                }
            />
            {batchMatch && (
                <div className="netease-matching-strip local-matching-strip" role="status">
                    <span className="netease-matching-spin" aria-hidden>
                        <Icon name="musicNote" size={13} />
                    </span>
                    <div className="netease-matching-text">
                        <span className="netease-matching-title">
                            {batchMatch.currentTitle
                                ? `正在匹配：${batchMatch.currentTitle}`
                                : "正在匹配歌词与封面"}
                        </span>
                        <span className="netease-matching-sub">{batchSub}</span>
                    </div>
                    <div className="netease-progress">
                        <div style={{ width: `${batchPct}%` }} />
                    </div>
                    <button className="btn-ghost local-matching-cancel" onClick={cancelLocalBatchMatch}>
                        取消
                    </button>
                </div>
            )}
            <MusicList
                musicList={musicList}
                loading={loading}
                isEnd
                localMode
                searchable
                listId="localMusic"
                selectMode={selectMode}
                onSelectModeChange={setSelectMode}
                onMusicChanged={refresh}
            />
        </div>
    );
}
