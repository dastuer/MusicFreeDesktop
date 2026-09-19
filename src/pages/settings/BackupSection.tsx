import React, { useCallback, useEffect, useState } from "react";
import Icon from "@/components/base/Icon";
import { showToast } from "@/components/base/Toast";
import { showPrompt } from "@/components/base/PromptDialog";
import {
    IBackupStatus,
    IWebdavConfig,
    RESUME_MODE_OPTIONS,
    ResumeMode,
    describeResumeSummary,
    exportBackupToLocal,
    exportBackupToWebdav,
    getBackupStatus,
    getResumeMode,
    getWebdavConfig,
    importBackupFromLocal,
    importBackupFromUrl,
    importBackupFromWebdav,
    setResumeMode,
    setWebdavConfig,
    testWebdav,
} from "@/core/backup";

/**
 * 设置页「备份与恢复」。
 *
 * 交互参考 MusicFree 移动端：恢复模式 + 本地备份/恢复 + URL 恢复 + WebDAV。
 * 桌面端差异：
 * - 本地备份/恢复走系统保存、打开对话框，不再需要自己找文件夹；
 * - 备份内容为歌单、音源、本地音乐索引与界面偏好，
 *   但**不含**最近播放、WebDAV 密码和下载任务；
 * - 每个恢复动作都先弹原生确认框，写明当前恢复模式会做什么。
 */

