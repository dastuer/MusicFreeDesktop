/** 通用数组工具 */

/**
 * 按 id 去重，保留首次出现的顺序。
 *
 * 音源返回的列表里真的会出现同一条目重复：温mg 的 `getRecommendSheetTags` 把
 * 「流行」「经典老歌」同时放进了 `pinned` 和首个分组，两边的 id 一模一样。
 * 而发现页是把 `[...pinned, ...data[0].data]` 直接拼起来的 —— 结果就是标签重复出现，
 * 并且 React 报 "Encountered two children with the same key: 1000001672"。
 *
 * id 为空的条目一律保留：它们无法参与去重判断，合并成一个反而会丢数据。
 */
export function uniqueById<T extends { id?: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    return items.filter((item) => {
        const id = item?.id === undefined || item?.id === null ? "" : String(item.id);
        if (!id) {
            return true;
        }
        if (seen.has(id)) {
            return false;
        }
        seen.add(id);
        return true;
    });
}
