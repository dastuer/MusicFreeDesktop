import { atom, getDefaultStore, useAtomValue } from "jotai";
import { getConfig, setConfig } from "./appConfig";

/**
 * 音效（参考网易云桌面版「音效」）。
 *
 * 播放器的 <audio> 全部汇入同一个 Web Audio 总线，音效链挂在总线上：
 *
 *   每个 <audio> ─MediaElementSource─┐
 *                                    ├─ 输入 ─ 10段EQ ─ 低音 ─ 高音 ─ 输出
 *   每个 <audio> ─MediaElementSource─┘
 *
 * 共用一条总线是因为播放器同时持有多个 <audio>：正片、无缝切音质的影子、
 * 预载下一首的影子。三者都接总线，交接时谁出声都过同一套音效，
 * 换歌 / 换音质的那一刻音效不会「掉一下」。
 *
 * 一个 <audio> 只能被 createMediaElementSource 接管一次（重复调用抛 InvalidStateError），
 * 所以按元素缓存源节点。而且接管是**单向**的：接进图之后没法再退回原生直出，
 * 所以音效没开时一律不接管——默认设置下播放链路与改动前完全一致。
 */

/** 十段均衡器频点（Hz），与网易云一致 */
export const EQ_BANDS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** 十段频点的短标签（推子下方轴标） */
export const EQ_BAND_LABELS = ["31", "63", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];

/** 增益可调范围（dB），与网易云一致 */
export const EQ_GAIN_RANGE = { min: -12, max: 12 };

/** 低音 / 高音增强范围（dB），旋钮以 0 为中点 */
export const TONE_RANGE = { min: -12, max: 12 };

export interface IEqPreset {
    name: string;
    /** 10 段增益（dB），与 EQ_BANDS 一一对应 */
    eqs: number[];
}

/**
 * 均衡器预设：数值与顺序取自网易云客户端
 * （resources.pack → hybrid/53.chunk 里的预设表），用户认得出这套曲线。
 */
