import React, { useEffect, useRef, useState } from "react";

interface IMarqueeProps {
    text: string;
    className?: string;
    /** 滚动速度，px/秒 */
    speed?: number;
}

/**
 * 文本超宽时无缝循环滚动，不超宽时原样展示。
 * 原理：溢出时渲染两份文本，轨道从 0 平移到「一份文本 + 间隔」的宽度后瞬间归位，
 * 第二份文本恰好接上第一份的位置，肉眼看不到跳变。
 */
export default function Marquee(props: IMarqueeProps) {
    const { text, className, speed = 24 } = props;
    const containerRef = useRef<HTMLDivElement>(null);
    const firstCopyRef = useRef<HTMLSpanElement>(null);
    const [overflow, setOverflow] = useState(false);
    const [shift, setShift] = useState(0);

    useEffect(() => {
        const container = containerRef.current;
        const firstCopy = firstCopyRef.current;
        if (!container || !firstCopy) {
            return;
        }
        const measure = () => {
            // offsetWidth 已含 .marquee-copy 的右内边距，本身就是无缝循环的周期
            const cycleWidth = firstCopy.offsetWidth;
            if (cycleWidth > container.clientWidth) {
                setOverflow(true);
                setShift(cycleWidth);
            } else {
                setOverflow(false);
            }
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        return () => observer.disconnect();
    }, [text]);

    return (
        <div ref={containerRef} className={`marquee${className ? ` ${className}` : ""}`}>
            <div
                className="marquee-track"
                style={
                    overflow
                        ? ({
                              animation: `marquee-scroll ${Math.max(
                                  shift / speed,
                                  4,
                              )}s linear infinite`,
                              "--marquee-shift": `${shift}px`,
                          } as React.CSSProperties)
                        : undefined
                }
            >
                <span className="marquee-copy" ref={firstCopyRef}>
                    {text}
                </span>
                {overflow && <span className="marquee-copy">{text}</span>}
            </div>
        </div>
    );
}
