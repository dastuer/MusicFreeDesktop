import axios from "axios";
import CryptoJs from "crypto-js";
import pluginHost from "./pluginHost";
import type configStoreInstance from "./configStore";

/**
 * 聚合音源订阅源：一条链接指向一份 index.json，里面列着这个源提供的全部插件。
 * 这里记住链接本身，导入与「检查更新」都按 index 里的版本逐个走 pluginHost。
 */

const sha256 = (s: string) => CryptoJs.SHA256(s).toString();

/** 单个订阅源记录。name 以用户所设为准，远端 index 改名不会覆盖它 */
export interface IPluginSubscription {
    id: string;
    name: string;
    url: string;
    addedAt: number;
    lastCheckAt: number;
    pluginCount: number;
}

/** 一次导入（新增或检查更新）的逐条结果 */
export interface ISubscriptionImportResult {
    success: boolean;
    /** 导入失败的原因；成功时留空，成功与否看 success */
    message?: string;
    /** 需要额外交代一句的情况（如链接已订阅，本次转为检查更新） */
    note?: string;
    subscription?: IPluginSubscription;
    total: number;
    installed: number;
    updated: number;
    unchanged: number;
    failed: { name: string; reason: string }[];
}

interface IIndexEntry {
    name: string;
    url: string;
}

/** importEntries 的计数部分；与导入结果的区别只在于有没有订阅源记录 */
interface IImportCounts {
    total: number;
    installed: number;
    updated: number;
    unchanged: number;
    failed: { name: string; reason: string }[];
}

const isHttp = (url: string) => /^https?:\/\//i.test(url);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 还没开始导入就没有计数可言，失败分支统一返回这份全零值 */
const emptyCounts = (): IImportCounts => ({
    total: 0,
    installed: 0,
    updated: 0,
    unchanged: 0,
    failed: [],
});

/**
 * 解析聚合源。各家 index 写法不统一，这里认这几种形态：
 *  - 顶层是数组，或 `plugins` / `items` 字段是数组
 *  - 条目是裸 URL 字符串，或带 `url` / `srcUrl` / `file` 任一字段
 *  - 相对地址按 `baseUrl`（没有则按 index 自身所在目录）解析
 */
export function parsePluginIndex(
    raw: string,
    indexUrl: string,
): { name: string; plugins: IIndexEntry[] } {
    let data: any;
    try {
        data = JSON.parse(raw);
    } catch {
        throw new Error("订阅源内容不是合法的 JSON");
    }
    const root = data && typeof data === "object" ? data : {};
    const list: any[] = Array.isArray(data)
        ? data
        : Array.isArray(root.plugins)
          ? root.plugins
          : Array.isArray(root.items)
            ? root.items
            : [];
    if (!list.length) {
        throw new Error("这个链接里没有插件列表，不是聚合源");
    }

    // baseUrl 可能写成绝对地址，也可能只写个 "/plugins/"；没写就退回 index 自身所在目录
    const indexDir = indexUrl.replace(/[^/]*$/, "");
    const rawBase = typeof root.baseUrl === "string" ? root.baseUrl : "";
    let base = indexDir;
    if (rawBase) {
        try {
            base = new URL(rawBase, indexDir).toString();
        } catch {
            base = indexDir;
        }
    }
    const toAbsolute = (candidate: string) => {
        try {
            return new URL(candidate, base).toString();
        } catch {
            return "";
        }
    };

    const plugins: IIndexEntry[] = [];
    for (const item of list) {
        const rawUrl =
            typeof item === "string"
                ? item
                : [item?.url, item?.srcUrl, item?.file].find(
                      (v) => typeof v === "string" && v.length,
                  ) ?? "";
        const url = isHttp(rawUrl) ? rawUrl : toAbsolute(rawUrl);
        if (!isHttp(url)) {
            // 只放行 http(s)：订阅源里写 file:// 或本地路径不能跟着读
            continue;
        }
        const name =
            (typeof item === "object" && (item?.name || item?.platform)) ||
            decodeURIComponent(url.split("/").pop() ?? "").split("?")[0] ||
            url;
        plugins.push({ name: String(name), url });
    }
    if (!plugins.length) {
        throw new Error("订阅源里没有可用的插件地址");
    }
    return {
        name: typeof root.name === "string" ? root.name : "",
        plugins,
    };
}

class PluginSubscription {
    private configStore!: typeof configStoreInstance;
    private subscriptions: IPluginSubscription[] = [];

    setup(configStore: typeof configStoreInstance) {
        this.configStore = configStore;
        const stored = configStore.get("plugin.subscriptions", []);
        this.subscriptions = (Array.isArray(stored) ? stored : [])
            .filter(
                (it: any) =>
                    it && typeof it.url === "string" && typeof it.name === "string",
            )
            .map((it: any) => ({
                id: String(it.id ?? sha256(it.url).slice(0, 16)),
                name: it.name,
                url: it.url,
                addedAt: Number(it.addedAt) || 0,
                lastCheckAt: Number(it.lastCheckAt) || 0,
                pluginCount: Number(it.pluginCount) || 0,
            }));
    }

    private save() {
        this.configStore.set("plugin.subscriptions", this.subscriptions);
    }

    private find(id: string) {
        return this.subscriptions.find((s) => s.id === id);
    }

    list(): IPluginSubscription[] {
        return this.subscriptions.map((s) => ({ ...s }));
    }