export const EQ_PRESETS: IEqPreset[] = [
    { name: "无", eqs: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { name: "流行", eqs: [-1.5, -1, 0, 1.79, 4, 3.79, 1.79, 0.5, -1, 1] },
    { name: "舞曲", eqs: [4, 5.8, 7, 0, 1.5, 3, 4.59, 4, 3.2, 0] },
    { name: "蓝调", eqs: [2, 6, 4.5, 0, -2.2, -1.5, 2, 2.5, 1.79, 3] },
    { name: "古典", eqs: [4.5, 4, 3, 2.29, -1, -1.2, 0, 1.79, 3, 4.5] },
    { name: "爵士", eqs: [3.2, 3, 1.5, 2.4, -1.5, -1, 0, 1.6, 2, 4.5] },
    { name: "慢歌", eqs: [2, 0, 0.6, 0, -0.8, 0, 0, 0, -1, 1] },
    { name: "电音", eqs: [5, 6.09, 5.2, 0, -1.6, 1.5, 0, 1, 4.57, 3.77] },
    { name: "摇滚", eqs: [4.5, 3.09, 3.4, 1.2, 0, -1, 0, 1.5, 2.79, 4.5] },
    { name: "乡村", eqs: [0, 2.2, 3, 0.6, 0, 2.29, 3.09, 1, -0.19, -0.3] },
    { name: "ACG", eqs: [4, 6.19, 3.5, -0.5, -0.8, 2, 5.19, 1, 1.5, 4] },
    { name: "低音", eqs: [6, 4.5, 6.2, 2.09, 0, 0, 0, 0, 0, 0] },
    { name: "超重低音", eqs: [6, 5.5, 8.3, 2.07, 0, 0, 0, 0, 0, 0] },
    { name: "低音&高音", eqs: [6, 5, 6.2, 1.5, 0, 0, 1, 3.2, 4, 0] },
    { name: "扬声器", eqs: [-6, -4, -2, 2, 3.5, 5.09, 3.4, 0, -3.08, -7.69] },
    { name: "现场", eqs: [5.59, 5, 6, 0, -1, 0, 3.09, 4.5, 6, 5] },
    { name: "中音", eqs: [-2, -3, -3.5, 0, 1.29, 4.5, 3.2, 2, -1.5, -2] },
    { name: "柔和", eqs: [0.5, 0.3, 0, 0, 0, 0, -0.5, -2.08, -2.79, 0] },
    { name: "柔和低音", eqs: [3.5, 2.2, 1, 0.6, 0, 0, 0, -2, -2.5, -2] },
    { name: "柔和高音", eqs: [-3, -1.88, 0, 0, 0, 0, -0.5, -1.28, 3.2, 2] },
    { name: "重金属", eqs: [-2.5, 5.29, 4.49, -2, -2.09, -1.6, 2.09, 3, 1.11, 4] },
    { name: "国风", eqs: [4, 2, 2, -0.5, -1, 3.5, 4.5, 1, 1, 3] },
    { name: "民谣", eqs: [0, 3, 0, -0.8, 1.5, 4.8, 5.8, 3.2, 0.5, 2] },
    { name: "说唱", eqs: [5.6, 5.09, 4, 0.5, -2, 1.2, 3.79, 0.5, 3.5, 4] },
];

/** 手工拖过推子后预设切到这个标签：它不对应任何内置曲线 */
export const CUSTOM_PRESET_NAME = "自定义";

/** 用户「保存」下来的曲线：单独存一份，切走预设再切回来能还原 */
export const USER_PRESET_NAME = "我的音效";

/** 与「保存」按钮对应的一份自定义曲线（只在用户点过保存后存在） */
export interface IUserPreset {
    eqs: number[];
    bass: number;
    treble: number;
    surroundDepth: number;
    surroundStrength: number;
}

export interface IAudioEffectSettings {
    /** 总开关：关掉时若已接管则整条链归零（等效旁路），未接管则不接管 */
    enabled: boolean;
    /** 当前预设名；等于 CUSTOM_PRESET_NAME 表示手工调整过 */
    preset: string;
    /** 10 段增益（dB） */
    eqs: number[];
    /** 低音增强（dB，0 为关） */
    bass: number;
    /** 高音增强（dB，0 为关） */
    treble: number;
    /** 环绕深度 −1~+1：越大侧信号延迟越明显（负值按 0 处理） */
    surroundDepth: number;
    /** 环绕强度 −1~+1：0 为原始立体声，正值展宽、负值收窄 */
    surroundStrength: number;
    /** 环境音效（混响）预设名，见 REVERB_PRESETS；"无" 表示不加混响 */
    reverb: string;
    /** 用户保存的曲线；没保存过为 null */
    userPreset: IUserPreset | null;
}

const STORAGE_KEY = "audioEffect";

/** 没选中任何环境音效时的值 */
export const REVERB_OFF = "无";

const DEFAULT_AUDIO_EFFECT: IAudioEffectSettings = {
    enabled: false,
    preset: "无",
    eqs: new Array(EQ_BANDS.length).fill(0),
    bass: 0,
    treble: 0,
    surroundDepth: 0,
    surroundStrength: 0,
    reverb: REVERB_OFF,
    userPreset: null,
};

/** 环绕参数的取值范围：与界面上 −/+ 滑块一致 */
export const SURROUND_RANGE = { min: -1, max: 1 };

/**
 * 环境音效（混响）预设：名字沿用网易云那套「浴室 / 教堂 / 演唱会…」的叫法。
 *
 * 不搬它的 .ncae 二进制滤波参数，因为那是给自家 DSP 用的；这里用
 * 卷积混响 + 一段按预设生成的脉冲响应来近似听感，参数只要「房间大小」与
 * 「衰减时间」两项就能覆盖从房间到大厅的跨度。
 *
 * size：房间尺寸（秒，决定早期反射的疏密上限）
 * decay：混响衰减时间 RT60（秒）
 * wet：湿声比例（0~1，越大环境声越明显）
 */
export interface IReverbPreset {
    name: string;
    size: number;
    decay: number;
    wet: number;
}

export const REVERB_PRESETS: IReverbPreset[] = [
    { name: "无", size: 0, decay: 0, wet: 0 },
    { name: "浴室", size: 0.012, decay: 0.5, wet: 0.16 },
    { name: "房间", size: 0.02, decay: 0.7, wet: 0.18 },
    { name: "地下通道", size: 0.05, decay: 1.6, wet: 0.3 },
    { name: "声乐板", size: 0.03, decay: 1.1, wet: 0.22 },
    { name: "弹簧", size: 0.06, decay: 1.9, wet: 0.32 },
    { name: "音乐厅", size: 0.08, decay: 2.4, wet: 0.28 },
    { name: "教堂", size: 0.1, decay: 3.4, wet: 0.34 },
    { name: "大厅", size: 0.11, decay: 3.0, wet: 0.3 },
    { name: "演唱会", size: 0.09, decay: 2.6, wet: 0.26 },
    { name: "夜店", size: 0.07, decay: 2.0, wet: 0.24 },
];

/** 低音增强搁架滤波器的转折频率 */
const BASS_FREQ = 200;
/** 高音增强搁架滤波器的转折频率 */
const TREBLE_FREQ = 6000;

/**
 * 软削波曲线（WaveShaper 用）。
 *
 * 为什么不用 DynamicsCompressor 当限幅器：实测三段 +12dB 叠加时，
 * 压缩器只能把峰值压到 1.22，仍然过载；而且它对平直信号也有轻微改变
 * （0.2747 → 0.2926），等于没开音效也在动声音。
 *
 * 这条曲线是「线性到 0.6，之后 tanh 平滑收到 1.0」：小信号完全不动，
 * 大信号被柔和压住而不是硬切。实测同一组极端参数下峰值 1.0009。
 */
function buildSoftClipCurve(samples = 2048, knee = 0.6): Float32Array<ArrayBuffer> {
    const curve = new Float32Array(new ArrayBuffer(samples * 4));
    const tanhMax = Math.tanh(1.2);
    for (let i = 0; i < samples; i += 1) {
        const x = (i / (samples - 1)) * 2 - 1;
        const abs = Math.abs(x);
        let y: number;
        if (abs <= knee) {
            y = abs;
        } else {
            const t = (abs - knee) / (1 - knee);
            y = knee + (1 - knee) * (Math.tanh(t * 1.2) / tanhMax);
        }
        curve[i] = Math.sign(x) * y;
    }
    return curve;
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

/** 把任意来源的设置收敛成合法值（长度不对补齐、超范围夹住） */
function normalizeSettings(
    raw: Partial<IAudioEffectSettings> | null | undefined,
): IAudioEffectSettings {
    if (!raw || typeof raw !== "object") {
        return { ...DEFAULT_AUDIO_EFFECT, eqs: [...DEFAULT_AUDIO_EFFECT.eqs] };
    }
    const eqs = Array.isArray(raw.eqs) ? raw.eqs : [];
    return {
        enabled: !!raw.enabled,
        preset:
            typeof raw.preset === "string" && raw.preset ? raw.preset : DEFAULT_AUDIO_EFFECT.preset,
        eqs: EQ_BANDS.map((_, i) =>
            Number.isFinite(eqs[i])
                ? clamp(Number(eqs[i]), EQ_GAIN_RANGE.min, EQ_GAIN_RANGE.max)
                : 0,
        ),
        bass: Number.isFinite(raw.bass)
            ? clamp(Number(raw.bass), TONE_RANGE.min, TONE_RANGE.max)
            : 0,
        treble: Number.isFinite(raw.treble)
            ? clamp(Number(raw.treble), TONE_RANGE.min, TONE_RANGE.max)
            : 0,
        surroundDepth: Number.isFinite(raw.surroundDepth)
            ? clamp(Number(raw.surroundDepth), SURROUND_RANGE.min, SURROUND_RANGE.max)
            : 0,
        surroundStrength: Number.isFinite(raw.surroundStrength)
            ? clamp(Number(raw.surroundStrength), SURROUND_RANGE.min, SURROUND_RANGE.max)
            : 0,
        reverb:
            typeof raw.reverb === "string" && REVERB_PRESETS.some((p) => p.name === raw.reverb)
                ? raw.reverb
                : REVERB_OFF,
        userPreset: normalizeUserPreset(raw.userPreset),
    };
}

function normalizeUserPreset(raw: any): IUserPreset | null {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.eqs)) {
        return null;
    }
    return {
        eqs: EQ_BANDS.map((_, i) =>
            Number.isFinite(raw.eqs[i])
                ? clamp(Number(raw.eqs[i]), EQ_GAIN_RANGE.min, EQ_GAIN_RANGE.max)
                : 0,
        ),
        bass: Number.isFinite(raw.bass)
            ? clamp(Number(raw.bass), TONE_RANGE.min, TONE_RANGE.max)
            : 0,
        treble: Number.isFinite(raw.treble)
            ? clamp(Number(raw.treble), TONE_RANGE.min, TONE_RANGE.max)
            : 0,
        surroundDepth: Number.isFinite(raw.surroundDepth)
            ? clamp(Number(raw.surroundDepth), SURROUND_RANGE.min, SURROUND_RANGE.max)
            : 0,
        surroundStrength: Number.isFinite(raw.surroundStrength)
            ? clamp(Number(raw.surroundStrength), SURROUND_RANGE.min, SURROUND_RANGE.max)
            : 0,
    };
}

