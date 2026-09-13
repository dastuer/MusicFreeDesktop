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
import { satisfies, compare } from "compare-versions";
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

/** 备份文件里的插件条目：只存恢复所需的最小信息 */
export interface IBackupPlugin {
    platform: string;
    srcUrl: string;
    version: string;
    enabled: boolean;
    order: number;
    userVariables: Record<string, string>;
    /**
     * 本地文件安装的插件没有 srcUrl，没法从网络重装，
     * 退化为把源码内嵌进备份文件（体积可接受，恢复时不依赖网络）。
     * 注意：userVariables 与源码可能含接口凭据，备份文件需妥善保管。
     */
    code?: string;
}

export interface IPluginResumeResult {
    installed: number;
    updated: number;
    skipped: number;
    failed: { platform: string; reason: string }[];
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
            this.resort();
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

    getByHash(hash: string): Plugin | undefined {
        return this.plugins.find((p) => p.hash === hash);
    }

    /** 按插件声明的版本号排序用；插件常写 "dev" / 空串，交给 compare 会抛错 */
    private versionOf(p: Plugin | undefined): string {
        const v = p?.instance?.version;
        return typeof v === "string" && v.length ? v : "0.0.0";
    }

    /** a 是否不低于 b；版本号非法时退化为字符串比较，不抛异常 */
    private isVersionNotOlder(a: string, b: string): boolean {
        try {
            return compare(a, b, ">=");
        } catch {
            return a >= b;
        }
    }

    private resort() {
        this.plugins.sort(
            (a, b) =>
                (this.meta[a.hash]?.order ?? 999) - (this.meta[b.hash]?.order ?? 999),
        );
    }

    /** ---------- 备份 / 恢复 ---------- */

    /** 导出当前插件的可恢复描述 */
    backupPlugins(): IBackupPlugin[] {
        return this.plugins.map((p) => {
            const meta = this.meta[p.hash] ?? { order: 999, userVariables: {} };
            const srcUrl: string = p.instance?.srcUrl ?? "";
            const item: IBackupPlugin = {
                platform: p.name,
                srcUrl,
                version: this.versionOf(p),
                enabled: meta.enabled ?? true,
                order: meta.order ?? 999,
                userVariables: meta.userVariables ?? {},
            };
            if (!srcUrl && p.path) {
                try {
                    item.code = fs.readFileSync(p.path, "utf-8");
                } catch {
                    // 读不到源码就只能恢复个名字了，resume 时会记入失败列表
                }
            }
            return item;
        });
    }

    /**
     * 用一段插件源码安装/替换插件。
     * @param replaceHash 升级时被替换掉的旧插件 hash：新插件落盘后删旧文件，
     *   并把旧的启用状态、顺序、用户变量迁移到新 hash，否则升级会丢用户配置。
     */
    installPluginCode(
        code: string,
        options?: { replaceHash?: string },
    ): {
        success: boolean;
        message?: string;
        pluginName?: string;
        pluginHash?: string;
        pluginUrl?: string;
        duplicated?: boolean;
    } {
        const plugin = new Plugin(code, "");
        if (plugin.state !== "Mounted" || !plugin.hash) {
            return {
                success: false,
                message: `插件无法解析：${plugin.errorReason ?? "CannotParse"}`,
            };
        }

        const dest = path.join(this.pluginsDir, `${plugin.hash}.js`);
        try {
            fs.writeFileSync(dest, code, "utf-8");
        } catch (e: any) {
            return { success: false, message: e?.message ?? String(e) };
        }
        plugin.path = dest;

        // 同源码已经装过了：只保证文件在磁盘上，不重复登记
        const sameIdx = this.plugins.findIndex((p) => p.hash === plugin.hash);
        if (sameIdx >= 0) {
            this.plugins[sameIdx].path = dest;
            return {
                success: true,
                pluginName: plugin.name,
                pluginHash: plugin.hash,
                duplicated: true,
            };
        }

        if (options?.replaceHash && options.replaceHash !== plugin.hash) {
            const oldIdx = this.plugins.findIndex((p) => p.hash === options.replaceHash);
            if (oldIdx >= 0) {
                const old = this.plugins[oldIdx];
                try {
                    if (old.path && old.path !== dest && fs.existsSync(old.path)) {
                        fs.unlinkSync(old.path);
                    }
                } catch {
                    // 旧文件删不掉不影响使用，最多留个孤儿文件
                }
                this.plugins.splice(oldIdx, 1);
                const oldMeta = this.meta[options.replaceHash];
                if (oldMeta) {
                    this.meta[plugin.hash] = { ...oldMeta, ...this.meta[plugin.hash] };
                    delete this.meta[options.replaceHash];
                }
            }
        }

        plugin.setUserVariables(this.meta[plugin.hash]?.userVariables ?? {});
        this.plugins.push(plugin);

        // 仅在还没有元数据时补默认值：否则会把刚迁移过来的顺序/开关覆盖掉
        if (!this.meta[plugin.hash]) {
            this.meta[plugin.hash] = {
                order: this.plugins.length,
                userVariables: {},
                enabled: true,
            };
        }
        this.configStore.set("plugin.meta", this.meta);

        return {
            success: true,
            pluginName: plugin.name,
            pluginHash: plugin.hash,
            pluginUrl: plugin.instance.srcUrl,
        };
    }

