import React, { useEffect, useState } from "react";
import Icon from "@/components/base/Icon";
import {
    SerializedPlugin,
    getPlugins,
    ipcInvoke,
    invalidatePluginCache,
} from "@/core/ipc";
import { showContextMenu } from "@/components/base/ContextMenu";
import { showToast } from "@/components/base/Toast";

/**
 * 音源插件管理：安装（本地/URL）、启用禁用、排序、卸载、用户变量
 */

export default function PluginManagePage() {
    const [plugins, setPlugins] = useState<SerializedPlugin[]>([]);
    const [installUrl, setInstallUrl] = useState("");
    const [editingVars, setEditingVars] = useState<string | null>(null);
    const [varDraft, setVarDraft] = useState<Record<string, string>>({});

    const refresh = async () => {
        invalidatePluginCache();
        setPlugins(await getPlugins(true));
    };

    useEffect(() => {
        refresh();
    }, []);

    const installFromFile = async () => {
        // Electron 主进程没有通用文件选择通道，这里通过隐藏 input 选择
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".js";
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) {
                return;
            }
            // 渲染进程拿不到真实路径，改用文本读取后走 URL-less 安装：
            // 将文件内容保存为临时方案 -> 直接读取 file 对象文本并提示拖入
            const text = await file.text();
            const blobUrl = URL.createObjectURL(
                new Blob([text], { type: "text/javascript" }),
            );
            const result = await ipcInvoke("plugin:installFromUrl", blobUrl);
            showToast(result?.success ? `已安装 ${result.pluginName}` : result?.message);
            refresh();
        };
        input.click();
    };

    const installFromUrl = async () => {
        const url = installUrl.trim();
        if (!url) {
            showToast("请输入插件 URL");
            return;
        }
        showToast("正在下载插件…");
        const result = await ipcInvoke("plugin:installFromUrl", url);
        showToast(result?.success ? `已安装 ${result.pluginName}` : result?.message);
        setInstallUrl("");
        refresh();
    };

    const openMenu = (e: React.MouseEvent, plugin: SerializedPlugin) => {
        e.preventDefault();
        // 阻止冒泡：否则 click 会触发 ContextMenuHost 的全局关闭监听，菜单闪现即消失
        e.stopPropagation();
        const items: any[] = [
            {
                title:
                    localStorage.getItem("defaultPluginHash") === plugin.hash
                        ? "取消默认音源"
                        : "设为默认音源",
                icon: "settings",
                onClick: () => {
                    if (localStorage.getItem("defaultPluginHash") === plugin.hash) {
                        localStorage.removeItem("defaultPluginHash");
                        showToast("已取消默认音源");
                    } else {
                        localStorage.setItem("defaultPluginHash", plugin.hash);
                        showToast(`已将「${plugin.name}」设为默认音源`);
                    }
                    refresh();
                },
            },
            {
                title: plugin.enabled ? "禁用" : "启用",
                onClick: async () => {
                    await ipcInvoke("plugin:setEnabled", plugin.hash, !plugin.enabled);
                    refresh();
                },
            },
            {
                title: "上移",
                onClick: async () => {
                    const idx = plugins.findIndex((p) => p.hash === plugin.hash);
                    if (idx > 0) {
                        const hashes = plugins.map((p) => p.hash);
                        [hashes[idx - 1], hashes[idx]] = [hashes[idx], hashes[idx - 1]];
                        await ipcInvoke("plugin:setOrder", hashes);
                        refresh();
                    }
                },
            },
            {
                title: "下移",
                onClick: async () => {
                    const idx = plugins.findIndex((p) => p.hash === plugin.hash);
                    if (idx < plugins.length - 1) {
                        const hashes = plugins.map((p) => p.hash);
                        [hashes[idx + 1], hashes[idx]] = [hashes[idx], hashes[idx + 1]];
                        await ipcInvoke("plugin:setOrder", hashes);
                        refresh();
                    }
                },
            },
            {
                title: "用户变量",
                onClick: () => {
                    setEditingVars(plugin.hash);
                    setVarDraft(plugin.userVariables ?? {});
                },
            },
            {
                title: "卸载",
                danger: true,
                onClick: async () => {
                    await ipcInvoke("plugin:uninstall", plugin.hash);
                    showToast("已卸载");
                    refresh();
                },
            },
        ];
        showContextMenu(e.clientX, e.clientY, items);
    };

    const currentEditing = plugins.find((p) => p.hash === editingVars);

    return (
        <div>
            <div className="section-title">音源插件</div>

            <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
                <input
                    className="text-input"
                    style={{ width: 320 }}
                    placeholder="插件 URL（以 .js 结尾）"
                    value={installUrl}
                    onChange={(e) => setInstallUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && installFromUrl()}
                />
                <button className="btn-primary" onClick={installFromUrl}>
                    <Icon name="plus" size={14} />
                    网络安装
                </button>
                <button className="btn-ghost" onClick={installFromFile}>
                    从文件安装
                </button>
            </div>

            {editingVars && currentEditing && (
                <div
                    style={{
                        border: "1px solid var(--divider)",
                        borderRadius: 10,
                        padding: 16,
                        marginBottom: 16,
                    }}
                >
                    <div style={{ fontWeight: 600, marginBottom: 10 }}>
                        「{currentEditing.name}」用户变量
                    </div>
                    {currentEditing.supportedMethods.length === 0 && (
                        <div className="empty-hint">该插件未定义变量</div>
                    )}
                    {(currentEditing as any).userVariables &&
                    Object.keys(varDraft).length === 0 &&
                    !(currentEditing as any).userVariablesDef?.length
                        ? null
                        : null}
                    {Object.keys(varDraft).map((key) => (
                        <div key={key} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                            <input
                                className="text-input"
                                value={varDraft[key]}
                                onChange={(e) =>
                                    setVarDraft((prev) => ({ ...prev, [key]: e.target.value }))
                                }
                            />
                        </div>
                    ))}
                    <div style={{ display: "flex", gap: 8 }}>
                        <button
                            className="btn-primary"
                            onClick={async () => {
                                await ipcInvoke(
                                    "plugin:setUserVariables",
                                    editingVars,
                                    varDraft,
                                );
                                showToast("已保存");
                                setEditingVars(null);
                                refresh();
                            }}
                        >
                            保存
                        </button>
                        <button className="btn-ghost" onClick={() => setEditingVars(null)}>
                            取消
                        </button>
                    </div>
                    {!Object.keys(varDraft).length && (
                        <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                            该插件未设置用户变量，可在右键菜单中重新打开
                        </div>
                    )}
                </div>
            )}

            {plugins.map((plugin) => (
                <div className="plugin-card" key={plugin.hash} onContextMenu={(e) => openMenu(e, plugin)}>
                    <div className="plugin-card-icon">
                        {plugin.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="plugin-card-info">
                        <div className="plugin-card-name">
                            {plugin.name}
                            {localStorage.getItem("defaultPluginHash") === plugin.hash && (
                                <span className="tag enabled">默认音源</span>
                            )}
                            <span className={`tag ${plugin.enabled ? "enabled" : "disabled"}`}>
                                {plugin.enabled ? "已启用" : "已禁用"}
                            </span>
                        </div>
                        <div className="plugin-card-meta">
                            {plugin.version && `v${plugin.version}`}
                            {plugin.author && ` · ${plugin.author}`}
                            {plugin.srcUrl && (
                                <>
                                    {" · "}
                                    <a
                                        href={plugin.srcUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        style={{ color: "var(--primary-color)" }}
                                    >
                                        项目主页
                                    </a>
                                </>
                            )}
                        </div>
                        <div
                            className="plugin-card-desc"
                            style={{ maxHeight: 40, overflow: "hidden" }}
                            dangerouslySetInnerHTML={{ __html: plugin.description ?? "" }}
                        />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <button
                            className={plugin.enabled ? "btn-ghost" : "btn-primary"}
                            onClick={async () => {
                                await ipcInvoke("plugin:setEnabled", plugin.hash, !plugin.enabled);
                                refresh();
                            }}
                        >
                            {plugin.enabled ? "禁用" : "启用"}
                        </button>
                        <button className="btn-ghost" onClick={(e) => openMenu(e as any, plugin)}>
                            更多
                        </button>
                    </div>
                </div>
            ))}

            {!plugins.length && (
                <div className="empty-hint">
                    还没有安装插件。
                    <br />
                    可以从网络安装（输入插件 js 地址），或从本地文件安装。
                </div>
            )}
        </div>
    );
}
