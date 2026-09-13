import { SerializedPlugin, pluginCall } from "./ipc";

/**
 * 插件方法尝试工具：
 *  - 插件列表已按「默认音源优先」排序（见 ipc.getPlugins）
 *  - 依次尝试，任一成功即返回（附带来源插件名），整体限时
 *  - 发现页 / 排行榜页选定音源后只会传入单个插件，此时不会回落到其他音源
 */

export async function tryPluginMethod<T = any>(
    plugins: SerializedPlugin[],
    method: string,
    timeoutMs = 12000,
    ...args: any[]
): Promise<{ data: T; pluginName: string } | null> {
    for (const plugin of plugins) {
        try {
            const data = await Promise.race([
                pluginCall(plugin.hash, method, ...args),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("插件响应超时")), timeoutMs),
                ),
            ]);
            return { data: data as T, pluginName: plugin.name };
        } catch (e) {
            console.warn(
                `[plugin] ${method} via ${plugin.name} failed:`,
                (e as any)?.message,
            );
            continue;
        }
    }
    return null;
}
