import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 无限滚动列表的数据源层：把音源「第 M 页」的拉取包装成「已加载条目 + 续拉」。
 *
 * 音源的 `page` 是**页码**而不是条数（每次返回多少条由插件内部决定）。
 * 组件滚到底部触发 `loadMore`，这里就向音源请求下一页并追加：
 *  - 追加时按 `platform-id` 去重（音源相邻页常重复返回同一首歌）；
 *  - 所有请求串行化，哨兵连续触发不会重复请求同一个音源页；
 *  - 单次请求失败**不会**把列表锁死成「已到底」，哨兵重新进视口即可重试；
 *    连续多轮零收获才按 stalled 熔断（防止「滚到底 -> 失败 -> 再触发」的风暴）。
 */

export interface IPagedFetchResult<T> {
    items: T[];
    isEnd: boolean;
}

/**
 * 供「返回页面还原现场」用的最小快照：把内部进度（音源拉到第几页等）一起存下来，
 * 挂载时从 `initial` 传入即可跳过首次拉取、原样呈现，续拉也能无缝继续。
 */
export interface IPagedSnapshot<T> {
    items: T[];
    isEnd: boolean;
    stalled: boolean;
    /** 音源已拉到的页码：还原后从这里继续；若归零重拉，重复数据会被误判成「原地踏步」 */
    sourcePage: number;
}

export interface IUsePagedMusicListOptions<T> {
    /** 拉取音源第 page 页（从 1 开始）；失败请直接 throw，调用方会保留上一页状态 */
    fetchPage: (page: number) => Promise<IPagedFetchResult<T>>;
    /** 变化即清空并重新从第 1 页拉（切换音源 / 歌单 / 搜索条件） */
    resetKey: string;
    /**
     * 挂载时的恢复快照（页面返回还原用）。只在挂载那一刻读一次：
     * 传入后跳过挂载时的首次重置拉取，直接以快照内容呈现。
     */
    initial?: IPagedSnapshot<T>;
}

export interface IUsePagedMusicListResult<T> {
    /** 已加载的全部条目 */
    items: T[];
    /** 音源已到底 */
    isEnd: boolean;
    /**
     * 不是因为音源报 isEnd，而是**深页重复返回同一批数据**（或连续失败熔断）才停下的。
     * 续拉到此为止，但不是「确实是最后一页」，所以界面不能写「共 N 首」，要给重试入口。
     */
    stalled: boolean;
    /** 还可能拉到新数据（`!isEnd && !stalled`），决定「共 N 首 / 已加载 N 首」文案 */
    hasMore: boolean;
    /** 音源已拉到的页码（还原现场用） */
    sourcePage: number;
    /** 首次加载 / 重置后的加载 */
    loading: boolean;
    /** 正在续拉下一批 */
    loadingMore: boolean;
    /** 无限滚动：滚到底部哨兵触发，向音源续拉一页 */
    loadMore: () => void;
    /**
     * 手动重试被「卡住」的续拉（插件原地踏步 / 连续失败触发的 stalled）：
     * 撤销熔断再补一轮。音源真正到底（isEnd）时什么都不做。
     */
    retry: () => void;
    /** 就地替换全部数据（本地歌单这种一次性拿全的场景） */
    replaceAll: (items: T[]) => void;
    reload: () => void;
}

function musicKey(item: any) {
    return `${item?.platform ?? ""}-${item?.id ?? ""}`;
}

