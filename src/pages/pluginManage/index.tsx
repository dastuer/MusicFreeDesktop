import React, { useEffect, useRef, useState } from "react";
import Draggable from "react-draggable";
import Icon from "@/components/base/Icon";
import {
    SerializedPlugin,
    SerializedSubscription,
    SubscriptionImportResult,
    getPlugins,
    ipcInvoke,
    invalidatePluginCache,
} from "@/core/ipc";
import { showContextMenu } from "@/components/base/ContextMenu";
import { showToast } from "@/components/base/Toast";
import { showPrompt } from "@/components/base/PromptDialog";

/**
 * 音源插件管理：安装（本地/URL/聚合订阅源）、启用禁用、排序、卸载、用户变量
 */

/** 一次导入只出一条提示；哪些音源没装上要点名，否则用户只能整批重试再等一遍 */
function importToast(result?: SubscriptionImportResult) {
    if (!result?.success) {
        return result?.message ?? "导入失败";
    }
    const parts = [
        `新增 ${result.installed}`,
        `更新 ${result.updated}`,
        `未变 ${result.unchanged}`,
    ];
    if (result.failed.length) {
        const names = result.failed.slice(0, 3).map((f) => f.name).join("、");
        parts.push(
            `失败 ${result.failed.length}（${names}${result.failed.length > 3 ? "…" : ""}）`,
        );
    }
    const summary = `「${result.subscription?.name ?? "订阅源"}」${result.total} 个音源：${parts.join("、")}`;
    return result.note ? `${result.note}：${summary}` : summary;
}

function formatCheckTime(ts: number) {
    if (!ts) {
        return "从未检查";
    }
    return `上次检查 ${new Date(ts).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    })}`;
}

/** 一次拖动会话的状态；dragRef 是权威，drag state 只是渲染镜像 */
interface DragState {
    id: string;
    startIndex: number;
    /** 自拖拽起点累计的指针位移（px） */
    y: number;
    targetIndex: number;
    /** 超过 3px 才算真拖了，普通按下不触发换位 */
    moved: boolean;
    /** 被拖卡片的档位（自身高度 + 下边距）：其余卡片让位一格的位移量 */
    pitch: number;
}

