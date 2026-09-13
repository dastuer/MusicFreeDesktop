import React, { useState } from "react";
import { useAtomValue } from "jotai";
import Icon from "./Icon";
import { coverVersionAtom } from "@/core/cache";

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
    /**
     * 换 `src` 要把失败状态清掉。
     * `failed` 是组件自己的 state，而封面组件（尤其是底部播放栏那个）**跨歌曲复用同一个实例**，
     * 只在挂载时算一次的话，只要有一首歌的封面加载失败——比如封面缓存刚被重建、
     * 短链指向的文件暂时不存在——之后的每一首歌都会永远停在音符占位图上，
     * 即使文件早就回来了也不会重试。
     * 另外把「封面版本号」也算进这个 key：用户在设置页点「重建」之后，
     * 已经失败的封面要能自己重新取图。
     * 在渲染期比较上一次的 key 并重置，是 React 官方推荐的「props 变化时调整 state」写法，
     * 不会多渲染一帧，也不会触发额外的 effect。
     */
    const coverVersion = useAtomValue(coverVersionAtom);
    const coverKey = `${coverVersion}|${src ?? ""}`;
    const [lastKey, setLastKey] = useState(coverKey);
    if (lastKey !== coverKey) {
        setLastKey(coverKey);
        setFailed(false);
    }
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
