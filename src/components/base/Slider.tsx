import React, { useRef, useState } from "react";

interface ISliderProps {
    value: number;
    max: number;
    onChange: (value: number) => void;
    /** 拖动中不触发 onChange，松手才触发（用于播放进度） */
    commitOnRelease?: boolean;
    onCommit?: (value: number) => void;
    className?: string;
    /** 填充色是否使用主题色 */
    filledPrimary?: boolean;
}

export default function Slider(props: ISliderProps) {
    const { value, max, onChange, commitOnRelease, onCommit, className, filledPrimary } =
        props;
    const trackRef = useRef<HTMLDivElement>(null);
    const [dragging, setDragging] = useState(false);
    const [dragValue, setDragValue] = useState(0);

    const displayValue = dragging ? dragValue : value;
    const percent = max > 0 ? Math.min(Math.max(displayValue / max, 0), 1) : 0;

    const valueFromEvent = (clientX: number) => {
        const rect = trackRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) {
            return 0;
        }
        return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) * max;
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        e.preventDefault();
        setDragging(true);
        const v = valueFromEvent(e.clientX);
        setDragValue(v);
        if (!commitOnRelease) {
            onChange(v);
        }
        const onMove = (ev: PointerEvent) => {
            const nv = valueFromEvent(ev.clientX);
            setDragValue(nv);
            if (!commitOnRelease) {
                onChange(nv);
            }
        };
        const onUp = (ev: PointerEvent) => {
            const nv = valueFromEvent(ev.clientX);
            setDragging(false);
            if (commitOnRelease) {
                onChange(nv);
                onCommit?.(nv);
            }
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    return (
        <div
            className={`slider${dragging ? " dragging" : ""}${
                filledPrimary ? " filled-primary" : ""
            } ${className ?? ""}`}
            onPointerDown={handlePointerDown}
        >
            <div className="slider-track" ref={trackRef}>
                <div className="slider-filled" style={{ width: `${percent * 100}%` }} />
            </div>
            <div className="slider-thumb" style={{ left: `${percent * 100}%` }} />
        </div>
    );
}
