import { SerializedPlugin, getPlugins } from "./ipc";

/**
 * 页面级音源（插件）选择：
 *  - 发现音乐 / 排行榜这类聚合页默认按「默认音源优先」逐个降级尝试（自动模式）；
 *  - 用户也可以显式指定只用某个音源，选择结果按页面分别持久化到 localStorage。
 */

/** 「自动」：不指定音源，按默认音源优先顺序逐个降级尝试 */
export const AUTO_SOURCE = "auto";

/** 页面需要的「能力」；一个能力可能对应多个插件方法（任一支持即算支持） */
export interface ISourceCapability {
    /** 中文名，用于下拉标题与「不支持 XX」提示 */
    label: string;
    /** 对应的插件方法名 */
    methods: string[];
}

const storageKey = (page: string) => `pageSource.${page}`;

export function getPageSource(page: string): string {
    return localStorage.getItem(storageKey(page)) || AUTO_SOURCE;
}

export function setPageSource(page: string, hash: string) {
    if (!hash || hash === AUTO_SOURCE) {
        localStorage.removeItem(storageKey(page));
        return;
    }
    localStorage.setItem(storageKey(page), hash);
}

/** 全部已启用且挂载成功的插件（getPlugins 内部已把默认音源排到最前） */
export async function getEnabledPlugins(): Promise<SerializedPlugin[]> {
    return getPlugins();
}

export function hasCapability(plugin: SerializedPlugin, capability: ISourceCapability) {
    return capability.methods.some((m) => plugin.supportedMethods.includes(m));
}

/**
 * 按插件方法筛选：指定音源时只返回该插件，返回空数组即「当前音源不可用」。
 * 「自动」时返回全部支持该方法的插件。
 */
export function pickSourcePlugins(
    plugins: SerializedPlugin[],
    method: string,
    sourceHash: string,
): SerializedPlugin[] {
    const capable = plugins.filter((p) => p.supportedMethods.includes(method));
    if (!sourceHash || sourceHash === AUTO_SOURCE) {
        return capable;
    }
    return capable.filter((p) => p.hash === sourceHash);
}

/** 同 pickSourcePlugins，但按「能力」筛选（覆盖一个能力的全部方法） */
export function pickCapabilityPlugins(
    plugins: SerializedPlugin[],
    capability: ISourceCapability,
    sourceHash: string,
): SerializedPlugin[] {
    const capable = plugins.filter((p) => hasCapability(p, capability));
    if (!sourceHash || sourceHash === AUTO_SOURCE) {
        return capable;
    }
    return capable.filter((p) => p.hash === sourceHash);
}

export type TSourceStatus = "auto" | "ok" | "missing" | "unsupported";

/**
 * 当前音源相对某能力的可用性：
 *  auto 未指定 / ok 支持 / missing 插件已卸载或禁用 / unsupported 插件不支持该能力。
 * 页面据此给出「切回自动」「换一个音源」这类精确提示，而不是笼统的「加载失败」。
 */
export function getSourceStatus(
    plugins: SerializedPlugin[],
    capability: ISourceCapability,
    sourceHash: string,
): TSourceStatus {
    if (!sourceHash || sourceHash === AUTO_SOURCE) {
        return "auto";
    }
    const plugin = plugins.find((p) => p.hash === sourceHash);
    if (!plugin) {
        return "missing";
    }
    return hasCapability(plugin, capability) ? "ok" : "unsupported";
}

/** 已选音源对应的插件（用于展示名称；自动模式或插件不存在时返回 undefined） */
export function findSourcePlugin(
    plugins: SerializedPlugin[],
    sourceHash: string,
): SerializedPlugin | undefined {
    if (!sourceHash || sourceHash === AUTO_SOURCE) {
        return undefined;
    }
    return plugins.find((p) => p.hash === sourceHash);
}
