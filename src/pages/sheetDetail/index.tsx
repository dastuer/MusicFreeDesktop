import React, { useCallback, useEffect, useState } from "react";
import MediaHeader from "@/components/base/MediaHeader";
import MusicList from "@/components/base/MusicList";
import Icon from "@/components/base/Icon";
import { getPluginByMedia, pluginCall } from "@/core/ipc";
import {
    LIKES_SHEET_ID,
    deleteSheet,
    getSheetById,
    removeMusicFromSheet,
    renameSheet,
} from "@/core/musicSheet";
import { showAddToSheetPanel } from "@/components/base/AddToSheetPanel";
import { showDownloadPanel } from "@/components/base/DownloadPanel";
import { showPrompt } from "@/components/base/PromptDialog";
import { showToast } from "@/components/base/Toast";
import { navigate } from "@/core/router";

/**
 * 歌单详情页：
 *  - 插件歌单（params.sheetItem）：getMusicSheetInfo 分页加载
 *  - 本地歌单 / 我喜欢的音乐（params.userSheetId）：主进程持久化，支持管理操作
 */

interface ISheetDetailPageProps {
    sheetItem?: IMusic.IMusicSheetItem;
    userSheetId?: string;
}

export default function SheetDetailPage(props: ISheetDetailPageProps) {
    const { sheetItem, userSheetId } = props;
    const [title, setTitle] = useState(sheetItem?.title ?? "歌单");
    const [artwork, setArtwork] = useState(sheetItem?.artwork ?? "");
    const [musicList, setMusicList] = useState<IMusic.IMusicItem[]>([]);
    const [description, setDescription] = useState("");
    const [loading, setLoading] = useState(false);
    const [page, setPage] = useState(1);
    const [isEnd, setIsEnd] = useState(true);
    const [pluginName, setPluginName] = useState("");

    const isUserSheet = !!userSheetId;
    const isLikesSheet = userSheetId === LIKES_SHEET_ID;

    const loadUserSheet = useCallback(async () => {
        if (!userSheetId) {
            return;
        }
        const sheet = await getSheetById(userSheetId);
        if (sheet) {
            setTitle(sheet.title);
            setMusicList(sheet.musicList);
            // 歌单封面取第一首歌的封面
            setArtwork(sheet.musicList[0]?.artwork ?? "");
            setDescription(
                sheet.id === LIKES_SHEET_ID
                    ? "红心喜欢的歌曲都会收藏在这里"
                    : `创建于 ${new Date(sheet.createAt).toLocaleDateString("zh-CN")}`,
            );
        }
    }, [userSheetId]);

    useEffect(() => {
        (async () => {
            if (userSheetId) {
                setIsEnd(true);
                await loadUserSheet();
                return;
            }
            if (!sheetItem) {
                return;
            }
            setLoading(true);
            const plugin = await getPluginByMedia(sheetItem);
            if (plugin?.supportedMethods.includes("getMusicSheetInfo")) {
                setPluginName(plugin.name);
                try {
                    const result = await pluginCall(
                        plugin.hash,
                        "getMusicSheetInfo",
                        sheetItem,
                        1,
                    );
                    setTitle(result?.sheetItem?.title ?? sheetItem.title);
                    setArtwork(result?.sheetItem?.artwork ?? sheetItem.artwork);
                    setDescription(result?.sheetItem?.description ?? "");
                    setMusicList((result?.musicList ?? []) as IMusic.IMusicItem[]);
                    setIsEnd(result?.isEnd ?? true);
                    setPage(1);
                } catch (e: any) {
                    showToast(`加载歌单失败：${e?.message ?? e}`);
                }
            }
            setLoading(false);
        })();
    }, [sheetItem?.id, userSheetId]);

    // 用户歌单：定时刷新（在别处喜欢/收藏的歌能自动出现）
    useEffect(() => {
        if (!userSheetId) {
            return;
        }
        const timer = setInterval(loadUserSheet, 3000);
        return () => clearInterval(timer);
    }, [userSheetId, loadUserSheet]);

    const loadMore = async () => {
        if (!sheetItem || loading) {
            return;
        }
        setLoading(true);
        const plugin = await getPluginByMedia(sheetItem);
        if (plugin) {
            try {
                const result = await pluginCall(
                    plugin.hash,
                    "getMusicSheetInfo",
                    sheetItem,
                    page + 1,
                );
                setMusicList((prev) => [
                    ...prev,
                    ...((result?.musicList ?? []) as IMusic.IMusicItem[]),
                ]);
                setIsEnd(result?.isEnd ?? true);
                setPage((p) => p + 1);
            } catch {
                setIsEnd(true);
            }
        }
        setLoading(false);
    };

    const handleRemove = async (musicItem: IMusic.IMusicItem) => {
        await removeMusicFromSheet(userSheetId!, musicItem);
        showToast("已从歌单移除");
        await loadUserSheet();
    };

    const handleRename = () => {
        showPrompt({
            title: "重命名歌单",
            defaultValue: title,
            confirmText: "保存",
            onConfirm: async (newTitle) => {
                await renameSheet(userSheetId!, newTitle);
                setTitle(newTitle);
                showToast("已重命名");
            },
        });
    };

    const handleDelete = async () => {
        await deleteSheet(userSheetId!);
        showToast(`已删除「${title}」`);
        navigate("home");
    };

    return (
        <div>
            <MediaHeader
                artwork={artwork}
                title={title}
                description={description}
                musicList={musicList}
                meta={[
                    pluginName ? `来源：${pluginName}` : "",
                    musicList.length ? `共 ${musicList.length} 首` : "",
                ].filter(Boolean)}
                extraActions={
                    <>
                        {musicList.length > 0 && (
                            <button
                                className="btn-ghost"
                                onClick={() => showDownloadPanel(musicList)}
                            >
                                <Icon name="download" size={14} />
                                下载全部
                            </button>
                        )}
                        {isUserSheet && !isLikesSheet ? (
                            <>
                                <button className="btn-ghost" onClick={handleRename}>
                                    <Icon name="settings" size={13} />
                                    重命名
                                </button>
                                <button className="btn-ghost" onClick={handleDelete}>
                                    <Icon name="close" size={13} />
                                    删除歌单
                                </button>
                            </>
                        ) : null}
                    </>
                }
            />
            <MusicList
                musicList={musicList}
                loading={loading}
                isEnd={isEnd}
                onLoadMore={loadMore}
                onRemove={isUserSheet ? handleRemove : undefined}
                onMusicChanged={isUserSheet ? loadUserSheet : undefined}
            />
        </div>
    );
}
