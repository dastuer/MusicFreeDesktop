import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 「每页 N 条」的展示分页 ↔ 音源「第 M 页」的桥接层。
 *
 * 音源的 `page` 是**页码**而不是条数（每次返回多少条由插件内部决定），所以
 * 「每页 100 条」往往要连拉好几个音源页才凑得满。这里把两件事解耦：
 *  - 对外只暴露「第几页 / 每页几条」的展示语义；
 *  - 内部维护已加载的全量列表 + 音源页码，翻到数据还没到的页时自动继续拉，
 *    直到凑满一页、或音源报 `isEnd`、或插件的这一页没有带来任何新条目。
 *
 * 另外三件事在这里统一处理，避免各页面各写一遍：
 *  - 追加时按 `platform-id` 去重（音源相邻页常重复返回同一首歌）；
 *  - 所有请求串行化，快速连点「下一页」不会重复请求同一个音源页；
 *  - 单次请求失败**不会**把列表锁死成「已到底」，翻页仍然可以重试。
 */

export interface IPagedFetchResult<T> {
    items: T[];
    isEnd: boolean;
}

/**
 * 供「返回页面还原现场」用的最小快照：把内部进度（音源拉到第几页等）一起存下来，
 * 挂载时从 `initial` 传入即可跳过首次拉取、原样呈现，翻页也能无缝续拉。
 */
export interface IPagedSnapshot<T> {
    items: T[];
    currentPage: number;
    pageSize: number;
    isEnd: boolean;
    stalled: boolean;
    /** 音源已拉到的页码：还原后从这里继续；若归零重拉，重复数据会被误判成「原地踏步」 */
    sourcePage: number;
}

export interface IUsePagedMusicListOptions<T> {
    /** 拉取音源第 page 页（从 1 开始）；失败请直接 throw，调用方会保留上一页状态 */
    fetchPage: (page: number) => Promise<IPagedFetchResult<T>>;
    defaultPageSize: number;
    /** 每页条数偏好的 localStorage key（不同列表分开记忆） */
    storageKey: string;
    /** 变化即清空并重新从第 1 页拉（切换音源 / 歌单 / 搜索条件） */
    resetKey: string;
    /**
     * 挂载时的恢复快照（页面返回还原用）。只在挂载那一刻读一次：
     * 传入后跳过挂载时的首次重置拉取，直接以快照内容呈现。
     */
    initial?: IPagedSnapshot<T>;
    /**
     * 音源声明的总条数（歌单侧就是 `sheetItem.worksNum`）。
     * 插件协议的搜索返回**没有**总数字段，所以搜索页拿不到，只能显示「已加载 N 首」；
     * 歌单详情有 worksNum，用它才能一进来就显示正确的总页数。
     */
    expectedTotal?: number;
    /** 一次翻页最多连拉多少个音源页，防止插件异常时长时间阻塞 */
    maxSourceFetchPerTurn?: number;
}

export interface IUsePagedMusicListResult<T> {
    /** 已加载的全部条目（不是当前页） */
    items: T[];
    currentPage: number;
    totalPages: number;
    pageSize: number;
    pageSizeOptions: number[];
    /** 音源已到底 */
    isEnd: boolean;
    /**
     * 不是因为音源报 isEnd，而是**深页重复返回同一批数据**才停下的。
     * 分页到此为止，但不是「确实是最后一页」，所以界面不能写「共 N 首」。
     */
    stalled: boolean;
    /** 还可能拉到新数据（`!isEnd && !stalled`），决定「已加载 / 共 N 首」与下一页可用性 */
    hasMore: boolean;
    /** 音源声明的总条数；搜索等拿不到总数的场景是 undefined */
    expectedTotal?: number;
    /** 音源已拉到的页码（还原现场用） */
    sourcePage: number;
    /** 首次加载 / 重置后的加载 */
    loading: boolean;
    /** 正在为翻页补数据 */
    loadingMore: boolean;
    goToPage: (page: number) => void;
    /** 无限滚动模式：往后多拉一页的量（滚到底部哨兵触发） */
    loadMore: () => void;
    /**
     * 手动重试被「卡住」的续拉（插件原地踏步 / 连续失败触发的 stalled）：
     * 撤销熔断再补一轮。音源真正到底（isEnd）时什么都不做。
     */
    retry: () => void;
    changePageSize: (size: number) => void;
    /** 就地替换全部数据（本地歌单这种一次性拿全的场景） */
    replaceAll: (items: T[]) => void;
    reload: () => void;
}

