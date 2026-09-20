/**
 * 搜索历史（localStorage 持久化）
 *
 * 只存关键词字符串数组，最新的在最前面；重复关键词只置顶不新增。
 * 条数很少（上限 30 条），读写都直接整体序列化，不做增量维护。
 */

const STORAGE_KEY = "searchHistory";

/** 历史条数上限：太长的列表既难找又白占 localStorage */
export const SEARCH_HISTORY_LIMIT = 30;

/** 读取全部历史。数据损坏时当作空列表，绝不把异常抛给调用方（面板是聚焦即渲染的路径） */
export function getSearchHistory(): string[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.filter(
            (item): item is string => typeof item === "string" && item.trim().length > 0,
        );
    } catch {
        return [];
    }
}

function writeHistory(list: string[]) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
        // localStorage 不可用（写满 / 被禁用）时降级为「本次不记历史」，不影响搜索本身
    }
}

/** 新增一条历史：已存在则置顶，超出上限丢最旧的。返回写入后的完整列表 */
export function addSearchHistory(keyword: string): string[] {
    const word = keyword.trim();
    if (!word) {
        return getSearchHistory();
    }
    const next = [word, ...getSearchHistory().filter((it) => it !== word)].slice(
        0,
        SEARCH_HISTORY_LIMIT,
    );
    writeHistory(next);
    return next;
}

/** 删除单条历史，返回写入后的完整列表 */
export function removeSearchHistory(keyword: string): string[] {
    const next = getSearchHistory().filter((it) => it !== keyword);
    writeHistory(next);
    return next;
}

/** 一键清空，返回空列表（与 add/remove 同签名，方便调用方直接 setState） */
export function clearSearchHistory(): string[] {
    writeHistory([]);
    return [];
}
