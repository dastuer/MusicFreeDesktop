import React, { useEffect, useRef, useState } from "react";

/**
 * 通用文本输入弹窗（新建歌单 / 重命名等）
 */

interface IPromptOptions {
    title: string;
    placeholder?: string;
    defaultValue?: string;
    confirmText?: string;
    /** 返回 false（含 Promise<false>）时弹窗不关，供校验失败留在原输入重试 */
    onConfirm: (text: string) => void | false | Promise<void | false>;
    /** 输入框下方的引导入口（如「从链接导入」）；onClick 里自行 showPrompt 即可原地切换弹窗 */
    hint?: { text: string; onClick: () => void };
}

let promptListener: ((options: IPromptOptions) => void) | null = null;

export function showPrompt(options: IPromptOptions) {
    promptListener?.(options);
}

export default function PromptDialogHost() {
    const [options, setOptions] = useState<IPromptOptions | null>(null);
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    /** 等待 onConfirm 期间防重入（异步 onConfirm 时确定/回车可能连点） */
    const confirmingRef = useRef(false);

    useEffect(() => {
        promptListener = (opts) => {
            setOptions(opts);
            setText(opts.defaultValue ?? "");
            requestAnimationFrame(() => inputRef.current?.select());
        };
        return () => {
            promptListener = null;
        };
    }, []);

    if (!options) {
        return null;
    }

    const close = () => setOptions(null);
    const confirm = async () => {
        const value = text.trim();
        if (!value || confirmingRef.current) {
            return;
        }
        confirmingRef.current = true;
        setBusy(true);
        try {
            const result = await options.onConfirm(value);
            if (result !== false) {
                close();
            }
        } finally {
            confirmingRef.current = false;
            setBusy(false);
        }
    };

    return (
        <div className="panel-mask" style={{ alignItems: "center" }} onClick={close}>
            <div
                className="panel-body"
                style={{
                    width: 360,
                    maxHeight: "none",
                    marginBottom: 0,
                    borderRadius: 12,
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>
                    {options.title}
                </div>
                <input
                    className="text-input"
                    ref={inputRef}
                    autoFocus
                    style={{ width: "100%", marginBottom: 14 }}
                    placeholder={options.placeholder}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            confirm();
                        }
                        if (e.key === "Escape") {
                            close();
                        }
                    }}
                />
                {options.hint && (
                    <div
                        style={{
                            fontSize: 12,
                            color: "var(--text-secondary)",
                            marginBottom: 14,
                            cursor: "pointer",
                            userSelect: "none",
                        }}
                        onClick={options.hint.onClick}
                    >
                        {options.hint.text}
                    </div>
                )}
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    <button className="btn-ghost" onClick={close} disabled={busy}>
                        取消
                    </button>
                    <button
                        className="btn-primary"
                        onClick={confirm}
                        disabled={busy}
                        style={busy ? { opacity: 0.6 } : undefined}
                    >
                        {busy ? "处理中…" : (options.confirmText ?? "确定")}
                    </button>
                </div>
            </div>
        </div>
    );
}