const store = getDefaultStore();
const audioEffectAtom = atom<IAudioEffectSettings>(
    normalizeSettings(getConfig(STORAGE_KEY, null)),
);

/** 给「点完一项要重弹」的菜单用：它们拿不到最新 hook 快照，只能现读 */
function getAudioEffectSettings(): IAudioEffectSettings {
    return store.get(audioEffectAtom);
}

/** 响应式读取：开关亮不亮、面板里的推子位置都跟着它走 */
export function useAudioEffect(): IAudioEffectSettings {
    return useAtomValue(audioEffectAtom);
}

/** ---------- Web Audio 图 ---------- */

interface IGraph {
    ctx: AudioContext;
    /** 所有 <audio> 汇入这里 */
    input: GainNode;
    eqFilters: BiquadFilterNode[];
    bassFilter: BiquadFilterNode;
    trebleFilter: BiquadFilterNode;
    /** 均衡之后的插入点：环绕模块从这里分出去 */
    toneOut: GainNode;
    /** 环绕：M/S 宽度矩阵的侧信号支路 */
    surround: ISurroundNodes;
    /** 环境音效：卷积混响（干湿比由 convolver 前后的增益控制） */
    reverb: IReverbNodes;
    /** 软削波：增益堆多了不破音（小信号不受影响） */
    softClip: WaveShaperNode;
    /** 湿声（经过音效链）与干声（原始直通）的切换增益，用来做真正的旁路 */
    wetGain: GainNode;
    dryGain: GainNode;
    output: GainNode;
}

