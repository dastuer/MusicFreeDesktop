import { atom, getDefaultStore, useAtomValue } from "jotai";

/**
 * 简单栈式路由：与移动端 ROUTE_PATH 概念一致
 * 侧边栏常驻，路由只在主内容区切换
 */

export type RoutePath =
    | "home"
    | "search"
    | "sheetDetail"
    | "albumDetail"
    | "artistDetail"
    | "topList"
    | "topListDetail"
    | "localMusic"
    | "history"
    | "downloading"
    | "pluginManage"
    | "settings";

export interface IRoute {
    path: RoutePath;
    params: Record<string, any>;
}

const routeStackAtom = atom<IRoute[]>([{ path: "home", params: {} }]);
const routeIndexAtom = atom<number>(0);

const currentRouteAtom = atom<IRoute>((get) => {
    const stack = get(routeStackAtom);
    const index = get(routeIndexAtom);
    return stack[Math.min(index, stack.length - 1)] ?? { path: "home", params: {} };
});

const store = getDefaultStore();

/** 导航到新页面（压栈，截断前进历史） */
export function navigate(path: RoutePath, params: Record<string, any> = {}) {
    const stack = store.get(routeStackAtom);
    const index = store.get(routeIndexAtom);
    const newStack = stack.slice(0, index + 1);
    newStack.push({ path, params });
    store.set(routeStackAtom, newStack);
    store.set(routeIndexAtom, newStack.length - 1);
}

/** 替换当前页面 */
export function replaceCurrent(path: RoutePath, params: Record<string, any> = {}) {
    const stack = store.get(routeStackAtom);
    const index = store.get(routeIndexAtom);
    const newStack = [...stack];
    newStack[index] = { path, params };
    store.set(routeStackAtom, newStack);
}

export function goBack(): boolean {
    const index = store.get(routeIndexAtom);
    if (index > 0) {
        store.set(routeIndexAtom, index - 1);
        return true;
    }
    return false;
}

export function goForward(): boolean {
    const index = store.get(routeIndexAtom);
    const stack = store.get(routeStackAtom);
    if (index < stack.length - 1) {
        store.set(routeIndexAtom, index + 1);
        return true;
    }
    return false;
}

export function useCurrentRoute(): IRoute {
    return useAtomValue(currentRouteAtom);
}

export function useCanGoBack(): boolean {
    return useAtomValue(canGoBackAtomInner);
}

export function useCanGoForward(): boolean {
    return useAtomValue(canGoForwardAtomInner);
}

const canGoBackAtomInner = atom<boolean>((get) => get(routeIndexAtom) > 0);
const canGoForwardAtomInner = atom<boolean>((get) => {
    const stack = get(routeStackAtom);
    const index = get(routeIndexAtom);
    return index < stack.length - 1;
});
