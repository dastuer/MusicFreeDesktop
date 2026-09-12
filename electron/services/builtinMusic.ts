import fs from "fs";
import path from "path";

/**
 * 内置默认音乐：首次启动时在 userData 下合成几首示例曲目（纯 Node 生成 WAV），
 * 无需网络与插件即可试播，用于演示播放器功能。
 */

const SAMPLE_RATE = 22050;

interface IBuiltinTrackDef {
    title: string;
    notes: number[];
    noteDur?: number;
    colors: [string, string];
    glyph: string;
}

const TRACK_DEFS: IBuiltinTrackDef[] = [
    {
        title: "晨光 · Morning Light",
        notes: [523.25, 659.25, 783.99, 1046.5, 783.99, 659.25],
        colors: ["#ff9a9e", "#fecfef"],
        glyph: "☀",
    },
    {
        title: "夜色 · Night Fall",
        notes: [392, 329.63, 293.66, 349.23, 392, 261.63],
        colors: ["#2b5876", "#4e4376"],
        glyph: "☾",
    },
    {
        title: "律动 · Pulse",
        notes: [440, 440, 554.37, 659.25, 440, 587.33],
        colors: ["#f7971e", "#ffd200"],
        glyph: "♫",
    },
    {
        title: "远行 · Journey",
        notes: [349.23, 440, 523.25, 440, 349.23, 293.66],
        colors: ["#43cea2", "#185a9d"],
        glyph: "✈",
    },
    {
        title: "细雨 · Drizzle",
        notes: [587.33, 493.88, 440, 493.88, 587.33, 698.46],
        colors: ["#89f7fe", "#66a6ff"],
        glyph: "☔",
    },
    {
        title: "篝火 · Campfire",
        notes: [261.63, 329.63, 392, 329.63, 261.63, 196],
        colors: ["#ff512f", "#dd2476"],
        glyph: "✲",
    },
];

const SECONDS_PER_NOTE = 0.55;

function synth(notes: number[], repeat = 6): Float32Array {
    const seq: number[] = [];
    for (let r = 0; r < repeat; r++) {
        seq.push(...notes, ...notes.slice().reverse());
    }
    const total = Math.ceil(seq.length * SECONDS_PER_NOTE * SAMPLE_RATE);
    const out = new Float32Array(total);
    seq.forEach((freq, i) => {
        const start = Math.floor(i * SECONDS_PER_NOTE * SAMPLE_RATE);
        const len = Math.floor(SECONDS_PER_NOTE * SAMPLE_RATE);
        for (let j = 0; j < len; j++) {
            const t = j / SAMPLE_RATE;
            // 起音/释音包络，避免爆音
            const env =
                Math.min(1, j / (0.03 * SAMPLE_RATE)) *
                Math.min(1, (len - j) / (0.08 * SAMPLE_RATE));
            out[start + j] +=
                0.32 * env * Math.sin(2 * Math.PI * freq * t) +
                0.1 * env * Math.sin(4 * Math.PI * freq * t);
        }
    });
    return out;
}

function writeWav(filePath: string, samples: Float32Array) {
    const n = samples.length;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(1, 22); // mono
    buf.writeUInt32LE(SAMPLE_RATE, 24);
    buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
    }
    fs.writeFileSync(filePath, buf);
}

function artworkDataUrl(colors: [string, string], glyph: string): string {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${colors[0]}'/><stop offset='1' stop-color='${colors[1]}'/></linearGradient></defs><rect width='240' height='240' fill='url(#g)'/><text x='50%' y='60%' font-size='96' text-anchor='middle' fill='rgba(255,255,255,0.9)' font-family='sans-serif'>${glyph}</text></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

class BuiltinMusicService {
    private dir = "";

    setup(dataDir: string) {
        this.dir = path.join(dataDir, "builtin-music");
        if (!fs.existsSync(this.dir)) {
            fs.mkdirSync(this.dir, { recursive: true });
        }
    }

    /** 确保内置曲目已生成并返回列表 */
    list() {
        return TRACK_DEFS.map((def, index) => {
            const fileName = `track-${index + 1}.wav`;
            const localPath = path.join(this.dir, fileName);
            if (!fs.existsSync(localPath)) {
                writeWav(localPath, synth(def.notes));
            }
            const duration = Math.round(def.notes.length * 2 * 6 * SECONDS_PER_NOTE);
            return {
                id: `builtin-${index + 1}`,
                platform: "默认音乐",
                title: def.title,
                artist: "MusicFree 内置",
                album: "默认音乐",
                duration,
                artwork: artworkDataUrl(def.colors, def.glyph),
                localPath,
            };
        });
    }
}

export default new BuiltinMusicService();
