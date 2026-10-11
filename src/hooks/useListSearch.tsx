import { useMemo, useRef, useState } from "react";

/**
 * 列表局部搜索（本地音乐 / 最近播放 / 下载管理等页面共用）：
 * 按标题 / 别名 / 歌手 / 专辑过滤当前已加载的列表。
 *
 * `keyword` 是输入框显示值（跟随打字）；`appliedKeyword` 才真正参与过滤——
 * 输入法拼音合成过程中不更新，等候选上屏（compositionEnd）才触发过滤，
 * 避免拼音中间态把列表筛得只剩几行。
 */
export function useListSearch<T extends Partial<IMusic.IMusicItem>>(musicList: T[]) {
    const [keyword, setKeyword] = useState("");
    const [appliedKeyword, setAppliedKeyword] = useState("");
    const composingRef = useRef(false);

    const handleInput = (value: string) => {
        setKeyword(value);
        if (!composingRef.current) {
            setAppliedKeyword(value);
        }
    };

    const handleComposition = (value: string, composing: boolean) => {
        composingRef.current = composing;
        if (!composing) {
            setAppliedKeyword(value);
        }
    };

    const clear = () => {
        setKeyword("");
        setAppliedKeyword("");
    };

    const trimmedKeyword = appliedKeyword.trim();
    const isSearching = trimmedKeyword.length > 0;
    const filteredList = useMemo(() => {
        if (!isSearching) {
            return musicList;
        }
        const kw = trimmedKeyword.toLowerCase();
        return musicList.filter((it) =>
            [it.title, it.alias, it.artist, it.album].some(
                (v) => typeof v === "string" && v.toLowerCase().includes(kw),
            ),
        );
    }, [musicList, isSearching, trimmedKeyword]);

    return {
        keyword,
        appliedKeyword,
        trimmedKeyword,
        isSearching,
        filteredList,
        handleInput,
        handleComposition,
        clear,
    };
}

/** 列表局部搜索输入框（`useListSearch` 的配套 UI，与 MusicList 工具条里同款） */
export function ListSearchBox(props: {
    keyword: string;
    placeholder?: string;
    onInput: (value: string) => void;
    onComposition: (value: string, composing: boolean) => void;
    onClear: () => void;
}) {
    return (
        <div className="music-search-box">
            {/* Icon 组件依赖运行时环境，这里用内联 SVG 保持与 MusicList 工具条一致的外观 */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
            </svg>
            <input
                value={props.keyword}
                onChange={(e) => props.onInput(e.target.value)}
                onCompositionStart={(e) => props.onComposition(e.currentTarget.value, true)}
                onCompositionEnd={(e) => props.onComposition(e.currentTarget.value, false)}
                placeholder={props.placeholder ?? "搜索"}
            />
            {props.keyword && (
                <span className="music-search-clear" title="清除搜索" onClick={props.onClear}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                </span>
            )}
        </div>
    );
}