    private async fetchIndex(url: string) {
        // responseType=text：不让 axios 按 content-type 先解析一遍，交给 parsePluginIndex 统一处理
        const res = await axios.get(url, { timeout: 30000, responseType: "text" });
        return parsePluginIndex(String(res.data ?? ""), url);
    }

    /**
     * 下载一份插件源码。
     * 一次导入要连着拉十几个文件，聚合源偶发的连接重置很常见（实测 onemusic 源
     * 六次里就中过一次），所以失败退避后重试一次；真装不上也只算这一个音源失败。
     */
    private async download(
        url: string,
        attempts = 2,
    ): Promise<string | { error: string }> {
        let error = "下载失败";
        for (let i = 0; i < attempts; i++) {
            try {
                const res = await axios.get(url, { timeout: 30000, responseType: "text" });
                const code = String(res.data ?? "");
                if (code.length) {
                    return code;
                }
                error = "返回为空";
            } catch (e: any) {
                error = `下载失败：${e?.message ?? String(e)}`;
            }
            if (i + 1 < attempts) {
                await sleep(500);
            }
        }
        return { error };
    }

    /**
     * 逐个下载并安装。串行：一次导入通常只有几个到十几个小文件，
     * 且 pluginHost 的登记会改内存里的插件数组，串行不必考虑交错覆盖。
     */
    private async importEntries(entries: IIndexEntry[]): Promise<IImportCounts> {
        const counts: IImportCounts = {
            total: entries.length,
            installed: 0,
            updated: 0,
            unchanged: 0,
            failed: [],
        };
        for (const entry of entries) {
            const code = await this.download(entry.url);
            if (typeof code !== "string") {
                counts.failed.push({ name: entry.name, reason: code.error });
                continue;
            }
            const one = pluginHost.installOrUpdate(code);
            if (one.status === "failed") {
                counts.failed.push({
                    name: one.name || entry.name,
                    reason: one.reason ?? "安装失败",
                });
            } else {
                counts[one.status] += 1;
            }
        }
        return counts;
    }

    /**
     * 一个音源都没装上就不算成功——否则界面会报「已导入 0 个音源」，
     * 用户以为一切正常，实际列表还是空的。
     */
    private summarize(counts: IImportCounts) {
        const ok = counts.installed + counts.updated + counts.unchanged;
        const first = counts.failed[0];
        return {
            success: ok > 0,
            message: ok
                ? ""
                : first
                  ? `${first.name}：${first.reason}`
                  : "没有可导入的音源",
        };
    }

    /**
     * 添加订阅源并立即全量导入。
     * 同一链接重复添加时不建第二条，直接转为检查更新。
     */
    async add(rawUrl: string, displayName?: string): Promise<ISubscriptionImportResult> {
        const url = String(rawUrl ?? "").trim();
        if (!isHttp(url)) {
            return {
                success: false,
                message: "请输入 http(s) 订阅源链接",
                ...emptyCounts(),
            };
        }
        const existing = this.subscriptions.find((s) => s.url === url);
        if (existing) {
            const result = await this.update(existing.id);
            return {
                ...result,
                note: "该订阅源已存在，已改为检查更新",
            };
        }

        let parsed: { name: string; plugins: IIndexEntry[] };
        try {
            parsed = await this.fetchIndex(url);
        } catch (e: any) {
            return {
                success: false,
                message: e?.message ?? String(e),
                ...emptyCounts(),
            };
        }

        const counts = await this.importEntries(parsed.plugins);
        let host = "";
        try {
            host = new URL(url).hostname;
        } catch {
            host = url;
        }
        const subscription: IPluginSubscription = {
            id: sha256(url).slice(0, 16),
            name: displayName?.trim() || parsed.name || host,
            url,
            addedAt: Date.now(),
            lastCheckAt: Date.now(),
            pluginCount: parsed.plugins.length,
        };
        this.subscriptions.push(subscription);
        this.save();
        return {
            ...counts,
            ...this.summarize(counts),
            subscription,
        };
    }

    /** 重新拉取 index 并按版本导入；用户已改过名的不会被远端名字覆盖 */
    async update(id: string): Promise<ISubscriptionImportResult> {
        const subscription = this.find(id);
        if (!subscription) {
            return {
                success: false,
                message: "订阅源不存在",
                ...emptyCounts(),
            };
        }
        let parsed: { name: string; plugins: IIndexEntry[] };
        try {
            parsed = await this.fetchIndex(subscription.url);
        } catch (e: any) {
            return {
                success: false,
                message: `拉取订阅源失败：${e?.message ?? String(e)}`,
                ...emptyCounts(),
            };
        }
        const counts = await this.importEntries(parsed.plugins);
        subscription.lastCheckAt = Date.now();
        subscription.pluginCount = parsed.plugins.length;
        this.save();
        return {
            ...counts,
            ...this.summarize(counts),
            subscription: { ...subscription },
        };
    }

    rename(id: string, name: string) {
        const subscription = this.find(id);
        if (!subscription) {
            return false;
        }
        subscription.name = name;
        this.save();
        return true;
    }

    /** 只删订阅记录，已装入的音源保留（删音源请到上方插件列表逐个卸载） */
    remove(id: string) {
        const idx = this.subscriptions.findIndex((s) => s.id === id);
        if (idx < 0) {
            return false;
        }
        this.subscriptions.splice(idx, 1);
        this.save();
        return true;
    }
}

export default new PluginSubscription();
