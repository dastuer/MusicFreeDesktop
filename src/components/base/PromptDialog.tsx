import React, { useEffect, useRef, useState } from "react";

/**
 * 通用文本输入弹窗（新建歌单 / 重命名等）
 */

interface IPromptOptions {
    title: string;
    placeholder?: string;
    defaultValue?: string;
    confirmText?: string;
    onConfirm: (text: string) => void;
}

let promptListener: ((options: IPromptOptions) => void) | null = null;

export function showPrompt(options: IPromptOptions) {
    promptListener?.(options);
}

export default function PromptDialogHost() {
    const [options, setOptions] = useState<IPromptOptions | null>(null);
    const [text, setText] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

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
    const confirm = () => {
        const value = text.trim();
        if (!value) {
            return;
        }
        options.onConfirm(value);
        close();
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
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                    <button className="btn-ghost" onClick={close}>
                        取消
                    </button>
                    <button className="btn-primary" onClick={confirm}>
                        {options.confirmText ?? "确定"}
                    </button>
                </div>
            </div>
        </div>
    );
}