/**
 * 环绕节点组：把立体声拆成 M（中间）/S（两侧），
 * 对 S 做延迟与增益，再按 L=M+S·w、R=M−S·w 合回去。
 *
 * 为什么用 M/S 而不是直接给左右声道加不同延迟：
 *  - 侧信号只携带左右差异，单声道素材的 S 恒为 0，所以单声道歌不会因为
 *    加了环绕就变得东倒西歪——实测各种环绕设置下 L/R 始终相等；
 *  - 深度做延迟（时间差产生空间感），强度做 S 的增益（差异越大越「宽」）。
 */
interface ISurroundNodes {
    upmix: GainNode;
    splitter: ChannelSplitterNode;
    /** 左→M、右→M 的 0.5 权重 */
    leftToMid: GainNode;
    rightToMid: GainNode;
    midSum: GainNode;
    /** 左→S(+0.5)、右→S(−0.5) */
    leftToSide: GainNode;
    rightToSide: GainNode;
    sideSum: GainNode;
    /** 环绕深度：侧信号的延迟量（毫秒级） */
    sideDelay: DelayNode;
    /** 环绕强度：侧信号回到左右的增益 */
    sideWidth: GainNode;
    /** 把 −S 送到右声道 */
    sideNegate: GainNode;
    merger: ChannelMergerNode;
}

let graph: IGraph | null = null;

/** 环境音效节点组：干声直通 + 湿声经卷积混响，两者按 wet 混合 */
interface IReverbNodes {
    convolver: ConvolverNode;
    /** 湿声比例（0 = 完全干声） */
    wetGain: GainNode;
    /** 干声比例（1 − wet） */
    dryGain: GainNode;
    /** 已载入的预设名与对应的脉冲响应缓存（切换同一预设不重建） */
    current: string;
}

/** 元素 → MediaElementSource（一个元素只能接管一次，按元素缓存） */
const sourceMap = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
/** 反向记录（WeakMap 不能遍历）：设置变化时要能把所有活着的元素接上 */
const liveElements = new Set<HTMLMediaElement>();