    /**
     * 恢复备份中的插件：
     * 本地版本已不低于备份版本 -> 只恢复启用状态/顺序/用户变量（不重新下载）；
     * 否则按 srcUrl 重新安装（本地文件安装的插件用内嵌源码兜底）。
     */
    async resumePlugins(list: IBackupPlugin[]): Promise<IPluginResumeResult> {
        const result: IPluginResumeResult = {
            installed: 0,
            updated: 0,
            skipped: 0,
            failed: [],
        };
        for (const item of list ?? []) {
            if (!item || typeof item !== "object") {
                continue;
            }
            const srcUrl = typeof item.srcUrl === "string" ? item.srcUrl.trim() : "";
            const platform = typeof item.platform === "string" ? item.platform : "";

            // 先按 srcUrl 认，再退回按平台名认（迁移自旧备份时 srcUrl 可能缺失）
            let current = srcUrl
                ? this.plugins.find((p) => (p.instance?.srcUrl ?? "") === srcUrl)
                : undefined;
            if (!current && platform) {
                current = this.plugins.find((p) => p.name === platform);
            }

            const needsInstall =
                !current ||
                !this.isVersionNotOlder(this.versionOf(current), item.version ?? "0.0.0");

            let target = current;
            if (needsInstall) {
                let code: string | undefined;
                if (srcUrl) {
                    try {
                        const res = await axios.get(srcUrl, { timeout: 30000 });
                        code = res.data?.toString();
                    } catch (e: any) {
                        result.failed.push({
                            platform: platform || srcUrl,
                            reason: `下载失败：${e?.message ?? String(e)}`,
                        });
                        continue;
                    }
                } else if (typeof item.code === "string" && item.code.length) {
                    code = item.code;
                }
                if (!code) {
                    result.failed.push({
                        platform: platform || "未知插件",
                        reason: "备份中没有源码，且该插件不是从网络安装的，无法恢复",
                    });
                    continue;
                }
                const installRes = this.installPluginCode(code, {
                    replaceHash: current?.hash,
                });
                if (!installRes.success || !installRes.pluginHash) {
                    result.failed.push({
                        platform: platform || "未知插件",
                        reason: installRes.message ?? "安装失败",
                    });
                    continue;
                }
                target = this.getByHash(installRes.pluginHash);
                if (current) {
                    result.updated += 1;
                } else {
                    result.installed += 1;
                }
            } else {
                result.skipped += 1;
            }

            if (!target) {
                continue;
            }
            const userVariables =
                item.userVariables && typeof item.userVariables === "object"
                    ? item.userVariables
                    : {};
            this.saveMeta(target.hash, {
                enabled: item.enabled ?? true,
                order:
                    typeof item.order === "number"
                        ? item.order
                        : this.meta[target.hash]?.order ?? 999,
                userVariables,
            });
            target.setUserVariables(userVariables);
        }
        this.resort();
        this.configStore.set("plugin.meta", this.meta);
        return result;
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
