import { atom, useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";

/**
 * 下载管理（渲染进程状态）
 */

export type DownloadStatus = "pending" | "running" | "completed" | "failed";

export interface IDownloadTask {
    id: string;
    musicItem: {
        id: string;
        platform: string;
        title: string;
        artist: string;
        artwork?: string;
        duration?: number;
    };
    quality: string;
    status: DownloadStatus;
    progress: number;
    filename: string;
    filePath?: string;
    error?: string;
    createdAt: number;
}

export const downloadTasksAtom = atom<IDownloadTask[]>([]);

let subscribed = false;

export function useDownloadSetup() {
    const setTasks = useSetAtom(downloadTasksAtom);

    useEffect(() => {
        refreshDownloadTasks();
        if (!subscribed) {
            subscribed = true;
            window.mfp.onDownloadEvent((data) => {
                if (data?.tasks) {
                    setTasks(data.tasks);
                }
            });
        }
    }, [setTasks]);
}

export async function refreshDownloadTasks(): Promise<IDownloadTask[]> {
    const tasks = (await window.mfp.invoke("download:list")) ?? [];
    return tasks;
}

/** 触发下载（先弹音质选择） */
export async function startDownload(
    items: IMusic.IMusicItem[],
    quality: string,
): Promise<number> {
    const plain = items.map((it) => ({ ...it }));
    return window.mfp.invoke("download:start", plain, quality);
}

export async function retryDownload(taskId: string) {
    await window.mfp.invoke("download:retry", taskId);
}

export async function removeDownload(taskId: string, deleteFile = false) {
    return window.mfp.invoke("download:remove", taskId, deleteFile);
}

export async function clearCompletedDownloads() {
    await window.mfp.invoke("download:clearCompleted");
}

export async function openDownloadInFolder(taskId: string) {
    await window.mfp.invoke("download:openInFolder", taskId);
}