function formatTime(ts: number | null): string {
    if (!ts) {
        return "还没有备份过";
    }
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
        d.getHours(),
    )}:${pad(d.getMinutes())}`;
}

export default function BackupSection() {
    const [status, setStatus] = useState<IBackupStatus | null>(null);
    const [mode, setMode] = useState<ResumeMode>(getResumeMode());
    const [includeLocalMusic, setIncludeLocalMusic] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);

    const [webdavOpen, setWebdavOpen] = useState(false);
    const [webdavDraft, setWebdavDraft] = useState<IWebdavConfig>({
        url: "",
        username: "",
        password: "",
        filePath: "",
    });
    const [savingWebdav, setSavingWebdav] = useState(false);

    const refresh = useCallback(async () => {
        try {
            setStatus(await getBackupStatus());
        } catch {
            // 读取失败保持上一次状态，不打扰用户
        }
    }, []);

    useEffect(() => {
        refresh();
        getWebdavConfig()
            .then(setWebdavDraft)
            .catch(() => undefined);
    }, [refresh]);

    const counts = status?.counts;
    const webdavReady = !!(
        webdavDraft.url &&
        webdavDraft.username &&
        webdavDraft.password
    );

    /** 统一的忙碌包装：同一次只允许一个备份/恢复动作 */
    const run = async (tag: string, task: () => Promise<void>) => {
        if (busy) {
            return;
        }
        setBusy(tag);
        try {
            await task();
        } catch (e: any) {
            showToast(`操作失败：${e?.message ?? String(e)}`);
        } finally {
            setBusy(null);
            await refresh();
        }
    };

    const collectOptions = { includeLocalMusic };

    const backupToLocal = () =>
        run("backup-local", async () => {
            const res = await exportBackupToLocal(collectOptions);
            if (res.canceled) {
                return;
            }
            if (!res.success) {
                showToast(`备份失败：${res.message ?? "未知错误"}`);
                return;
            }
            showToast(`已导出备份${res.sizeText ? `（${res.sizeText}）` : ""}`);
        });

    const restoreFromLocal = () =>
        run("restore-local", async () => {
            const res = await importBackupFromLocal(mode);
            if (res.canceled || !res.summary) {
                return;
            }
            showToast(describeResumeSummary(res.summary));
        });

    const restoreFromUrl = () =>
        showPrompt({
            title: "从 URL 恢复",
            placeholder: "https://example.com/backup.json",
            confirmText: "下载并恢复",
            onConfirm: (url) =>
                run("restore-url", async () => {
                    const res = await importBackupFromUrl(url.trim(), mode);
                    if (res.canceled || !res.summary) {
                        return;
                    }
                    showToast(describeResumeSummary(res.summary));
                }),
        });

    const saveWebdav = async () => {
        setSavingWebdav(true);
        try {
            const saved = await setWebdavConfig(webdavDraft);
            setWebdavDraft(saved);
            showToast("WebDAV 设置已保存");
            await refresh();
        } catch (e: any) {
            showToast(`保存失败：${e?.message ?? String(e)}`);
        } finally {
            setSavingWebdav(false);
        }
    };

    const testConnection = () =>
        run("webdav-test", async () => {
            const res = await testWebdav();
            if (res.success) {
                showToast("连接成功");
            } else {
                showToast(`连接失败：${res.message ?? "未知错误"}`);
            }
        });

    const backupToWebdav = () =>
        run("backup-webdav", async () => {
            const res = await exportBackupToWebdav(collectOptions);
            if (res.success) {
                showToast(`已上传到 ${res.remotePath ?? "WebDAV"}`);
            } else {
                showToast(`备份失败：${res.message ?? "未知错误"}`);
            }
        });

    const restoreFromWebdav = () =>
        run("restore-webdav", async () => {
            const res = await importBackupFromWebdav(mode);
            if (res.canceled || !res.summary) {
                return;
            }
            showToast(describeResumeSummary(res.summary));
        });

    return (
        <div className="settings-group">
            <div className="settings-group-title">备份与恢复</div>

            <div className="backup-panel">
                <div className="backup-summary">
                    <div style={{ minWidth: 0 }}>
                        <div className="cache-summary-label">本机数据</div>
                        <div className="backup-counts">
                            {counts
                                ? `${counts.sheets} 个歌单 · ${counts.plugins} 个音源`
                                : "读取中…"}
                        </div>
                        <div className="cache-calc-hint">
                            {counts
                                ? `${counts.songs} 首歌曲 · 本地音乐 ${counts.localMusic} 首`
                                : ""}
                        </div>
                        <div className="cache-calc-hint">
                            上次备份：{formatTime(status?.lastAt ?? null)}
                            {status?.lastTarget === "webdav"
                                ? "（WebDAV）"
                                : status?.lastTarget === "local"
                                  ? "（本地文件）"
                                  : ""}
                        </div>
                    </div>
                    <div className="cache-actions">
                        <button
                            className="btn-primary"
                            disabled={!!busy}
                            onClick={backupToLocal}
                        >
                            <Icon name="backup" size={14} />
                            {busy === "backup-local" ? "备份中…" : "备份到本地"}
                        </button>
                        <button
                            className="btn-ghost"
                            disabled={!!busy}
                            onClick={restoreFromLocal}
                        >
                            <Icon name="restore" size={14} />
                            {busy === "restore-local" ? "恢复中…" : "从本地恢复"}
                        </button>
                    </div>
                </div>

                <div className="backup-options">
                    <label className="backup-check">
                        <input
                            type="checkbox"
                            checked={includeLocalMusic}
                            onChange={(e) => setIncludeLocalMusic(e.target.checked)}
                        />
                        包含本地音乐索引
                    </label>
                </div>
            </div>

            <div className="settings-item">
                <div style={{ minWidth: 0 }}>
                    <div className="settings-item-label">恢复模式</div>
                    <div className="settings-item-desc">
                        {RESUME_MODE_OPTIONS.find((it) => it.value === mode)?.desc ?? ""}
                    </div>
                </div>
                <div className="segment" style={{ flexShrink: 0 }}>
                    {RESUME_MODE_OPTIONS.map((option) => (
                        <button
                            key={option.value}
                            className={`segment-item${mode === option.value ? " active" : ""}`}
                            onClick={() => {
                                setMode(option.value);
                                setResumeMode(option.value);
                            }}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="settings-item">
                <div style={{ minWidth: 0 }}>
                    <div className="settings-item-label">从 URL 恢复</div>
                    <div className="settings-item-desc">
                        填入备份文件的直链，由主进程下载后恢复（不受跨域限制）
                    </div>
                </div>
                <button
                    className="btn-ghost"
                    style={{ flexShrink: 0 }}
                    disabled={!!busy}
                    onClick={restoreFromUrl}
                >
                    {busy === "restore-url" ? "恢复中…" : "输入地址"}
                </button>
            </div>

            <div className="settings-item">
                <div style={{ minWidth: 0 }}>
                    <div className="settings-item-label">
                        <Icon name="cloud" size={14} style={{ marginRight: 6 }} />
                        WebDAV
                    </div>
                    <div
                        className="settings-item-desc"
                        style={{ wordBreak: "break-all", whiteSpace: "normal" }}
                    >
                        {webdavReady
                            ? `已配置 · 远端文件 ${status?.webdavFile ?? ""}`
                            : "配置后可把备份同步到坚果云、Nextcloud 等 WebDAV 服务"}
                    </div>
                </div>
                <div className="cache-actions">
                    {webdavReady ? (
                        <button
                            className="btn-ghost"
                            disabled={!!busy}
                            onClick={testConnection}
                        >
                            {busy === "webdav-test" ? "测试中…" : "测试连接"}
                        </button>
                    ) : null}
                    <button
                        className="btn-ghost"
                        disabled={savingWebdav}
                        onClick={async () => {
                            if (!webdavOpen) {
                                // 展开前先取一次最新配置，避免显示过期的草稿
                                try {
                                    setWebdavDraft(await getWebdavConfig());
                                } catch {
                                    // 拿不到就用当前草稿
                                }
                            }
                            setWebdavOpen((v) => !v);
                        }}
                    >
                        {webdavOpen ? "收起" : "设置"}
                    </button>
                </div>
            </div>

            {webdavOpen ? (
                <div className="backup-form">
                    <div className="backup-field">
                        <div className="backup-field-label">服务器地址</div>
                        <input
                            className="text-input"
                            style={{ width: "100%" }}
                            placeholder="https://dav.jianguoyun.com/dav/"
                            value={webdavDraft.url}
                            onChange={(e) =>
                                setWebdavDraft((prev) => ({ ...prev, url: e.target.value }))
                            }
                        />
                    </div>
                    <div className="backup-field">
                        <div className="backup-field-label">用户名</div>
                        <input
                            className="text-input"
                            style={{ width: "100%" }}
                            value={webdavDraft.username}
                            onChange={(e) =>
                                setWebdavDraft((prev) => ({ ...prev, username: e.target.value }))
                            }
                        />
                    </div>
                    <div className="backup-field">
                        <div className="backup-field-label">密码 / 应用密码</div>
                        <input
                            className="text-input"
                            type="password"
                            style={{ width: "100%" }}
                            value={webdavDraft.password}
                            onChange={(e) =>
                                setWebdavDraft((prev) => ({ ...prev, password: e.target.value }))
                            }
                        />
                    </div>
                    <div className="backup-field">
                        <div className="backup-field-label">远端文件路径（可留空）</div>
                        <input
                            className="text-input"
                            style={{ width: "100%" }}
                            placeholder="/MusicFree/MusicFreeDesktopBackup.json"
                            value={webdavDraft.filePath}
                            onChange={(e) =>
                                setWebdavDraft((prev) => ({ ...prev, filePath: e.target.value }))
                            }
                        />
                    </div>
                    <div className="backup-field-actions">
                        <button
                            className="btn-primary"
                            disabled={savingWebdav}
                            onClick={saveWebdav}
                        >
                            {savingWebdav ? "保存中…" : "保存"}
                        </button>
                        <span className="cache-calc-hint">
                            密码仅保存在本机，不会写进备份文件
                        </span>
                    </div>
                </div>
            ) : null}

            <div className="settings-item">
                <div style={{ minWidth: 0 }}>
                    <div className="settings-item-label">同步到 WebDAV</div>
                    <div className="settings-item-desc">
                        将当前数据上传覆盖远端备份文件
                    </div>
                </div>
                <div className="cache-actions">
                    <button
                        className="btn-primary"
                        disabled={!!busy || !webdavReady}
                        onClick={backupToWebdav}
                    >
                        {busy === "backup-webdav" ? "上传中…" : "立即备份"}
                    </button>
                    <button
                        className="btn-ghost"
                        disabled={!!busy || !webdavReady}
                        onClick={restoreFromWebdav}
                    >
                        {busy === "restore-webdav" ? "恢复中…" : "从云端恢复"}
                    </button>
                </div>
            </div>

            <div className="backup-note">
                备份内容：歌单（含「我喜欢的音乐」）、音源插件及其用户变量、界面偏好
                {includeLocalMusic ? "、本地音乐索引" : ""}。
                <br />
                不含：最近播放（历史不参与备份，恢复也不会改动本机历史）、下载任务、
                已缓存的音频与封面、WebDAV 密码。本地音乐的音频文件不在备份内，
                恢复后如果文件换了位置需要重新扫描。
            </div>
        </div>
    );
}
