import React, { useEffect } from "react";
import Icon from "./Icon";
import { showToast } from "./Toast";
import { SerializedPlugin } from "@/core/ipc";
import { AUTO_SOURCE, ISourceCapability, hasCapability } from "@/core/mediaSource";

/**
 * 音源切换器（发现音乐 / 排行榜共用）：
 *  - 「自动」= 按默认音源优先顺序逐个降级尝试；
 *  - 指定音源 = 只用该插件，即使失败也不回落到其他音源；
 *  - 已在候选列表里标注「默认」与「不支持某能力」；
 *  - 已保存的音源被卸载/禁用时自动回落到「自动」，避免页面卡在空态。
 */

interface ISourceSwitcherProps {
    /** 全部已启用且挂载成功的插件（候选列表与失效检测都基于它） */
    plugins: SerializedPlugin[];
    /** 该页面/区块需要的能力；插件支持任一能力即进入候选列表 */
    capabilities: ISourceCapability[];
    value: string;
    onChange: (hash: string) => void;
    style?: React.CSSProperties;
}

export default function SourceSwitcher(props: ISourceSwitcherProps) {
    const { plugins, capabilities, value, onChange, style } = props;
    const defaultHash = localStorage.getItem("defaultPluginHash");

    const candidates = plugins.filter(
        (p) =>
            p.hash === value ||
            capabilities.some((capability) => hasCapability(p, capability)),
    );

    // 插件列表已加载但找不到已选音源 → 说明被卸载/禁用了
    useEffect(() => {
        if (!plugins.length || !value || value === AUTO_SOURCE) {
            return;
        }
        if (!plugins.some((p) => p.hash === value)) {
            onChange(AUTO_SOURCE);
            showToast("所选音源已不可用，已切回「自动」");
        }
    }, [plugins.length, value, onChange]);

    if (!candidates.length) {
        return null;
    }

    return (
        <div className="source-switcher" style={style}>
            <Icon name="plugin" size={13} />
            <span className="source-switcher-label">音源</span>
            <select
                className="source-switcher-select"
                value={value}
                title={`切换${capabilities.map((c) => c.label).join(" / ")}的数据来源`}
                onChange={(e) => onChange(e.target.value)}
            >
                <option value={AUTO_SOURCE} style={{ color: "#333" }}>
                    自动（默认音源优先）
                </option>
                {candidates.map((plugin) => {
                    const missing = capabilities.filter(
                        (capability) => !hasCapability(plugin, capability),
                    );
                    return (
                        <option key={plugin.hash} value={plugin.hash} style={{ color: "#333" }}>
                            {plugin.name}
                            {plugin.hash === defaultHash ? "（默认）" : ""}
                            {missing.length
                                ? ` · 不支持${missing.map((c) => c.label).join("、")}`
                                : ""}
                        </option>
                    );
                })}
            </select>
        </div>
    );
}
