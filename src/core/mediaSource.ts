import { SerializedPlugin, getPlugins } from "./ipc";

/**
 * 浏览类页面（发现音乐 / 排行榜）的音源（插件）选择：
 *  - 默认按「默认音源优先」逐个降级尝试（自动模式）；
 *  - 用户也可以显式指定只用某个音源，即使失败也不回落到其他音源；
 *  - 这些页面共用同一份偏好（同一个 localStorage 键）：页面切换即整体重挂载
 *    （见 App.tsx 的 key），重挂载时重新读取，一处修改处处生效。
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

/** 两页共用的音源偏好键 */
const STORAGE_KEY = "browseSourceHash";
/** 旧版按页面分开存的键：首次读取时合并成一份（发现音乐优先），迁完即删 */
const LEGACY_KEYS = ["pageSource.home", "pageSource.topList"];

let migrated = false;

function migrateLegacyKeys() {
    if (migrated) {
        return;
    }
    migrated = true;
    for (const key of LEGACY_KEYS) {
        const legacy = localStorage.getItem(key);
        if (!legacy) {
            continue;
        }
        // 新键已有值（此前迁移过或恢复过备份）时只清旧键，不能用旧值覆盖新偏好
        if (!localStorage.getItem(STORAGE_KEY)) {
            localStorage.setItem(STORAGE_KEY, legacy);
        }
        localStorage.removeItem(key);
    }
}

export function getBrowseSource(): string {
    migrateLegacyKeys();
    return localStorage.getItem(STORAGE_KEY) || AUTO_SOURCE;
}

export function setBrowseSource(hash: string) {
    if (!hash || hash === AUTO_SOURCE) {
        localStorage.removeItem(STORAGE_KEY);
        return;
    }
    localStorage.setItem(STORAGE_KEY, hash);
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
