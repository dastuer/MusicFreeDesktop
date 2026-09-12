import fs from "fs";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import CryptoJs from "crypto-js";
import dayjs from "dayjs";
import bigInt from "big-integer";
import qs from "qs";
import he from "he";
import * as webdav from "webdav";
import { satisfies } from "compare-versions";
import configStoreInstance from "./configStore";
import coverCache, { isOversizedDataUrl } from "./coverCache";

const sha256 = (s: string) => CryptoJs.SHA256(s).toString();
const appVersion = "1.0.0";

/** 与 MusicFree 移动端一致的插件可用依赖包 */
const packages: Record<string, any> = {
    cheerio,
    "crypto-js": CryptoJs,
    axios,
    dayjs,
    "big-integer": bigInt,
    qs,
    he,
    "@react-native-cookies/cookies": {
        get: () => null,
        set: () => null,
        flush: () => null,
    },
    webdav,
};

const _require = (packageName: string) => {
    const pkg = packages[packageName];
    if (!pkg) {
        throw new Error(`package not supported: ${packageName}`);
    }
    pkg.default = pkg;
    return pkg;
};

const _console = {
    log: (...args: any[]) => console.log("[plugin]", ...args),
    warn: (...args: any[]) => console.warn("[plugin]", ...args),
    info: (...args: any[]) => console.info("[plugin]", ...args),
    error: (...args: any[]) => console.error("[plugin]", ...args),
};

axios.defaults.timeout = 20000;
axios.interceptors.response.use((response) => {
    const setCookie = response.headers["set-cookie"];
    if (setCookie && setCookie.length === 1) {
        response.headers["x-set-cookie"] = setCookie;
    }
    return response;
});

export type PluginState = "Initializing" | "Loading" | "Mounted" | "Error";

/** 可传给渲染进程的插件元信息 */
export interface SerializedPlugin {
    name: string;
    hash: string;
    platform: string;
    version: string;
    srcUrl: string;
    author: string;
    description: string;
    state: PluginState;
    errorReason?: string;
    enabled: boolean;
    order: number;
    userVariables: Record<string, string>;
    supportedMethods: string[];
}

interface PluginMeta {
    enabled?: boolean;
    order: number;
    userVariables: Record<string, string>;
}

const serializableKeys = [
    "platform",
    "appVersion",
    "version",
    "srcUrl",
    "primaryKey",
    "defaultSearchType",
    "supportedSearchType",
    "cacheControl",
    "author",
    "description",
    "userVariables",
];

class Plugin {
    name = "";
    hash = "";
    state: PluginState = "Loading";
    errorReason?: string;
    instance: any = { platform: "" };
    path = "";
    supportedMethods: string[] = [];

    constructor(funcCode: string, pluginPath: string) {
        this.mountPlugin(funcCode, pluginPath);
    }

    private mountPlugin(funcCode: string, pluginPath: string) {
        this.state = "Loading";
        let instance: any;
        const _module: any = { exports: {} };
        try {
            const env = {
                getUserVariables: () => this.userVariables,
                get userVariables() {
                    return this.getUserVariables() ?? {};
                },
                appVersion,
                os: "mac",
                lang: "zh-CN",
            };
            const _process = {
                platform: "mac",
                version: appVersion,
                env,
            };

            instance = Function(`
                'use strict';
                return function(require, __musicfree_require, module, exports, console, env, URL, process) {
                    ${funcCode}
                }
            `)()(
                _require,
                _require,
                _module,
                _module.exports,
                _console,
                env,
                URL,
                _process,
            );
            if (_module.exports.default) {
                instance = _module.exports.default;
            } else if (!instance) {
                instance = _module.exports;
            }

            if (Array.isArray(instance.userVariables)) {
                instance.userVariables = instance.userVariables.filter(
                    (it: any) => it?.key,
                );
            }
            if (
                instance.appVersion &&
                !satisfies(appVersion, instance.appVersion)
            ) {
                throw {
                    instance,
                    errorReason: "VersionNotMatch",
                };
            }
            this.state = "Mounted";
        } catch (e: any) {
            this.state = "Error";
            this.errorReason = e?.errorReason ?? "CannotParse";
            console.error("[pluginHost] mount error", e?.message);
            instance = e?.instance ?? {
                platform: "",
                async getMediaSource() { return null; },
                async search() { return {}; },
            };
        }

        this.instance = instance;
        this.path = pluginPath;
        this.name = instance.platform;
        this.supportedMethods = Object.keys(instance).filter(
            (key) => typeof instance[key] === "function",
        );

        if (!this.name) {
            this.hash = "";
            this.state = "Error";
            this.errorReason = this.errorReason ?? "CannotParse";
        } else {
            this.hash = sha256(funcCode);
        }
    }

    private userVariables: Record<string, string> = {};

