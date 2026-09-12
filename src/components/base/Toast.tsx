import React, { useEffect, useState } from "react";

/** 轻量 Toast 系统 */

interface IToastItem {
    id: number;
    text: string;
}

let listeners: ((item: IToastItem) => void)[] = [];
let toastId = 0;

export function showToast(text: string) {
    const item = { id: ++toastId, text };
    listeners.forEach((fn) => fn(item));
}

export default function ToastHost() {
    const [toasts, setToasts] = useState<IToastItem[]>([]);

    useEffect(() => {
        const handler = (item: IToastItem) => {
            setToasts((prev) => [...prev, item]);
            setTimeout(() => {
                setToasts((prev) => prev.filter((it) => it.id !== item.id));
            }, 2400);
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
                    {it.text}
                </div>
            ))}
        </div>
    );
}
