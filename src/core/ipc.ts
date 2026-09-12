/** 渲染进程与主进程的 IPC 桥 */

export async function ipcInvoke<T = any>(channel: string, ...args: any[]): Promise<T> {
    return window.mfp.invoke(channel, ...args);
}

/** 调用插件的某个方法（主进程执行），默认 30s 超时 */
export async function pluginCall<T = any>(
    hash: string,
    method: string,
    ...args: any[]
): Promise<T> {
    const invocation = window.mfp.invoke("plugin:call", { hash, method, args });
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`插件调用超时: ${method}`)), 30000),
    );
    const res = (await Promise.race([invocation, timeout])) as any;
    if (!res?.success) {
        throw new Error(res?.message ?? "插件调用失败");
    }
    return res?.data as T;
}

/** ---------- 插件列表 ---------- */

export interface SerializedPlugin {
    name: string;
    hash: string;
    platform: string;
    version: string;
    srcUrl: string;
    author: string;
    description: string;
    state: string;
    errorReason?: string;
    enabled: boolean;
    order: number;
    userVariables: Record<string, string>;
    supportedMethods: string[];
}

let cachedPlugins: SerializedPlugin[] = [];

export async function getPlugins(refresh = false): Promise<SerializedPlugin[]> {
    if (refresh || !cachedPlugins.length) {
        cachedPlugins = (await ipcInvoke("plugin:list")) ?? [];
        // 用户设置的默认音源置顶（影响搜索默认选择与发现页/排行榜的尝试顺序）
        const defaultHash = localStorage.getItem("defaultPluginHash");
        if (defaultHash) {
            cachedPlugins = [
                ...cachedPlugins.filter((p) => p.hash === defaultHash),
                ...cachedPlugins.filter((p) => p.hash !== defaultHash),
            ];
        }
    }
    return cachedPlugins;
}

export function invalidatePluginCache() {
    cachedPlugins = [];
}

export async function getPluginByMedia(
    mediaItem?: { platform: string } | null,
): Promise<SerializedPlugin | undefined> {
    if (!mediaItem?.platform) {
        return undefined;
    }
    const plugins = await getPlugins();
    return plugins.find(
        (p) =>
            p.enabled &&
            p.state === "Mounted" &&
            p.platform === mediaItem.platform,
    );
}

export async function getSortedPluginsWithAbility(
    ability: string,
): Promise<SerializedPlugin[]> {
    const plugins = await getPlugins();
    return plugins.filter(
        (p) => p.enabled && p.state === "Mounted" && p.supportedMethods.includes(ability),
    );
}

export async function getSortedSearchablePlugins(): Promise<SerializedPlugin[]> {
    return getSortedPluginsWithAbility("search");
}

/** ---------- base64url 工具（渲染进程侧构造 mfs:// 链接） ---------- */

export function b64urlEncode(input: string): string {
    const bytes = new TextEncoder().encode(input);
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildRemoteMediaUrl(payload: {
    url: string;
    headers?: Record<string, string>;
    userAgent?: string;
}): string {
    return `mfs://media/${b64urlEncode(JSON.stringify(payload))}`;
}

export function buildLocalMediaUrl(localPath: string): string {
    return `mfs://local/${b64urlEncode(localPath)}`;
}