    setUserVariables(vars: Record<string, string>) {
        this.userVariables = vars;
    }
}

class PluginHost {
    private pluginsDir = "";
    private plugins: Plugin[] = [];
    private meta: Record<string, PluginMeta> = {};
    private configStore!: typeof configStoreInstance;

    setup(pluginsDir: string, configStore: typeof configStoreInstance) {
        this.pluginsDir = pluginsDir;
        this.configStore = configStore;
        this.meta = configStore.get("plugin.meta", {});
        if (!fs.existsSync(pluginsDir)) {
            fs.mkdirSync(pluginsDir, { recursive: true });
        }
        this.loadAll();
    }

    private loadAll() {
        this.plugins = [];
        try {
            const files = fs
                .readdirSync(this.pluginsDir)
                .filter((f) => f.endsWith(".js"));
            for (const file of files) {
                const fullPath = path.join(this.pluginsDir, file);
                try {
                    const code = fs.readFileSync(fullPath, "utf-8");
                    const plugin = new Plugin(code, fullPath);
                    if (plugin.state === "Mounted") {
                        this.plugins.push(plugin);
                        plugin.setUserVariables(
                            this.meta[plugin.hash]?.userVariables ?? {},
                        );
                    } else {
                        console.error(`[pluginHost] ${file} load failed: ${plugin.errorReason}`);
                    }
                } catch (e) {
                    console.error(`[pluginHost] read plugin failed: ${file}`, e);
                }
            }
            this.plugins.sort(
                (a, b) => (this.meta[a.hash]?.order ?? 999) - (this.meta[b.hash]?.order ?? 999),
            );
        } catch (e) {
            console.error("[pluginHost] loadAll error", e);
        }
    }

    private saveMeta(hash: string, patch: Partial<PluginMeta>) {
        this.meta[hash] = {
            order: this.meta[hash]?.order ?? this.plugins.length,
            userVariables: this.meta[hash]?.userVariables ?? {},
            enabled: this.meta[hash]?.enabled ?? true,
            ...patch,
        };
        this.configStore.set("plugin.meta", this.meta);
    }

    private serialize(p: Plugin): SerializedPlugin {
        const inst = p.instance;
        return {
            name: p.name,
            hash: p.hash,
            platform: p.name,
            version: inst.version ?? "",
            srcUrl: inst.srcUrl ?? "",
            author: inst.author ?? "",
            description: inst.description ?? "",
            state: p.state,
            errorReason: p.errorReason,
            enabled: this.meta[p.hash]?.enabled ?? true,
            order: this.meta[p.hash]?.order ?? 999,
            userVariables: this.meta[p.hash]?.userVariables ?? {},
            supportedMethods: p.supportedMethods,
        };
    }

    getSerializedPlugins(): SerializedPlugin[] {
        return this.plugins.map((p) => this.serialize(p));
    }

    private getByHash(hash: string): Plugin | undefined {
        return this.plugins.find((p) => p.hash === hash);
    }

    async installPluginFromLocalFile(pluginPath: string, config?: { notCheckVersion?: boolean }) {
        try {
            if (!fs.existsSync(pluginPath)) {
                return { success: false, message: "文件不存在" };
            }
            const code = fs.readFileSync(pluginPath, "utf-8");
            const plugin = new Plugin(code, pluginPath);
            if (plugin.state !== "Mounted") {
                return { success: false, message: `插件无法解析：${plugin.errorReason}` };
            }
            const existing = this.getByHash(plugin.hash);
            if (existing) {
                return { success: false, message: "该插件已安装", pluginName: plugin.name };
            }
            const dest = path.join(this.pluginsDir, `${plugin.hash}.js`);
            fs.writeFileSync(dest, code, "utf-8");
            plugin.path = dest;
            this.plugins.push(plugin);
            this.saveMeta(plugin.hash, { enabled: true, order: this.plugins.length });
            return {
                success: true,
                pluginName: plugin.name,
                pluginHash: plugin.hash,
                pluginUrl: plugin.instance.srcUrl,
            };
        } catch (e: any) {
            return { success: false, message: e?.message ?? String(e) };
        }
    }

    async installPluginFromUrl(url: string, config?: { notCheckVersion?: boolean }) {
        try {
            const res = await axios.get(url, { timeout: 30000 });
            const code = res.data?.toString() ?? "";
            if (!code.length) {
                return { success: false, message: "插件源返回为空" };
            }
            const tmp = path.join(this.pluginsDir, `tmp-${Date.now()}.js`);
            fs.writeFileSync(tmp, code, "utf-8");
            const result = await this.installPluginFromLocalFile(tmp, config);
            fs.unlinkSync(tmp);
            return result;
        } catch (e: any) {
            return { success: false, message: e?.message ?? String(e) };
        }
    }

