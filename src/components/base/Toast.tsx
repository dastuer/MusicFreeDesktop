import React, { useEffect, useState } from "react";

/** 轻量 Toast 系统 */

interface IToastItem {
    id: number;
    text: string;
    /** 可选动作按钮（如「查看」）：点击后 toast 立即消失 */
    action?: { text: string; onClick: () => void };
    /** 展示时长 ms，默认 2400 */
    duration?: number;
}

let listeners: ((item: IToastItem) => void)[] = [];
let toastId = 0;

export function showToast(
    text: string,
    options?: { action?: { text: string; onClick: () => void }; duration?: number },
) {
    const item = { id: ++toastId, text, ...options };
    listeners.forEach((fn) => fn(item));
}

export default function ToastHost() {
    const [toasts, setToasts] = useState<IToastItem[]>([]);

    useEffect(() => {
        const handler = (item: IToastItem) => {
            setToasts((prev) => [...prev, item]);
            setTimeout(() => {
                setToasts((prev) => prev.filter((it) => it.id !== item.id));
            }, item.duration ?? 2400);
        };
        listeners.push(handler);
        return () => {
            listeners = listeners.filter((fn) => fn !== handler);
        };
    }, []);

    if (!toasts.length) {
        return null;
    }
    return (
        <div className="toast-host">
            {toasts.map((it) => (
                <div className="toast-item" key={it.id}>
                    <span>{it.text}</span>
                    {it.action && (
                        <button
                            className="toast-action"
                            onClick={() => {
                                it.action!.onClick();
                                setToasts((prev) => prev.filter((x) => x.id !== it.id));
                            }}
                        >
                            {it.action.text}
                        </button>
                    )}
                </div>
            ))}
        </div>
    );
}