function buildSurround(ctx: AudioContext): ISurroundNodes {
    const upmix = ctx.createGain();
    // 强制上混成立体声：单声道进来时 L=R=原信号，S 支路自然相消为 0
    upmix.channelCount = 2;
    upmix.channelCountMode = "explicit";
    upmix.channelInterpretation = "speakers";

    const splitter = ctx.createChannelSplitter(2);

    const leftToMid = ctx.createGain();
    const rightToMid = ctx.createGain();
    leftToMid.gain.value = 0.5;
    rightToMid.gain.value = 0.5;
    const midSum = ctx.createGain();

    const leftToSide = ctx.createGain();
    const rightToSide = ctx.createGain();
    leftToSide.gain.value = 0.5;
    rightToSide.gain.value = -0.5;
    const sideSum = ctx.createGain();

    const sideDelay = ctx.createDelay(0.08);
    sideDelay.delayTime.value = 0;
    const sideWidth = ctx.createGain();
    sideWidth.gain.value = 1;
    const sideNegate = ctx.createGain();
    sideNegate.gain.value = -1;

    const merger = ctx.createChannelMerger(2);

    upmix.connect(splitter);
    splitter.connect(leftToMid, 0);
    splitter.connect(rightToMid, 1);
    leftToMid.connect(midSum);
    rightToMid.connect(midSum);

    splitter.connect(leftToSide, 0);
    splitter.connect(rightToSide, 1);
    leftToSide.connect(sideSum);
    rightToSide.connect(sideSum);

    sideSum.connect(sideDelay);
    sideDelay.connect(sideWidth);
    // L = M + S·w，R = M − S·w
    midSum.connect(merger, 0, 0);
    midSum.connect(merger, 0, 1);
    sideWidth.connect(merger, 0, 0);
    sideWidth.connect(sideNegate);
    sideNegate.connect(merger, 0, 1);

    return {
        upmix,
        splitter,
        leftToMid,
        rightToMid,
        midSum,
        leftToSide,
        rightToSide,
        sideSum,
        sideDelay,
        sideWidth,
        sideNegate,
        merger,
    };
}

/**
 * 生成一段混响脉冲响应（指数衰减的噪声）。
 *
 * 直接拿白噪声乘一条指数衰减包络，这是卷积混响最经典的「够用」做法：
 * 包络决定 RT60（衰减到 −60dB 的时间），前 size 秒混入直达/早期反射感。
 * 立体声双声道用不同随机相位，听感比单声道铺开。
 */
function buildImpulseResponse(
    ctx: BaseAudioContext,
    size: number,
    decay: number,
): AudioBuffer {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * (size + decay)));
    const buffer = ctx.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel += 1) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < length; i += 1) {
            const t = i / rate;
            // 早期反射区（前 size 秒）给一点增强，模拟墙面反射
            const early = t < size ? 1.6 : 1;
            // 指数衰减包络：-60dB 落在 decay 秒处
            const envelope = Math.exp((-6.9078 * Math.max(0, t - size)) / Math.max(decay, 0.01));
            data[i] = (Math.random() * 2 - 1) * envelope * early;
        }
    }
    return buffer;
}

function buildReverb(ctx: AudioContext): IReverbNodes {
    const convolver = ctx.createConvolver();
    const wetGain = ctx.createGain();
    const dryGain = ctx.createGain();
    wetGain.gain.value = 0;
    dryGain.gain.value = 1;
    return { convolver, wetGain, dryGain, current: REVERB_OFF };
}