export function usePagedMusicList<T extends { id?: string; platform?: string }>(
    options: IUsePagedMusicListOptions<T>,
): IUsePagedMusicListResult<T> {
    const { resetKey } = options;

    /** 每次渲染都刷新，避免把内联的 fetchPage 放进依赖导致反复重置 */
    const fetchPageRef = useRef(options.fetchPage);
    fetchPageRef.current = options.fetchPage;

    // 恢复快照只在挂载那一刻生效，之后调用方传什么都不该打扰正在进行的分页
    const initialRef = useRef(options.initial);
    const initial = initialRef.current;

    const [nonce, setNonce] = useState(0);
    const [items, setItems] = useState<T[]>(() => initial?.items ?? []);
    const [isEnd, setIsEnd] = useState(() => !!initial?.isEnd);
    const [stalled, setStalled] = useState(() => !!initial?.stalled);
    const [loading, setLoading] = useState(() => !initial);
    const [loadingMore, setLoadingMore] = useState(false);

    /** 世代号：resetKey 变化后，旧请求回来时一律丢弃，避免脏数据回填 */
    const generationRef = useRef(0);
    const itemsRef = useRef<T[]>(initial?.items ?? []);
    const sourcePageRef = useRef(initial?.sourcePage ?? 0);
    const isEndRef = useRef(!!initial?.isEnd);
    const stalledRef = useRef(!!initial?.stalled);
    /**
     * 连续「整轮拉取失败」计数。哨兵失败后列表变矮会立刻重新触发，不封顶就变成
     * 「滚到底 -> 失败 -> 再触发」的请求风暴。连续 3 轮失败后按 stalled 停住
     * （换关键词/重进页面/点重试可重来）。
     */
    const consecutiveFailRef = useRef(0);
    const loadingRef = useRef(loading);
    loadingRef.current = loading;
    const loadingMoreRef = useRef(loadingMore);
    loadingMoreRef.current = loadingMore;

    /** 串行化音源请求 */
    const queueRef = useRef<Promise<unknown>>(Promise.resolve());
    const enqueue = useCallback((task: () => Promise<unknown>) => {
        const run = queueRef.current.then(task, task);
        queueRef.current = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }, []);

    /** 向音源拉下一页并追加（去重）；返回是否拉到新条目、音源是否报到底 */
    const fetchNextSourcePage = useCallback(
        async (generation: number) => {
            const next = sourcePageRef.current + 1;
            const result = await fetchPageRef.current(next);
            if (generation !== generationRef.current) {
                return { added: 0, end: true };
            }
            const seen = new Set(itemsRef.current.map(musicKey));
            const fresh = (result?.items ?? []).filter((item) => {
                const key = musicKey(item);
                if (seen.has(key)) {
                    return false;
                }
                seen.add(key);
                return true;
            });
            sourcePageRef.current = next;
            isEndRef.current = !!result?.isEnd;
            // 有新增就说明插件还在往前走，之前的「原地踏步」判断作废
            if (fresh.length) {
                stalledRef.current = false;
                setStalled(false);
            }
            itemsRef.current = [...itemsRef.current, ...fresh];
            setItems(itemsRef.current);
            setIsEnd(isEndRef.current);
            return { added: fresh.length, end: isEndRef.current };
        },
        [],
    );

    const fetchMore = useCallback(
        async (generation: number) => {
            if (isEndRef.current || stalledRef.current) {
                return;
            }
            setLoadingMore(true);
            const lengthBefore = itemsRef.current.length;
            let errored = false;
            try {
                const { added, end } = await fetchNextSourcePage(generation);
                if (generation !== generationRef.current) {
                    return;
                }
                if (added === 0 && !end) {
                    // 插件把同一页又发了一遍（深页常见）。再拉也是死循环，就此打住；
                    // 但这不是「音源说没有了」，只是拉不到新的了，单独标记出来。
                    console.warn("[pagedList] 音源没有返回新条目，停止继续拉取");
                    stalledRef.current = true;
                    setStalled(true);
                }
            } catch (e: any) {
                // 故意不写 isEnd：一次网络抖动不该让列表永久停在「已到底」
                errored = true;
                console.warn("[pagedList] 加载失败：", e?.message ?? e);
            } finally {
                if (generation === generationRef.current) {
                    if (errored && itemsRef.current.length === lengthBefore) {
                        // 整轮零收获还带着错误：哨兵会在列表变矮后重新触发，
                        // 连续几次就按 stalled 停住，免得变成滚到底 -> 失败 -> 重试的风暴。
                        if (++consecutiveFailRef.current >= 3) {
                            console.warn("[pagedList] 连续加载失败，暂停自动续拉");
                            stalledRef.current = true;
                            setStalled(true);
                        }
                    } else {
                        consecutiveFailRef.current = 0;
                    }
                    setLoadingMore(false);
                    setLoading(false);
                }
            }
        },
        [fetchNextSourcePage],
    );

    /** 无限滚动：滚到底部哨兵触发，续拉一页（串行化，进行中/已到底时是空操作） */
    const loadMore = useCallback(() => {
        const generation = generationRef.current;
        enqueue(() => fetchMore(generation));
    }, [enqueue, fetchMore]);

    const retry = useCallback(() => {
        if (isEndRef.current || loadingRef.current || loadingMoreRef.current) {
            return;
        }
        stalledRef.current = false;
        setStalled(false);
        consecutiveFailRef.current = 0;
        loadMore();
    }, [loadMore]);

    /**
     * resetKey / nonce 变化：清空重来。
     * 挂载本身也会触发一次：带了恢复快照（数据已在快照里）就整段跳过，
     * 否则照常从第 1 页拉。用「上次执行时的 resetKey#nonce」去重，
     * 依赖没实际变化的重复触发不会重复清拉。
     */
    const lastResetSigRef = useRef<string | null>(initial ? `${resetKey}#0` : null);
    useEffect(() => {
        const sig = `${resetKey}#${nonce}`;
        if (lastResetSigRef.current === sig) {
            return;
        }
        lastResetSigRef.current = sig;
        const generation = ++generationRef.current;
        itemsRef.current = [];
        sourcePageRef.current = 0;
        isEndRef.current = false;
        stalledRef.current = false;
        consecutiveFailRef.current = 0;
        setItems([]);
        setIsEnd(false);
        setStalled(false);
        setLoading(true);
        enqueue(() => fetchMore(generation));
    }, [resetKey, nonce, enqueue, fetchMore]);

    const replaceAll = useCallback((next: T[]) => {
        itemsRef.current = next;
        sourcePageRef.current = 0;
        isEndRef.current = true;
        stalledRef.current = false;
        setItems(next);
        setIsEnd(true);
        setStalled(false);
        setLoading(false);
    }, []);

    const reload = useCallback(() => setNonce((n) => n + 1), []);

    const hasMore = !isEnd && !stalled;

    return useMemo(
        () => ({
            items,
            isEnd,
            stalled,
            hasMore,
            sourcePage: sourcePageRef.current,
            loading,
            loadingMore,
            loadMore,
            retry,
            replaceAll,
            reload,
        }),
        [
            items,
            isEnd,
            stalled,
            hasMore,
            loading,
            loadingMore,
            loadMore,
            retry,
            replaceAll,
            reload,
        ],
    );
}
