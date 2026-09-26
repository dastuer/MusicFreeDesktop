import React, { useEffect, useRef, useState } from "react";
import Icon from "./Icon";

/**
 * 右键菜单系统
 * showContextMenu(x, y, items) 全局函数 + ContextMenuHost 挂载一次
 */

export interface IContextMenuItem {
    title: string;
    icon?: string;
    /** 勾选标记：渲染在文字右侧（音质选择这类「单选」菜单用） */
    checked?: boolean;
    danger?: boolean;
    onClick: () => void;
}

interface IMenuState {
    x: number;
    y: number;
    items: IContextMenuItem[];
    /** true 时 y 是「菜单底边」的锚点，菜单向上展开（播放栏这类贴底的入口用） */
    above?: boolean;
    /** 紧凑变体：宽度贴内容（播放栏「…」这种只有两个短项的菜单） */
    compact?: boolean;
}

let menuListener: ((state: IMenuState) => void) | null = null;

export function showContextMenu(
    x: number,
    y: number,
    items: IContextMenuItem[],
    options?: { above?: boolean; compact?: boolean },
) {
    menuListener?.({ x, y, items, above: options?.above, compact: options?.compact });
}

export default function ContextMenuHost() {
    const [state, setState] = useState<IMenuState | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        menuListener = (s) => {
            setState(s);
            // 边缘防溢出
            requestAnimationFrame(() => {
                const el = menuRef.current;
                if (!el) {
                    return;
                }
                const rect = el.getBoundingClientRect();
                let { x, y } = s;
                if (x + rect.width > window.innerWidth - 8) {
                    x = window.innerWidth - rect.width - 8;
                }
                if (s.above) {
                    // 向上展开：y 是底边锚点，顶边 y - height 放不下就整体下移贴顶
                    if (rect.height + 8 > y) {
                        y = rect.height + 8;
                    }
                } else if (y + rect.height > window.innerHeight - 8) {
                    y = window.innerHeight - rect.height - 8;
                }
                setState((prev) => (prev ? { ...prev, x, y } : prev));
            });
        };
        const close = () => setState(null);
        window.addEventListener("click", close);
        window.addEventListener("blur", close);
        return () => {
            menuListener = null;
            window.removeEventListener("click", close);
            window.removeEventListener("blur", close);
        };
    }, []);

    if (!state) {
        return null;
    }

    return (
        <div
            className={`context-menu${state.compact ? " compact" : ""}`}
            ref={menuRef}
            style={
                state.above
                    ? { left: state.x, bottom: window.innerHeight - state.y }
                    : { left: state.x, top: state.y }
            }
            onClick={(e) => e.stopPropagation()}
        >
            {state.items.map((item, idx) => (
                <div
                    key={idx}
                    className="context-menu-item"
                    style={item.danger ? { color: "#ec4141" } : undefined}
                    onClick={() => {
                        setState(null);
                        item.onClick();
                    }}
                >
                    {item.icon && <Icon name={item.icon} size={15} />}
                    {item.title}
                    {item.checked && (
                        <Icon
                            name="check"
                            size={15}
                            style={{ marginLeft: "auto", color: "var(--primary-color)" }}
                        />
                    )}
                </div>
            ))}
        </div>
    );
}