function buildGraph(): IGraph | null {
    if (graph) {
        return graph;
    }
    try {
        const ctx = new AudioContext();
        /**
         * 入口增益兼做「接管补偿」。
         *
         * Chromium 把 <audio> 接进 Web Audio（createMediaElementSource）后，
         * 输出电平会掉到约 68.6%（实测 0.3115 → 0.2136，单声道与立体声一致）。
         * 不补的话「一开音效声音就变小」会很突兀，所以乘 √2 拉回来
         * （实测 √2 恰好回到未接管时的电平）。
         * 这只补元素被接管那一次衰减，不动用户自己的音量条。
         */
        const input = ctx.createGain();
        input.gain.value = Math.SQRT2;
        const eqFilters = EQ_BANDS.map((freq) => {
            const filter = ctx.createBiquadFilter();
            filter.type = "peaking";
            filter.frequency.value = freq;
            // Q=1.0：相邻频点正好一格一个八度，这个 Q 下调整不至于互相吃掉
            filter.Q.value = 1;
            filter.gain.value = 0;
            return filter;
        });
        const bassFilter = ctx.createBiquadFilter();
        bassFilter.type = "lowshelf";
        bassFilter.frequency.value = BASS_FREQ;
        const trebleFilter = ctx.createBiquadFilter();
        trebleFilter.type = "highshelf";
        trebleFilter.frequency.value = TREBLE_FREQ;
        // 均衡后的汇合点：环绕模块从这里取信号
        const toneOut = ctx.createGain();
        const surround = buildSurround(ctx);
        const reverb = buildReverb(ctx);
        const wetGain = ctx.createGain();
        const dryGain = ctx.createGain();
        const output = ctx.createGain();

        /**
         * 软削波：EQ 与低音/高音都是纯增益，几段同时推满能轻松把峰值顶过 1.0，
         * 在系统输出端就是硬削波（破音、发糊）。这里用小信号不变的软削波曲线
         * 把峰值柔和收到 1.0 以内，见 buildSoftClipCurve 的实测对比。
         * oversample 4x 减少削波产生的混叠。
         */
        const softClip = ctx.createWaveShaper();
        softClip.curve = buildSoftClipCurve();
        softClip.oversample = "4x";

        // input → eq… → bass → treble → toneOut → 环绕(M/S) ─┬→ 干声 ────────┐
        //                                                      └→ 卷积混响 → 湿声 ┴→ softClip → wetGain ┐
        //   └──────────────────────────────────────────────────────────────────────────→ dryGain ─┴→ output
        //
        // 干/湿双路（外层）是为了真旁路：关掉音效时完全不经过滤波与混响。
        // 混响内部的干湿比另算一层，用来调环境强度。
        let node: AudioNode = input;
        for (const filter of eqFilters) {
            node.connect(filter);
            node = filter;
        }
        node.connect(bassFilter);
        bassFilter.connect(trebleFilter);
        trebleFilter.connect(toneOut);
        toneOut.connect(surround.upmix);
        // 环绕之后分两路：一路原样（干），一路进卷积混响（湿）
        surround.merger.connect(reverb.dryGain);
        surround.merger.connect(reverb.convolver);
        reverb.convolver.connect(reverb.wetGain);
        reverb.dryGain.connect(softClip);
        reverb.wetGain.connect(softClip);
        softClip.connect(wetGain);
        input.connect(dryGain);
        wetGain.connect(output);
        dryGain.connect(output);
        output.connect(ctx.destination);

        graph = {
            ctx,
            input,
            eqFilters,
            bassFilter,
            trebleFilter,
            toneOut,
            surround,
            reverb,
            softClip,
            wetGain,
            dryGain,
            output,
        };
        /**
         * 系统休眠 / 音频设备切换会让上下文自己挂起，一旦挂起整个图就停止输出，
         * 表现为「歌在走但没声音」。这里在每次挂起时立刻尝试恢复：
         * 有用户手势后 resume 是允许的，静默失败也不影响下次播放。
         */
        ctx.addEventListener("statechange", () => {
            if (ctx.state === "suspended" && getAudioEffectSettings().enabled) {
                void ctx.resume().catch(() => undefined);
            }
        });
        return graph;
    } catch (e: any) {
        console.warn("[audioEffect] Web Audio 初始化失败，音效不可用", e?.message ?? e);
        return null;
    }
}

/**
 * 把一个元素接进总线。已被接管过就跳过。
 *
 * 只有音效开着才接管：接管不可逆（接进图后无法退回原生直出），
 * 而关着的音效只要链路上各增益为 0 就是等效旁路——但那样平白多一层
 * Web Audio 处理，对默认用户没有任何好处，不如完全不碰。
 */
function connectElement(el: HTMLMediaElement) {
    if (sourceMap.has(el)) {
        return;
    }
    const settings = getAudioEffectSettings();
    if (!settings.enabled) {
        return;
    }
    const g = buildGraph();
    if (!g) {
        return;
    }
    /**
     * 上下文挂起时接进来 = 这段声音彻底消失（元素在播、图不输出）。
     * 所以挂起时先唤醒，唤醒是异步的：这次不接，等 resume 落地后再补接一次，
     * 保证「音乐不会因为音效而没声」这条底线优先于「音效立刻生效」。
     */
    if (g.ctx.state !== "running") {
        void g.ctx
            .resume()
            .then(() => {
                // 期间可能被关掉、或元素已退场
                if (getAudioEffectSettings().enabled && liveElements.has(el)) {
                    connectElement(el);
                }
            })
            .catch(() => undefined);
        return;
    }
    try {
        const source = g.ctx.createMediaElementSource(el);
        source.connect(g.input);
        sourceMap.set(el, source);
    } catch (e: any) {
        console.warn("[audioEffect] 接管音频元素失败", e?.name ?? e);
    }
}

