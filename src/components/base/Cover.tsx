import React, { useState } from "react";
import Icon from "./Icon";

/**
 * 封面图组件：加载失败回退到音符占位
 * 高分屏下不做强制放大，保持原始像素清晰度
 */

interface ICoverProps {
    src?: string;
    size?: number | string;
    borderRadius?: number | string;
    className?: string;
    style?: React.CSSProperties;
    fallbackIconSize?: number;
}

/**
 * 内联封面尺寸上限。
 * 音源有时会把整张封面塞成 base64（见过 13 MB 的 PNG）：`<img>` 会为每一行
 * 解码一张几 MB 的位图，列表一滚就卡死。这种图直接当没有，回退到音符占位。
 * 正常情况下封面已经由主进程落盘换成 mfs:// 短链，走不到这个分支。
 */
const MAX_INLINE_COVER = 64 * 1024;

export default function Cover(props: ICoverProps) {
    const { src, size = 40, borderRadius = 6, className, style } = props;
    const [failed, setFailed] = useState(false);
    const tooLarge = typeof src === "string" && src.length > MAX_INLINE_COVER;

    if (!src || tooLarge || failed) {
        return (
            <div
                className={className}
                style={{
                    width: typeof size === "number" ? size : size,
                    height: typeof size === "number" ? size : size,
                    borderRadius,
                    background: "var(--hover-bg)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--text-placeholder)",
                    flexShrink: 0,
                    ...style,
                }}
            >
                <Icon name="musicNote" size={Math.min(typeof size === "number" ? size * 0.4 : 16, 32)} />
            </div>
        );
    }

    return (
        <img
            className={className}
            src={src}
            loading="lazy"
            draggable={false}
            onError={() => setFailed(true)}
            style={{
                width: size,
                height: size,
                borderRadius,
                objectFit: "cover",
                flexShrink: 0,
                ...style,
            }}
        />
    );
}
