import React, { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import {
    CUSTOM_PRESET_NAME,
    EQ_BAND_LABELS,
    EQ_BANDS,
    EQ_GAIN_RANGE,
    EQ_PRESETS,
    REVERB_PRESETS,
    SURROUND_RANGE,
    TONE_RANGE,
    USER_PRESET_NAME,
    applyPreset,
    previewBand,
    previewSurround,
    previewTone,
    resetEqualizer,
    saveUserPreset,
    setBandGain,
    setBassGain,
    setEffectEnabled,
    setReverbPreset,
    setSurround,
    setTrebleGain,
    useAudioEffect,
} from "@/core/audioEffect";

/**
 * 音效面板（布局参考网易云桌面版音效页的「均衡器」页）：
 *
 *   ┌ 均衡器                            正在使用 [开关] ✕ ┐
 *   ├──────────────────────────────────────────────────┤
 *   │ 均衡器 [ 流行              ⌄ ]  [保存]             │
 *   │ +12dB ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉                        │
 *   │       │ │ │ │ │ │ │ │ │ │                         │
 *   │ −12dB                                              │
 *   │       31 63 125 250 500 1k 2k 4k 8k 16k           │
 *   │                                                    │
 *   │ 增强音效 (重置)                                     │
 *   │ − ────●──── +          − ────●──── +              │
 *   │      低音                   高音                    │
 *   │ − ─●────── +           − ────●──── +              │
 *   │    环绕深度               环绕强度                  │
 *   │                                                    │
 *   │ 环境音效 [无                              ⌄]        │
 *   └──────────────────────────────────────────────────┘
 *
 * 预设收进一行下拉（不再是卡片墙），「保存」把当前这套参数存成「我的音效」。
 * 所有调整即时生效，没有「应用」按钮；拖动期间只预览不落盘，松手才写 storage。
 */

let panelListener: (() => void) | null = null;

export function showAudioEffectPanel() {
    panelListener?.();
}

/**
 * 竖向 EQ 推子。
 *
 * 填充条统一从**轨道最底端（−12dB）**长到当前值，正负都是同一个颜色 ——
 * 按「已选中的量」理解，而不是「0 以上才填充」。这样负值也有明确的进度感，
 * 与网易云那排推子一致（它们的柱子也总是从底部起）。
 */
function EqFader(props: {
    label: string;
    value: number;
    onChange: (v: number) => void;
    onCommit: (v: number) => void;
}) {
    const { label, value, onChange, onCommit } = props;
    const trackRef = useRef<HTMLDivElement>(null);
    const [dragging, setDragging] = useState(false);
    const [dragValue, setDragValue] = useState(0);
    const displayValue = dragging ? dragValue : value;

    const { min, max } = EQ_GAIN_RANGE;
    /** 当前位置在轨道上的比例：底端 = min(−12)，顶端 = max(+12) */
    const percent = (displayValue - min) / (max - min);
    /** 0dB 基线在轨道上的比例 */
    const zeroPercent = (0 - min) / (max - min);

    const valueFromEvent = (e: { clientY: number }) => {
        const rect = trackRef.current?.getBoundingClientRect();
        if (!rect || rect.height === 0) {
            return 0;
        }
        const ratio = Math.min(Math.max((rect.bottom - e.clientY) / rect.height, 0), 1);
        return min + ratio * (max - min);
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        e.preventDefault();
        setDragging(true);
        const v = valueFromEvent(e);
        setDragValue(v);
        onChange(v);
        const onMove = (ev: PointerEvent) => {
            const nv = valueFromEvent(ev);
            setDragValue(nv);
            onChange(nv);
        };
        const onUp = (ev: PointerEvent) => {
            const nv = valueFromEvent(ev);
            setDragging(false);
            onCommit(nv);
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    return (
        <div className="eq-fader">
            <div
                className={`eq-fader-track${dragging ? " dragging" : ""}`}
                ref={trackRef}
                onPointerDown={handlePointerDown}
            >
                {/* 轨道：一条贯穿上下的细线，零线单独标出 */}
                <div className="eq-fader-rail" />
                <div className="eq-fader-zero" style={{ bottom: `${zeroPercent * 100}%` }} />
                {/* 填充：始终从底部长到当前值，正负同色 */}
                <div className="eq-fader-fill" style={{ height: `${percent * 100}%` }} />
                <div className="eq-fader-thumb" style={{ bottom: `${percent * 100}%` }} />
                {/* 拖动时才显示数值气泡 */}
                {dragging && (
                    <div className="fader-bubble" style={{ bottom: `${percent * 100}%` }}>
                        {displayValue > 0 ? "+" : ""}
                        {displayValue.toFixed(1)}
                    </div>
                )}
            </div>
            <div className="eq-fader-label">{label}</div>
        </div>
    );
}

/**
 * 横向滑块（低音 / 高音 / 环绕深度 / 环绕强度）。
 *
 * 与 EQ 推子同一套语义：填充从**最左端（最小值）**长到当前位置，
 * 正负同色；拖动时上方浮出数值气泡。
 */
function HSlider(props: {
    label: string;
    value: number;
    min: number;
    max: number;
    /** 数值格式化（dB 带单位、环绕用百分比） */
    format: (v: number) => string;
    onChange: (v: number) => void;
    onCommit: (v: number) => void;
    /** 是否标出中点刻度（对称型参数用） */
    showCenter?: boolean;
}) {
    const { label, value, min, max, format, onChange, onCommit, showCenter } = props;
    const trackRef = useRef<HTMLDivElement>(null);
    const [dragging, setDragging] = useState(false);
    const [dragValue, setDragValue] = useState(0);
    const displayValue = dragging ? dragValue : value;
    const percent = (displayValue - min) / (max - min);
    const centerPercent = (0 - min) / (max - min);

    const valueFromEvent = (e: { clientX: number }) => {
        const rect = trackRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) {
            return min;
        }
        const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
        return min + ratio * (max - min);
    };

    const startDrag = (e: React.PointerEvent) => {
        e.preventDefault();
        setDragging(true);
        const v = valueFromEvent(e);
        setDragValue(v);
        onChange(v);
        const onMove = (ev: PointerEvent) => {
            const nv = valueFromEvent(ev);
            setDragValue(nv);
            onChange(nv);
        };
        const onUp = (ev: PointerEvent) => {
            const nv = valueFromEvent(ev);
            setDragging(false);
            onCommit(nv);
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    return (
        <div className="hs-row">
            <div className="hs-control">
                <span className="hs-end">−</span>
                <div
                    className={`hs-track${dragging ? " dragging" : ""}`}
                    ref={trackRef}
                    onPointerDown={startDrag}
                >
                    <div className="hs-rail" />
                    {showCenter && (
                        <div className="hs-center" style={{ left: `${centerPercent * 100}%` }} />
                    )}
                    {/* 从最左端长到当前值，正负同色 */}
                    <div className="hs-fill" style={{ width: `${percent * 100}%` }} />
                    <div className="hs-thumb" style={{ left: `${percent * 100}%` }} />
                    {dragging && (
                        <div className="fader-bubble" style={{ left: `${percent * 100}%` }}>
                            {format(displayValue)}
                        </div>
                    )}
                </div>
                <span className="hs-end">+</span>
            </div>
            <div className="hs-label">{label}</div>
        </div>
    );
}

export default function AudioEffectPanelHost() {
    const [visible, setVisible] = useState(false);
    const settings = useAudioEffect();

    useEffect(() => {
        panelListener = () => setVisible(true);
        return () => {
            panelListener = null;
        };
    }, []);

    // Esc 关闭：面板是模态遮罩，键盘也该能退出
    useEffect(() => {
        if (!visible) {
            return;
        }
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setVisible(false);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [visible]);

    if (!visible) {
        return null;
    }

    const close = () => setVisible(false);
    /** 环绕数值按对称百分比显示（−100% ~ +100%） */
    const surroundText = (v: number) => `${Math.round(v * 100)}%`;

    /**
     * 下拉里的候选：用户保存过的「我的音效」排最前（有才显示），
     * 然后是内置曲线。手工拖动后的「自定义」也作为一项出现在当前值上，
     * 但不在列表里重复给入口（它不是一个可主动选择的目标）。
     */
    const presetOptions = [
        ...(settings.userPreset ? [USER_PRESET_NAME] : []),
        ...EQ_PRESETS.map((item) => item.name),
    ];
    const selectValue = presetOptions.includes(settings.preset)
        ? settings.preset
        : CUSTOM_PRESET_NAME;

    return (
        <div className="panel-mask audio-effect-mask" onClick={close}>
            <div className="audio-effect-panel" onClick={(e) => e.stopPropagation()}>
                {/* 头部：左侧 tab（只保留均衡器），右侧「正在使用」+ 开关 + 关闭 */}
                <div className="audio-effect-header">
                    <div className="audio-effect-tabs">
                        <button className="audio-effect-tab active">均衡器</button>
                    </div>
                    <div className="audio-effect-switch">
                        <span className="switch-label">
                            正在使用：{settings.enabled ? "均衡器" : "未启用"}
                        </span>
                        <button
                            className={`switch-pill${settings.enabled ? " on" : ""}`}
                            onClick={() => setEffectEnabled(!settings.enabled)}
                            title={settings.enabled ? "关闭音效" : "开启音效"}
                        >
                            <span className="switch-knob" />
                        </button>
                    </div>
                    <Icon name="close" size={17} className="audio-effect-close" onClick={close} />
                </div>

                <div className={`audio-effect-body${settings.enabled ? "" : " disabled"}`}>
                    {/* 预设只占一行：下拉选择 + 保存当前曲线 */}
                    <div className="eq-preset-row">
                        <span className="eq-preset-label">均衡器</span>
                        <div className="pill-select-wrap">
                            <select
                                className="pill-select"
                                value={selectValue}
                                onChange={(e) => applyPreset(e.target.value)}
                            >
                                {/* 手工调过时下拉显示「自定义」，它不是一个可选项 */}
                                {!presetOptions.includes(settings.preset) && (
                                    <option value={CUSTOM_PRESET_NAME}>{CUSTOM_PRESET_NAME}</option>
                                )}
                                {presetOptions.map((name) => (
                                    <option key={name} value={name}>
                                        {name}
                                    </option>
                                ))}
                            </select>
                            <Icon name="chevronDown" size={14} className="pill-select-caret" />
                        </div>
                        <button
                            className="eq-preset-save"
                            onClick={saveUserPreset}
                            title="把当前这套参数存成「我的音效」"
                        >
                            保存
                        </button>
                    </div>

                    {/* 十段推子：刻度与轨道真实对应（+12 / 0 / −12） */}
                    <div className="eq-board">
                        <div className="eq-scale">
                            <span>+12dB</span>
                            <span>0</span>
                            <span>−12dB</span>
                        </div>
                        <div className="eq-faders">
                            {EQ_BANDS.map((_, index) => (
                                <EqFader
                                    key={EQ_BAND_LABELS[index]}
                                    label={EQ_BAND_LABELS[index]}
                                    value={settings.eqs[index]}
                                    onChange={(v) => previewBand(index, v)}
                                    onCommit={(v) => setBandGain(index, v)}
                                />
                            ))}
                        </div>
                    </div>

                    {/* 增强音效：重置 + 四个滑块 */}
                    <div className="audio-effect-section-head">
                        <span className="audio-effect-section-title">增强音效</span>
                        <button className="audio-effect-reset" onClick={resetEqualizer}>
                            重置
                        </button>
                    </div>
                    <div className="hs-grid">
                        <HSlider
                            label="低音"
                            value={settings.bass}
                            min={TONE_RANGE.min}
                            max={TONE_RANGE.max}
                            format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}dB`}
                            onChange={(v) => previewTone("bass", v)}
                            onCommit={(v) => setBassGain(v)}
                            showCenter
                        />
                        <HSlider
                            label="高音"
                            value={settings.treble}
                            min={TONE_RANGE.min}
                            max={TONE_RANGE.max}
                            format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}dB`}
                            onChange={(v) => previewTone("treble", v)}
                            onCommit={(v) => setTrebleGain(v)}
                            showCenter
                        />
                        <HSlider
                            label="环绕深度"
                            value={settings.surroundDepth}
                            min={SURROUND_RANGE.min}
                            max={SURROUND_RANGE.max}
                            format={surroundText}
                            onChange={(v) => previewSurround("depth", v)}
                            onCommit={(v) => setSurround("depth", v)}
                            showCenter
                        />
                        <HSlider
                            label="环绕强度"
                            value={settings.surroundStrength}
                            min={SURROUND_RANGE.min}
                            max={SURROUND_RANGE.max}
                            format={surroundText}
                            onChange={(v) => previewSurround("strength", v)}
                            onCommit={(v) => setSurround("strength", v)}
                            showCenter
                        />
                    </div>

                    {/* 环境音效 */}
                    <div className="reverb-row">
                        <span className="reverb-label">环境音效</span>
                        <div className="pill-select-wrap">
                            <select
                                className="pill-select"
                                value={settings.reverb}
                                onChange={(e) => setReverbPreset(e.target.value)}
                            >
                                {REVERB_PRESETS.map((preset) => (
                                    <option key={preset.name} value={preset.name}>
                                        {preset.name}
                                    </option>
                                ))}
                            </select>
                            <Icon name="chevronDown" size={14} className="pill-select-caret" />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