/** 按当前设置刷参数：关掉时切到干声（真旁路），开着时湿声按曲线走 */
function applySettingsToGraph(settings: IAudioEffectSettings) {
    const g = graph;
    if (!g) {
        return;
    }
    const on = settings.enabled;
    // 干/湿二选一，避免两路叠加把音量抬高一倍
    g.wetGain.gain.value = on ? 1 : 0;
    g.dryGain.gain.value = on ? 0 : 1;
    g.eqFilters.forEach((filter, i) => {
        filter.gain.value = on ? settings.eqs[i] ?? 0 : 0;
    });
    g.bassFilter.gain.value = on ? settings.bass : 0;
    g.trebleFilter.gain.value = on ? settings.treble : 0;
    applySurround(g.surround, on ? settings.surroundDepth : 0, on ? settings.surroundStrength : 0);
    applyReverb(g.reverb, on ? settings.reverb : REVERB_OFF, g.ctx);
}

/**
 * 套用环境音效。切换预设时才重建脉冲响应（卷积核计算不便宜），
 * 同一预设重复调用只更新干湿比。
 */
function applyReverb(nodes: IReverbNodes, presetName: string, ctx: BaseAudioContext) {
    const preset =
        REVERB_PRESETS.find((item) => item.name === presetName) ?? REVERB_PRESETS[0];
    const isOff = preset.name === REVERB_OFF || preset.wet <= 0;
    if (nodes.current !== preset.name) {
        nodes.current = preset.name;
        // "无" 时清掉卷积核，省下持续运算
        nodes.convolver.buffer = isOff
            ? null
            : buildImpulseResponse(ctx, preset.size, preset.decay);
    }
    nodes.wetGain.gain.value = isOff ? 0 : preset.wet;
    nodes.dryGain.gain.value = isOff ? 1 : 1 - preset.wet * 0.5;
}

/**
 * 环绕参数落到侧信号上。两个参数都是 −1~+1、0 为「不做改变」，与界面上
 * 那两根「−/+」滑块的语义一致：
 *
 * 深度 → 侧信号延迟（0~18ms）。几毫秒以内的差异会让大脑判成「空间变宽」，
 *        再长就听成回声了，所以上限压在 18ms。负值没有物理意义，按 0 处理。
 * 强度 → 侧信号回到左右的增益：0 时正好是 1（L/R 原样还原），
 *        +1 展宽到 1.8 倍，−1 收窄到 0.2 倍（趋近单声道）。
 */
function applySurround(s: ISurroundNodes, depth: number, strength: number) {
    s.sideDelay.delayTime.value = Math.max(0, depth) * 0.018;
    s.sideWidth.gain.value = 1 + strength * 0.8;
}

/** 写设置：收敛 → atom → 落盘 → 同步音频图。所有改动都走这一个入口 */
function commitSettings(next: IAudioEffectSettings) {
    const normalized = normalizeSettings(next);
    store.set(audioEffectAtom, normalized);
    setConfig(STORAGE_KEY, normalized);
    applySettingsToGraph(normalized);
    // 刚从关变开：把此刻所有活着的元素一次性接上（含正在播的那首）
    if (normalized.enabled) {
        liveElements.forEach(connectElement);
        const g = buildGraph();
        if (g?.ctx.state === "suspended") {
            void g.ctx.resume().catch(() => undefined);
        }
    }
}

/**
 * 播放器每建一个 <audio> 都登记一次（正片、换音质影子、预载影子）。
 * 音效开着时立刻接管；关着时只记下来，等用户打开音效再接。
 */
export function registerMediaElement(el: HTMLMediaElement) {
    liveElements.add(el);
    connectElement(el);
}

/** 元素退场（retireAudioElement）时解除登记：否则集合会随播放不断变长 */
export function unregisterMediaElement(el: HTMLMediaElement) {
    liveElements.delete(el);
    const source = sourceMap.get(el);
    if (!source) {
        return;
    }
    try {
        source.disconnect();
    } catch {
        // ignore
    }
    sourceMap.delete(el);
}

/** 总开关 */
export function setEffectEnabled(enabled: boolean) {
    const current = getAudioEffectSettings();
    if (current.enabled === enabled) {
        return;
    }
    commitSettings({ ...current, enabled });
}

/** 套用内置预设（预设本身就是完整曲线，低音/高音保持用户自己的设置） */
export function applyPreset(name: string) {
    const current = getAudioEffectSettings();
    // 「我的音效」来自用户保存那份，不是内置表里的一条
    if (name === USER_PRESET_NAME) {
        if (!current.userPreset) {
            return;
        }
        const { eqs, bass, treble, surroundDepth, surroundStrength } = current.userPreset;
        commitSettings({
            ...current,
            preset: USER_PRESET_NAME,
            eqs: [...eqs],
            bass,
            treble,
            surroundDepth,
            surroundStrength,
        });
        return;
    }
    const preset = EQ_PRESETS.find((item) => item.name === name);
    if (!preset) {
        return;
    }
    commitSettings({ ...current, preset: preset.name, eqs: [...preset.eqs] });
}

