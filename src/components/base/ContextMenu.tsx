import React, { useEffect, useRef, useState } from "react";
import Icon from "./Icon";

/**
 * 右键菜单系统
 * showContextMenu(x, y, items) 全局函数 + ContextMenuHost 挂载一次
 */

export interface IContextMenuItem {
    title: string;
    icon?: string;
    danger?: boolean;
    onClick: () => void;
}

interface IMenuState {
    x: number;
    y: number;
    items: IContextMenuItem[];
}

let menuListener: ((state: IMenuState) => void) | null = null;

export function showContextMenu(x: number, y: number, items: IContextMenuItem[]) {
    menuListener?.({ x, y, items });
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
                if (y + rect.height > window.innerHeight - 8) {
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
            className="context-menu"
            ref={menuRef}
            style={{ left: state.x, top: state.y }}
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
                </div>
            ))}
        </div>
    );
}
