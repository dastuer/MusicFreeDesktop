import { atom, getDefaultStore, useAtomValue } from "jotai";

/**
 * 简单栈式路由：与移动端 ROUTE_PATH 概念一致
 * 侧边栏常驻，路由只在主内容区切换
 */

export type RoutePath =
    | "home"
    | "neteaseDaily"
    | "neteasePlaylistDetail"
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
    /** 条目唯一 id：滚动位置记忆等「按页面实例」存的数据都以它为键 */
    id: number;
    path: RoutePath;
    params: Record<string, any>;
}

export type NavKind = "push" | "back" | "forward" | "replace" | "init";

let routeSeq = 0;
const makeRoute = (path: RoutePath, params: Record<string, any>): IRoute => ({
    id: ++routeSeq,
    path,
    params,
});

const routeStackAtom = atom<IRoute[]>([makeRoute("home", {})]);
const routeIndexAtom = atom<number>(0);

const HOME_FALLBACK: IRoute = { id: 0, path: "home", params: {} };

const currentRouteAtom = atom<IRoute>((get) => {
    const stack = get(routeStackAtom);
    const index = get(routeIndexAtom);
    // 栈恒非空（初始就有一条），兜底只为类型完备；id=0 不参与滚动记忆
    return stack[Math.min(index, stack.length - 1)] ?? HOME_FALLBACK;
});

const store = getDefaultStore();

/**
 * 最近一次路由变化的类型。App.tsx 据此决定滚动位置：back/forward 恢复原位，
 * push/replace 从顶部开始（见 core/scrollMemory.ts）。
 */
let lastNavKind: NavKind = "init";

export function getLastNavKind(): NavKind {
    return lastNavKind;
}

/**
 * 路由条目被丢弃（栈截断 / 被替换）时执行的清理回调。
 * 「按页面实例存」的附属数据（滚动位置、搜索页快照等）在这里注册销毁逻辑，
 * 跟着条目一起清掉，避免长时间使用后无限增长；router 本身不关心具体存了什么。
 */
const discardHooks: ((routeId: number) => void)[] = [];

export function onRouteDiscarded(hook: (routeId: number) => void): () => void {
    discardHooks.push(hook);
    return () => {
        const index = discardHooks.indexOf(hook);
        if (index >= 0) {
            discardHooks.splice(index, 1);
        }
    };
}

function discardRoute(routeId: number) {
    discardHooks.forEach((hook) => hook(routeId));
}

/** 路由栈被截断时，把丢弃条目的附属数据（滚动位置、页面快照）一起清掉 */
function pruneRemovedRoutes(kept: IRoute[]) {
    const keptIds = new Set(kept.map((r) => r.id));
    for (const route of store.get(routeStackAtom)) {
        if (!keptIds.has(route.id)) {
            discardRoute(route.id);
        }
    }
}

/** 导航到新页面（压栈，截断前进历史） */
export function navigate(path: RoutePath, params: Record<string, any> = {}) {
    const stack = store.get(routeStackAtom);
    const index = store.get(routeIndexAtom);
    const newStack = stack.slice(0, index + 1);
    pruneRemovedRoutes(newStack);
    newStack.push(makeRoute(path, params));
    store.set(routeStackAtom, newStack);
    store.set(routeIndexAtom, newStack.length - 1);
    lastNavKind = "push";
}

/** 替换当前页面 */
export function replaceCurrent(path: RoutePath, params: Record<string, any> = {}) {
    const stack = store.get(routeStackAtom);
    const index = store.get(routeIndexAtom);
    const newStack = [...stack];
    discardRoute(newStack[index].id);
    newStack[index] = makeRoute(path, params);
    store.set(routeStackAtom, newStack);
    lastNavKind = "replace";
}

export function goBack(): boolean {
    const index = store.get(routeIndexAtom);
    if (index > 0) {
        store.set(routeIndexAtom, index - 1);
        lastNavKind = "back";
        return true;
    }
    return false;
}

export function goForward(): boolean {
    const index = store.get(routeIndexAtom);
    const stack = store.get(routeStackAtom);
    if (index < stack.length - 1) {
        store.set(routeIndexAtom, index + 1);
        lastNavKind = "forward";
        return true;
    }
    return false;
}

export function useCurrentRoute(): IRoute {
    return useAtomValue(currentRouteAtom);
}

/**
 * 从当前页沿路由栈往回找最近一个命中 match 的路由。
 * 详情页（歌单/专辑/歌手）在侧边栏没有自己的条目，激活态认「来源分区」时用：
 * 栈里最近的分区页就是它从哪个主导航页进来的。
 */
export function useNearestRoute(match: (path: RoutePath) => boolean): IRoute | undefined {
    const stack = useAtomValue(routeStackAtom);
    const index = useAtomValue(routeIndexAtom);
    for (let i = Math.min(index, stack.length - 1); i >= 0; i--) {
        const route = stack[i];
        if (route && match(route.path)) {
            return route;
        }
    }
    return undefined;
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