/** 把当前这套参数存成「我的音效」（对应截图里的「保存」） */
export function saveUserPreset() {
    const current = getAudioEffectSettings();
    commitSettings({
        ...current,
        preset: USER_PRESET_NAME,
        userPreset: {
            eqs: [...current.eqs],
            bass: current.bass,
            treble: current.treble,
            surroundDepth: current.surroundDepth,
            surroundStrength: current.surroundStrength,
        },
    });
}

/** 拖某一根推子：预设自动切成「自定义」 */
export function setBandGain(index: number, gain: number) {
    if (index < 0 || index >= EQ_BANDS.length) {
        return;
    }
    const current = getAudioEffectSettings();
    const eqs = [...current.eqs];
    eqs[index] = clamp(gain, EQ_GAIN_RANGE.min, EQ_GAIN_RANGE.max);
    commitSettings({ ...current, preset: CUSTOM_PRESET_NAME, eqs });
}

/**
 * 拖动中的即时预览：只刷音频图与 atom，不写 localStorage。
 *
 * 推子拖动每帧都会回调一次，走 commitSettings 会往 storage 里灌上百条记录
 * （localStorage 是同步写，拖一根推子就卡）。松手时才走 setBandGain 落盘。
 */
export function previewBand(index: number, gain: number) {
    if (index < 0 || index >= EQ_BANDS.length) {
        return;
    }
    const current = getAudioEffectSettings();
    const eqs = [...current.eqs];
    eqs[index] = clamp(gain, EQ_GAIN_RANGE.min, EQ_GAIN_RANGE.max);
    const next: IAudioEffectSettings = { ...current, preset: CUSTOM_PRESET_NAME, eqs };
    store.set(audioEffectAtom, next);
    applySettingsToGraph(next);
}

/** 低音 / 高音的拖动预览（同样不落盘） */
export function previewTone(kind: "bass" | "treble", gain: number) {
    const current = getAudioEffectSettings();
    const next: IAudioEffectSettings = {
        ...current,
        [kind]: clamp(gain, TONE_RANGE.min, TONE_RANGE.max),
    };
    store.set(audioEffectAtom, next);
    applySettingsToGraph(next);
}

/** 低音 / 高音增强 */
export function setBassGain(gain: number) {
    const current = getAudioEffectSettings();
    commitSettings({ ...current, bass: clamp(gain, TONE_RANGE.min, TONE_RANGE.max) });
}

export function setTrebleGain(gain: number) {
    const current = getAudioEffectSettings();
    commitSettings({ ...current, treble: clamp(gain, TONE_RANGE.min, TONE_RANGE.max) });
}

/** 环绕深度 / 强度的预览（拖动中，不落盘） */
export function previewSurround(kind: "depth" | "strength", value: number) {
    const current = getAudioEffectSettings();
    const clamped = clamp(value, SURROUND_RANGE.min, SURROUND_RANGE.max);
    const next: IAudioEffectSettings = {
        ...current,
        [kind === "depth" ? "surroundDepth" : "surroundStrength"]: clamped,
    };
    store.set(audioEffectAtom, next);
    applySettingsToGraph(next);
}

/** 环绕深度 / 强度（松手落盘） */
export function setSurround(kind: "depth" | "strength", value: number) {
    const current = getAudioEffectSettings();
    const clamped = clamp(value, SURROUND_RANGE.min, SURROUND_RANGE.max);
    commitSettings({
        ...current,
        [kind === "depth" ? "surroundDepth" : "surroundStrength"]: clamped,
    });
}

/** 环境音效（混响）预设 */
export function setReverbPreset(name: string) {
    const current = getAudioEffectSettings();
    const preset = REVERB_PRESETS.find((item) => item.name === name);
    commitSettings({ ...current, reverb: preset ? preset.name : REVERB_OFF });
}

/** 全部归零（含低音/高音与环绕） */
export function resetEqualizer() {
    const current = getAudioEffectSettings();
    commitSettings({
        ...current,
        preset: "无",
        eqs: new Array(EQ_BANDS.length).fill(0),
        bass: 0,
        treble: 0,
        surroundDepth: 0,
        surroundStrength: 0,
    });
}