export default function PluginManagePage() {
    const [plugins, setPlugins] = useState<SerializedPlugin[]>([]);
    const [subscriptions, setSubscriptions] = useState<SerializedSubscription[]>([]);
    /** 正在导入的订阅源 id；新建时记为 "new"，用于禁用按钮避免重复提交 */
    const [busySubscription, setBusySubscription] = useState<string | null>(null);
    const [installUrl, setInstallUrl] = useState("");
    const [editingVars, setEditingVars] = useState<string | null>(null);
    const [varDraft, setVarDraft] = useState<Record<string, string>>({});
    // ---------- 拖动排序（react-draggable，与侧边栏「我的歌单」同一套交互） ----------
    // 整张卡片任意位置按住即可拖（按钮/链接除外，见 PluginDraggable 的 cancel）；
    // 被拖卡片跟随指针，其余卡片按被拖卡片的档位整格让位；松手一次性换位落盘。
    const dragRef = useRef<DragState | null>(null);
    const [drag, setDrag] = useState<DragState | null>(null);
    /** 各卡片的布局快照（拖动开始时测一次；transform 不影响 offsetTop/Height，拖动期间有效） */
    const cardMetricsRef = useRef<{ hash: string; top: number; height: number }[]>([]);
    const cardRefs = useRef(new Map<string, HTMLDivElement>());

    const refresh = async () => {
        invalidatePluginCache();
        setPlugins(await getPlugins(true));
    };

    const refreshSubscriptions = async () => {
        setSubscriptions((await ipcInvoke("pluginSubscription:list")) ?? []);
    };

    useEffect(() => {
        refresh();
        refreshSubscriptions();
    }, []);

    /** 走「添加订阅源」这条路的两个入口共用 */
    const runSubscriptionImport = async (
        call: () => Promise<SubscriptionImportResult>,
        busyKey: string,
    ) => {
        setBusySubscription(busyKey);
        try {
            showToast(importToast(await call()));
        } finally {
            setBusySubscription(null);
        }
        // 导入会动到已装插件（新增/顶掉旧版），两边都要刷
        refresh();
        refreshSubscriptions();
    };

    const addSubscription = (url: string) =>
        runSubscriptionImport(
            () => ipcInvoke("pluginSubscription:add", url),
            "new",
        );

    const promptAddSubscription = () => {
        showPrompt({
            title: "添加聚合音源订阅源",
            placeholder: "订阅源链接（index.json）",
            confirmText: "导入",
            onConfirm: (url) => addSubscription(url),
        });
    };

    const openSubscriptionMenu = (
        e: React.MouseEvent,
        sub: SerializedSubscription,
    ) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, [
            {
                title: "检查更新",
                onClick: () =>
                    runSubscriptionImport(
                        () => ipcInvoke("pluginSubscription:update", sub.id),
                        sub.id,
                    ),
            },
            {
                title: "重命名",
                onClick: () =>
                    showPrompt({
                        title: "重命名订阅源",
                        defaultValue: sub.name,
                        onConfirm: async (name) => {
                            await ipcInvoke("pluginSubscription:rename", sub.id, name);
                            refreshSubscriptions();
                        },
                    }),
            },
            {
                title: "删除订阅源",
                danger: true,
                onClick: async () => {
                    await ipcInvoke("pluginSubscription:remove", sub.id);
                    showToast("已删除订阅源，已安装的音源保留");
                    refreshSubscriptions();
                },
            },
        ]);
    };

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
        if (result?.errorCode === "IS_PLUGIN_INDEX") {
            // 粘进来的是聚合源：就地按订阅源导入，不必让用户去找另一个按钮
            await addSubscription(url);
        } else {
            showToast(result?.success ? `已安装 ${result.pluginName}` : result?.message);
        }
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

    // ---------- 拖动排序 ----------
    // 卡片高度不一，让位幅度统一取「被拖卡片的档位」（自身高度 + 下边距）：
    // 被拖卡片从原位抽走、插到新位，中间的卡片各让出这一格空间。

    const handleDragStart = (pluginHash: string, startIndex: number) => {
        const el = cardRefs.current.get(pluginHash);
        const marginBottom = el ? parseFloat(getComputedStyle(el).marginBottom || "0") : 0;
        cardMetricsRef.current = plugins.map((p) => {
            const card = cardRefs.current.get(p.hash);
            return { hash: p.hash, top: card?.offsetTop ?? 0, height: card?.offsetHeight ?? 0 };
        });
        dragRef.current = {
            id: pluginHash,
            startIndex,
            y: 0,
            targetIndex: startIndex,
            moved: false,
            pitch: (el?.offsetHeight ?? 0) + marginBottom,
        };
        setDrag(dragRef.current);
    };

    const handleDragMove = (deltaY: number) => {
        const cur = dragRef.current;
        if (!cur) {
            return;
        }
        const y = cur.y + deltaY;
        // 目标位 = 被拖卡片中线扫过了几张其他卡片的中线；静止时恰好等于 startIndex
        const dragged = cardMetricsRef.current.find((m) => m.hash === cur.id);
        let targetIndex = cur.startIndex;
        if (dragged) {
            const center = dragged.top + dragged.height / 2 + y;
            targetIndex = cardMetricsRef.current.filter(
                (m, i) => i !== cur.startIndex && m.top + m.height / 2 < center,
            ).length;
        }
        dragRef.current = {
            ...cur,
            y,
            targetIndex: Math.max(0, Math.min(plugins.length - 1, targetIndex)),
            moved: cur.moved || Math.abs(y) > 3,
        };
        setDrag(dragRef.current);
    };

    const handleDragStop = () => {
        const d = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        cardMetricsRef.current = [];
        if (!d || !d.moved || d.targetIndex === d.startIndex) {
            return;
        }
        // 本地先换位（乐观更新），再落盘对齐（plugin:list 本身按 order 排序）
        const ordered = [...plugins];
        const [moved] = ordered.splice(d.startIndex, 1);
        ordered.splice(d.targetIndex, 0, moved);
        setPlugins(ordered);
        ipcInvoke("plugin:setOrder", ordered.map((p) => p.hash)).then(() => refresh());
    };

    return (
        <div style={{ maxWidth: 720 }}>
            <div className="section-title">音源插件</div>

            <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
                <input
                    className="text-input"
                    style={{ width: 320 }}
                    placeholder="插件 URL（.js 单个音源 / index.json 聚合源）"
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

            <div className="settings-group-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>聚合音源订阅源</span>
                <button
                    className="btn-ghost"
                    style={{ fontSize: 12, padding: "2px 8px" }}
                    disabled={!!busySubscription}
                    onClick={promptAddSubscription}
                >
                    {busySubscription === "new" ? "导入中…" : "添加订阅源"}
                </button>
            </div>
            {subscriptions.map((sub) => (
                <div
                    className="plugin-card"
                    key={sub.id}
                    style={{ padding: "10px 14px" }}
                    onContextMenu={(e) => openSubscriptionMenu(e, sub)}
                >
                    <div className="plugin-card-info">
                        <div className="plugin-card-name" style={{ fontSize: 14 }}>
                            {sub.name}
                        </div>
                        <div
                            className="plugin-card-meta"
                            style={{
                                margin: "2px 0",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                            }}
                            title={sub.url}
                        >
                            {sub.url}
                        </div>
                        <div className="plugin-card-meta" style={{ margin: 0 }}>
                            {sub.pluginCount} 个音源 · {formatCheckTime(sub.lastCheckAt)}
                        </div>
                    </div>
                    <button
                        className="btn-ghost"
                        disabled={!!busySubscription}
                        onClick={() =>
                            runSubscriptionImport(
                                () => ipcInvoke("pluginSubscription:update", sub.id),
                                sub.id,
                            )
                        }
                    >
                        {busySubscription === sub.id ? "检查中…" : "检查更新"}
                    </button>
                    <button
                        className="btn-ghost"
                        onClick={(e) => openSubscriptionMenu(e as any, sub)}
                    >
                        更多
                    </button>
                </div>
            ))}
            {!subscriptions.length && (
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 16 }}>
                    还没有订阅源。添加一个聚合源链接（指向列出整批插件的 index.json）即可一次装入它的全部音源，之后可一键检查更新。
                </div>
            )}

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

            {plugins.length > 1 && (
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "4px 0 10px" }}>
                    按住插件卡片上下拖动即可调整音源顺序（默认音源始终置顶）
                </div>
            )}
            {plugins.map((plugin, index) => {
                const draggingSelf = drag?.id === plugin.hash && drag.moved;
                // 其余卡片给被拖卡片让位：跨过一个档位就补上过渡位移
                let shiftY = 0;
                if (drag?.moved && drag.id !== plugin.hash) {
                    if (index > drag.startIndex && index <= drag.targetIndex) {
                        shiftY = -drag.pitch;
                    } else if (index < drag.startIndex && index >= drag.targetIndex) {
                        shiftY = drag.pitch;
                    }
                }
                return (
                    <PluginDraggable
                        key={plugin.hash}
                        offsetY={drag?.id === plugin.hash ? drag.y : 0}
                        dragging={!!draggingSelf}
                        shiftY={shiftY}
                        disabled={plugins.length < 2}
                        onStart={() => handleDragStart(plugin.hash, index)}
                        onMove={handleDragMove}
                        onStop={handleDragStop}
                        onContextMenu={(e) => openMenu(e, plugin)}
                        registerRef={(el) => {
                            if (el) {
                                cardRefs.current.set(plugin.hash, el);
                            } else {
                                cardRefs.current.delete(plugin.hash);
                            }
                        }}
                    >
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
                    </PluginDraggable>
                );
            })}

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