    uninstallPlugin(hash: string) {
        const idx = this.plugins.findIndex((p) => p.hash === hash);
        if (idx >= 0) {
            const plugin = this.plugins[idx];
            try {
                if (fs.existsSync(plugin.path)) {
                    fs.unlinkSync(plugin.path);
                }
            } catch { /* ignore */ }
            delete this.meta[hash];
            this.configStore.set("plugin.meta", this.meta);
            this.plugins.splice(idx, 1);
        }
    }

    setPluginEnabled(hash: string, enabled: boolean) {
        this.saveMeta(hash, { enabled });
    }

    setPluginOrder(hashes: string[]) {
        hashes.forEach((hash, i) => {
            this.saveMeta(hash, { order: i });
        });
        this.plugins.sort(
            (a, b) => (this.meta[a.hash]?.order ?? 999) - (this.meta[b.hash]?.order ?? 999),
        );
    }

    setUserVariables(hash: string, vars: Record<string, string>) {
        this.saveMeta(hash, { userVariables: vars });
        this.getByHash(hash)?.setUserVariables(vars);
    }

    getEnabledPlugins(): Plugin[] {
        return this.plugins.filter(
            (p) => p.state === "Mounted" && (this.meta[p.hash]?.enabled ?? true),
        );
    }

    /** 给插件返回的媒体项补上 platform（与移动端 resetMediaItem 行为一致）
     *  递归处理：getTopLists 返回 [分组数组 → 分组.data → 条目] 的嵌套结构
     *  `pendingArtwork` 收集需要异步落盘的大体积内联封面（见 callMethod） */
    private patchResultPlatform(result: any, platform: string, depth = 0, pendingArtwork?: any[]) {
        if (!result || typeof result !== "object" || depth > 3) {
            return;
        }
        if (Array.isArray(result)) {
            result.forEach((el) => this.patchResultPlatform(el, platform, depth + 1, pendingArtwork));
            return;
        }
        const patchItem = (item: any) => {
            if (item && typeof item === "object") {
                if (!item.platform) {
                    item.platform = platform;
                }
                // 部分插件用 coverImg 传递封面，统一映射到 artwork
                if (!item.artwork && item.coverImg) {
                    item.artwork = item.coverImg;
                }
                // 实测有些音源把整张封面塞成 base64（migu 返回过 13 MB 的 PNG）。
                // 原样带下去会灌进 localStorage / store.json / MediaMetadata，
                // 这里挑出来交给调用方落盘换短链。
                if (isOversizedDataUrl(item.artwork)) {
                    if (pendingArtwork) {
                        pendingArtwork.push(item);
                    } else {
                        item.artwork = "";
                    }
                }
            }
        };
        // 单个媒体项（如 getMusicInfo 返回值）
        if (result.id && result.title) {
            patchItem(result);
        }
        ["data", "musicList", "pinned"].forEach((key) => {
            if (Array.isArray(result[key])) {
                result[key].forEach(patchItem);
            }
        });
    }

    /** 按平台查找已启用的插件 */
    getByPlatform(platform: string): Plugin | undefined {
        return this.getEnabledPlugins().find((p) => p.name === platform);
    }

    /** 供下载服务解析音源：按音质尝试，失败降级 standard */
    async resolveMedia(
        musicItem: { platform: string; [k: string]: any },
        quality: string,
    ): Promise<{ url: string; headers?: Record<string, string>; userAgent?: string } | null> {
        const plugin = this.getByPlatform(musicItem.platform);
        if (!plugin || typeof plugin.instance.getMediaSource !== "function") {
            // 无插件时尝试媒体项自带 url
            return musicItem.url ? { url: musicItem.url } : null;
        }
        for (const q of [quality, "standard"]) {
            try {
                const src = await plugin.instance.getMediaSource(musicItem, q);
                if (src?.url) {
                    return src;
                }
            } catch {
                // 尝试下一档音质
            }
        }
        return null;
    }

    /** 渲染进程统一调用入口 */
    async callMethod(hash: string, method: string, args: any[]) {
        const plugin = this.getByHash(hash);
        if (!plugin) {
            throw new Error("插件不存在或已卸载");
        }
        if (!(this.meta[hash]?.enabled ?? true)) {
            throw new Error("插件已被禁用");
        }
        const fn = plugin.instance[method];
        if (typeof fn !== "function") {
            throw new Error(`插件不支持 ${method}`);
        }
        const result = await fn.apply(plugin.instance, args);
        const pendingArtwork: any[] = [];
        this.patchResultPlatform(result, plugin.name, 0, pendingArtwork);
        // 大体积内联封面落盘换短链（只写一次，之后命中同名跳过）
        if (pendingArtwork.length) {
            await Promise.all(
                pendingArtwork.map(async (item) => {
                    const link = await coverCache.putDataUrl(item.artwork);
                    item.artwork = link ?? "";
                }),
            );
        }
        return result;
    }
}

export default new PluginHost();