export const PAGE_SIZE_OPTIONS = [40, 100, 200];

function musicKey(item: any) {
    return `${item?.platform ?? ""}-${item?.id ?? ""}`;
}

function readStoredPageSize(storageKey: string, fallback: number, options: number[]) {
    try {
        const n = Number(localStorage.getItem(storageKey));
        // 只认当前选项里的值：选项改过之后不留下无法选中的历史值
        if (Number.isFinite(n) && options.includes(n)) {
            return n;
        }
    } catch {
        // localStorage 不可用时静默用默认值
    }
    return fallback;
}

function writeStoredPageSize(storageKey: string, size: number) {
    try {
        localStorage.setItem(storageKey, String(size));
    } catch {
        // 忽略写入失败（隐私模式等），偏好不生效不影响功能
    }
}

export function usePagedMusicList<T extends { id?: string; platform?: string }>(
    options: IUsePagedMusicListOptions<T>,
): IUsePagedMusicListResult<T> {
    const {
        defaultPageSize,
        storageKey,
        resetKey,
        maxSourceFetchPerTurn = 10,
    } = options;
    const pageSizeOptions = PAGE_SIZE_OPTIONS;

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
    const [currentPage, setCurrentPage] = useState(() => initial?.currentPage ?? 1);
    const [pageSize, setPageSize] = useState(
        () =>
            initial?.pageSize ??
            readStoredPageSize(storageKey, defaultPageSize, PAGE_SIZE_OPTIONS),
    );
    const [loading, setLoading] = useState(() => !initial);
    const [loadingMore, setLoadingMore] = useState(false);

    /** 世代号：resetKey 变化后，旧请求回来时一律丢弃，避免脏数据回填 */
    const generationRef = useRef(0);
    const itemsRef = useRef<T[]>(initial?.items ?? []);
    const sourcePageRef = useRef(initial?.sourcePage ?? 0);
    const isEndRef = useRef(!!initial?.isEnd);
    const stalledRef = useRef(!!initial?.stalled);
    /**
     * 连续「整轮补数据失败」计数。手动翻页失败了用户还能再点；无限滚动是哨兵自动
     * 触发的，失败后列表变矮又立刻重新挂哨兵，不封顶就变成「滚到底 -> 失败 ->
     * 再触发」的请求风暴。连续 3 轮失败后按 stalled 停住（换关键词/重进页面可重来）。
     */
    const consecutiveFailRef = useRef(0);
    const currentPageRef = useRef(currentPage);
    currentPageRef.current = currentPage;
    const pageSizeRef = useRef(pageSize);
    pageSizeRef.current = pageSize;
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

    /** 保证第 target 页的数据就绪；不够就继续拉音源 */
    const ensurePage = useCallback(
        async (target: number, generation: number) => {
            const need = target * pageSizeRef.current;
            if (itemsRef.current.length >= need || isEndRef.current || stalledRef.current) {
                return;
            }
            setLoadingMore(true);
            const lengthBefore = itemsRef.current.length;
            let errored = false;
            try {
                for (let i = 0; i < maxSourceFetchPerTurn; i++) {
                    if (generation !== generationRef.current) {
                        return;
                    }
                    if (itemsRef.current.length >= need || isEndRef.current) {
                        break;
                    }
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
                        break;
                    }
                }
            } catch (e: any) {
                // 故意不写 isEnd：一次网络抖动不该让列表永久停在「已到底」
                errored = true;
                console.warn("[pagedList] 加载失败：", e?.message ?? e);
            } finally {
                if (generation === generationRef.current) {
                    if (errored && itemsRef.current.length === lengthBefore) {
                        // 整轮零收获还带着错误：无限滚动的哨兵会在列表变矮后重新触发，
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
        [fetchNextSourcePage, maxSourceFetchPerTurn],
    );

    /**
     * 无限滚动补数据：把缺口补足到「已加载条数 + 一页」。
     * 与 ensurePage(target) 的区别是不动 currentPage——分页页码在这里没有意义。
     */
    const loadMore = useCallback(() => {
        const generation = generationRef.current;
        enqueue(() =>
            ensurePage(
                Math.ceil(itemsRef.current.length / pageSizeRef.current) + 1,
                generation,
            ),
        );
    }, [enqueue, ensurePage]);

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
        setCurrentPage(1);
        setLoading(true);
        enqueue(() => ensurePage(1, generation));
    }, [resetKey, nonce, enqueue, ensurePage]);

    const goToPage = useCallback(
        (target: number) => {
            const generation = generationRef.current;
            const page = Math.max(1, Math.floor(target));
            setCurrentPage(page);
            enqueue(async () => {
                await ensurePage(page, generation);
                if (generation !== generationRef.current) {
                    return;
                }
                // 可能拉完才发现没那么多数据（插件到底了），回落到最后一页
                const total = Math.max(
                    1,
                    Math.ceil(itemsRef.current.length / pageSizeRef.current),
                );
                if (page > total) {
                    setCurrentPage(total);
                }
            });
        },
        [enqueue, ensurePage],
    );

    const changePageSize = useCallback(
        (size: number) => {
            const next = Math.max(1, Math.floor(size));
            if (next === pageSizeRef.current) {
                return;
            }
            // 尽量让「当前第一条」还留在视野里，而不是粗暴跳回第一页
            const firstIndex = (currentPageRef.current - 1) * pageSizeRef.current;
            pageSizeRef.current = next;
            setPageSize(next);
            writeStoredPageSize(storageKey, next);
            goToPage(Math.floor(firstIndex / next) + 1);
        },
        [goToPage, storageKey],
    );

    const replaceAll = useCallback((next: T[]) => {
        itemsRef.current = next;
        sourcePageRef.current = 0;
        isEndRef.current = true;
        stalledRef.current = false;
        setItems(next);
        setIsEnd(true);
        setStalled(false);
        setLoading(false);
        const total = Math.max(1, Math.ceil(next.length / pageSizeRef.current));
        setCurrentPage((page) => Math.min(page, total));
    }, []);

    const reload = useCallback(() => setNonce((n) => n + 1), []);

    const hasMore = !isEnd && !stalled;

    const totalPages = Math.max(
        1,
        Math.ceil(
            // 已到底（或音源不再给新数据）时以实际拉到的条数为准：插件报的 worksNum 可能偏大
            // （下架、权限等），否则会出现「点进去是空的」。
            Math.max(items.length, hasMore ? options.expectedTotal ?? 0 : 0) / pageSize,
        ),
    );

    return useMemo(
        () => ({
            items,
            currentPage,
            totalPages,
            pageSize,
            pageSizeOptions,
            isEnd,
            stalled,
            hasMore,
            expectedTotal: options.expectedTotal,
            sourcePage: sourcePageRef.current,
            loading,
            loadingMore,
            goToPage,
            loadMore,
            retry,
            changePageSize,
            replaceAll,
            reload,
        }),
        [
            items,
            currentPage,
            totalPages,
            pageSize,
            isEnd,
            stalled,
            hasMore,
            options.expectedTotal,
            loading,
            loadingMore,
            goToPage,
            loadMore,
            retry,
            changePageSize,
            replaceAll,
            reload,
        ],
    );
}