/**
 * 插件卡片的拖拽外壳（与侧边栏歌单行同一套分层）：
 * 外层 div 的 transform 由 Draggable 接管（被拖卡片跟随指针），
 * 内层 .plugin-card 的 transform 留给「让位」过渡动画——
 * 两者必须分层，否则 Draggable 写入的 translate 会把让位位移覆盖掉。
 * 整张卡片任意位置按下即可拖；按钮/链接上按下不拖（cancel），保持点击行为。
 */
function PluginDraggable(props: {
    offsetY: number;
    dragging: boolean;
    shiftY: number;
    disabled: boolean;
    onStart: () => void;
    onMove: (deltaY: number) => void;
    onStop: () => void;
    onContextMenu: (e: React.MouseEvent) => void;
    /** 注册内层卡片元素：拖动开始时测 offsetTop/Height 用 */
    registerRef: (el: HTMLDivElement | null) => void;
    children: React.ReactNode;
}) {
    const nodeRef = useRef<HTMLDivElement>(null);
    return (
        <Draggable
            nodeRef={nodeRef}
            axis="y"
            position={{ x: 0, y: props.offsetY }}
            onStart={props.onStart}
            onDrag={(_, data) => props.onMove(data.deltaY)}
            onStop={props.onStop}
            disabled={props.disabled}
            cancel="button, a, input, textarea, select"
        >
            <div
                ref={nodeRef}
                style={{ position: "relative", zIndex: props.dragging ? 10 : undefined }}
            >
                <div
                    ref={props.registerRef}
                    className={`plugin-card${props.dragging ? " dragging" : ""}`}
                    style={{
                        transform:
                            !props.dragging && props.shiftY
                                ? `translateY(${props.shiftY}px)`
                                : undefined,
                        transition: props.dragging ? "none" : "transform 160ms ease",
                    }}
                    onContextMenu={props.onContextMenu}
                >
                    {props.children}
                </div>
            </div>
        </Draggable>
    );
}
