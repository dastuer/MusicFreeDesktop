import React, { useEffect, useState } from "react";
import Cover from "@/components/base/Cover";
import Icon from "@/components/base/Icon";
import { showContextMenu } from "@/components/base/ContextMenu";
import { showDownloadPanel } from "@/components/base/DownloadPanel";
import { showToast } from "@/components/base/Toast";
import {
    IDownloadTask,
    clearCompletedDownloads,
    openDownloadInFolder,
    refreshDownloadTasks,
    removeDownload,
    retryDownload,
    useDownloadSetup,
} from "@/core/downloadManager";
import { ipcInvoke } from "@/core/ipc";
import { TrackPlayerSingleton } from "@/core/trackPlayer";

/**
 * 下载管理：队列/进度/已完成文件操作
 */

const qualityLabels: Record<string, string> = {
    low: "低品",
    standard: "标准",
    high: "高清",
    super: "无损",
};

const statusLabels: Record<string, string> = {
    pending: "排队中",
    running: "下载中",
    completed: "已完成",
    failed: "失败",
};

export default function DownloadingPage() {
    useDownloadSetup();
    const [tasks, setTasks] = useState<IDownloadTask[]>([]);
    const [downloadDir, setDownloadDir] = useState("");

    useEffect(() => {
        let mounted = true;
        refreshDownloadTasks().then((t) => mounted && setTasks(t));
        ipcInvoke("download:getDir").then((dir) => mounted && setDownloadDir(dir));
        const timer = setInterval(async () => {
            const t = await refreshDownloadTasks();
            if (mounted) setTasks(t);
        }, 2000);
        window.mfp.onDownloadEvent((data) => {
            if (mounted && data?.tasks) {
                setTasks(data.tasks);
            }
        });
        return () => {
            mounted = false;
            clearInterval(timer);
        };
    }, []);

    const openMenu = (e: React.MouseEvent, task: IDownloadTask) => {
        e.preventDefault();
        const items: any[] = [];
        if (task.status === "completed") {
            items.push(
                {
                    title: "在文件夹中显示",
                    icon: "open",
                    onClick: () => openDownloadInFolder(task.id),
                },
                {
                    title: "播放",
                    icon: "play",
                    onClick: () => {
                        if (task.filePath) {
                            TrackPlayerSingleton.play({
                                ...task.musicItem,
                                localPath: task.filePath,
                                platform: "本地音乐",
                            } as any);
                        }
                    },
                },
                {
                    title: "重新下载",
                    icon: "download",
                    onClick: () => retryDownload(task.id),
                },
            );
        } else if (task.status === "failed") {
            items.push({
                title: "重试",
                icon: "download",
                onClick: () => retryDownload(task.id),
            });
        }
        if (task.status === "completed" && task.filePath) {
            items.push(
                {
                    title: "删除记录",
                    icon: "close",
                    onClick: () => removeDownload(task.id),
                },
                {
                    title: "删除记录和文件",
                    icon: "trash",
                    danger: true,
                    onClick: async () => {
                        const result = await removeDownload(task.id, true);
                        if (!result?.canceled) {
                            showToast(result?.success ? "已删除下载记录和文件" : "删除失败");
                        }
                    },
                },
            );
        } else {
            items.push({
                title: "删除记录",
                icon: "close",
                danger: true,
                onClick: () => removeDownload(task.id),
            });
        }
        showContextMenu(e.clientX, e.clientY, items);
    };

    /** 行内删除：已完成的任务删除记录+文件（原生二次确认），其余仅删除记录 */
    const handleRowDelete = async (task: IDownloadTask) => {
        if (task.status === "completed" && task.filePath) {
            const result = await removeDownload(task.id, true);
            if (!result?.canceled) {
                showToast(result?.success ? "已删除下载记录和文件" : "删除失败");
            }
        } else {
            removeDownload(task.id);
        }
    };

    const activeCount = tasks.filter(
        (t) => t.status === "pending" || t.status === "running",
    ).length;

    return (
        <div>
            <MediaHeaderBar
                count={tasks.length}
                activeCount={activeCount}
                downloadDir={downloadDir}
                onDownloadMore={() => showDownloadPanel([])}
                onClearCompleted={async () => {
                    await clearCompletedDownloads();
                    setTasks(await refreshDownloadTasks());
                    showToast("已清除已完成记录");
                }}
            />

            {tasks.map((task) => (
                <div
                    key={task.id}
                    className="music-row"
                    style={{
                        gridTemplateColumns: "48px 1fr 90px 180px 90px",
                        cursor: task.status === "completed" ? "pointer" : undefined,
                    }}
                    onClick={() => {
                        // 点击已完成任务直接播放本地文件
                        if (task.status === "completed" && task.filePath) {
                            TrackPlayerSingleton.play({
                                ...task.musicItem,
                                localPath: task.filePath,
                                platform: "本地音乐",
                            } as any);
                        }
                    }}
                    onContextMenu={(e) => openMenu(e, task)}
                >
                    <Cover src={task.musicItem.artwork} size={40} borderRadius={6} />
                    <div style={{ minWidth: 0 }}>
                        <div className="music-row-title">{task.musicItem.title}</div>
                        <div className="music-row-artist">{task.musicItem.artist}</div>
                    </div>
                    <div>
                        <span className="tag">{qualityLabels[task.quality] ?? task.quality}</span>
                    </div>
                    <div style={{ minWidth: 0 }}>
                        {task.status === "running" ? (
                            <>
                                <div
                                    style={{
                                        height: 4,
                                        borderRadius: 2,
                                        background: "var(--active-bg)",
                                        overflow: "hidden",
                                    }}
                                >
                                    <div
                                        style={{
                                            width: `${task.progress}%`,
                                            height: "100%",
                                            background: "var(--primary-color)",
                                            transition: "width .3s",
                                        }}
                                    />
                                </div>
                                <div
                                    style={{
                                        fontSize: 11,
                                        color: "var(--text-tertiary)",
                                        marginTop: 2,
                                    }}
                                >
                                    下载中 {task.progress}%
                                </div>
                            </>
                        ) : (
                            <div
                                style={{
                                    fontSize: 12,
                                    color:
                                        task.status === "failed"
                                            ? "#ec4141"
                                            : task.status === "completed"
                                                ? "#34c759"
                                                : "var(--text-tertiary)",
                                }}
                            >
                                {statusLabels[task.status]}
                                {task.error ? ` · ${task.error}` : ""}
                            </div>
                        )}
                    </div>
                    <div
                        style={{
                            display: "flex",
                            gap: 4,
                            justifyContent: "flex-end",
                        }}
                    >
                        {task.status === "failed" && (
                            <Icon
                                name="download"
                                size={16}
                                title="重试"
                                style={{ cursor: "pointer", color: "var(--text-secondary)" }}
                                onClick={() => retryDownload(task.id)}
                            />
                        )}
                        {task.status === "completed" && (
                            <>
                                <Icon
                                    name="play"
                                    size={16}
                                    title="播放"
                                    style={{ cursor: "pointer", color: "var(--text-secondary)" }}
                                    onClick={() => {
                                        if (task.filePath) {
                                            TrackPlayerSingleton.play({
                                                ...task.musicItem,
                                                localPath: task.filePath,
                                                platform: "本地音乐",
                                            } as any);
                                        }
                                    }}
                                />
                                <Icon
                                    name="open"
                                    size={16}
                                    title="在文件夹中显示"
                                    style={{ cursor: "pointer", color: "var(--text-secondary)" }}
                                    onClick={() => openDownloadInFolder(task.id)}
                                />
                            </>
                        )}
                        <Icon
                            name="trash"
                            size={15}
                            title={task.status === "completed" ? "删除记录和文件" : "删除记录"}
                            style={{ cursor: "pointer", color: "var(--text-tertiary)" }}
                            onClick={() => handleRowDelete(task)}
                        />
                    </div>
                </div>
            ))}

            {!tasks.length && (
                <div className="empty-hint">
                    还没有下载任务
                    <div style={{ marginTop: 12, color: "var(--text-tertiary)", fontSize: 12 }}>
                        在歌曲右键菜单或歌单页选择「下载」即可添加任务
                    </div>
                </div>
            )}
        </div>
    );
}

function MediaHeaderBar(props: {
    count: number;
    activeCount: number;
    downloadDir: string;
    onDownloadMore: () => void;
    onClearCompleted: () => void;
}) {
    return (
        <>
            <div className="media-header">
                <div
                    style={{
                        width: 180,
                        height: 180,
                        borderRadius: 10,
                        background: "linear-gradient(135deg, #667eea, #764ba2)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#fff",
                        flexShrink: 0,
                    }}
                >
                    <Icon name="download" size={64} />
                </div>
                <div className="media-header-info">
                    <div className="media-header-title">下载管理</div>
                    <div className="media-header-meta">
                        共 {props.count} 个任务
                        {props.activeCount > 0 ? ` · ${props.activeCount} 个进行中` : ""}
                    </div>
                    <div className="media-header-desc">保存位置：{props.downloadDir || "…"}</div>
                    <div className="media-header-actions">
                        {props.count > 0 && (
                            <button className="btn-ghost" onClick={props.onClearCompleted}>
                                <Icon name="close" size={13} />
                                清除已完成
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </>
    );
}
