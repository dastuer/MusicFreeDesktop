/**
 * 页面滚动位置记忆（模块作用域，跨挂载存活）
 *
 * 主内容区按 key 整体重挂载（见 App.tsx），页面切走再回来时 scrollTop 归零。
 * 这里按路由条目 id 记住每个页面实例滚到哪儿了：从详情页返回列表页时原位恢复，
 * 新进的页面（push/replace）仍从顶部开始。
 *
 * 位置由 App.tsx 在 page-container 滚动时持续写入；条目从路由栈里被截断丢弃时，
 * 对应的记录也一并清掉（onRouteDiscarded 注册），避免长时间使用后 map 无限增长。
 */

import { onRouteDiscarded } from "./router";

const positions = new Map<number, number>();

export function rememberScroll(routeId: number, scrollTop: number) {
    positions.set(routeId, scrollTop);
}

/** 没有记录（首次进入该页面实例）时返回 0 */
export function recallScroll(routeId: number): number {
    return positions.get(routeId) ?? 0;
}

export function forgetScroll(routeId: number) {
    positions.delete(routeId);
}

onRouteDiscarded(forgetScroll);
