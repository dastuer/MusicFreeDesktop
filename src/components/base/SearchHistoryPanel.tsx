import React, { useLayoutEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { showToast } from "./Toast";
import {
    clearSearchHistory,
    getSearchHistory,
    removeSearchHistory,
} from "@/core/searchHistory";

/**
 * 搜索历史面板（挂在搜索框正下方，参考网易云桌面端）
 *
 * - 默认只展示两行，超出时才显示右下角的「展开/收起」按钮；
 * - 标题右侧的垃圾桶 = 一键清空；
 * - 鼠标悬浮某条历史时，条目右上角浮出删除按钮，只删这一条；
 * - 没有历史时同样出面板，只是换成一句空提示（清空后也停在这个空态）。
 *
 * 面板自身不控制显隐，由搜索框决定何时挂载 —— 挂载即读一次历史，
 * 「新增历史」只会发生在面板关闭时（回车搜索 / 点击历史都会关掉面板），
 * 所以不必引入全局状态同步。
 */

interface ISearchHistoryPanelProps {
    /** 点某条历史：由调用方负责回填输入框并发起搜索 */
    onPick: (keyword: string) => void;
}

/** 折叠状态下可见的行数 */
const COLLAPSED_ROWS = 2;

export default function SearchHistoryPanel(props: ISearchHistoryPanelProps) {
    const { onPick } = props;
    const [history, setHistory] = useState<string[]>(() => getSearchHistory());
    const [expanded, setExpanded] = useState(false);
    /** 内容超过两行时才需要「展开/收起」按钮，同时给右下角留出按钮的位置 */
    const [overflowing, setOverflowing] = useState(false);
    const chipsRef = useRef<HTMLDivElement>(null);

    /**
     * 数行数用「chip 出现了几种 offsetTop」，而不是比较 scrollHeight：
     * 折叠靠的是外层 overflow: hidden，chip 的布局位置不变，
     * 所以展开 / 折叠两态量出来的行数一致，不会因为 max-height 生效而误判成「不需要折叠」。
     * 面板宽度受窗口宽度限制，窗口变窄会让每行少放几个 chip，所以要跟着重新量。
     */
    useLayoutEffect(() => {
        const el = chipsRef.current;
        if (!el) {
            return;
        }
        const measure = () => {
            const tops = new Set<number>();
            Array.from(el.children).forEach((child) => {
                tops.add((child as HTMLElement).offsetTop);
            });
            setOverflowing(tops.size > COLLAPSED_ROWS);
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [history]);

    const handleClear = () => {
        setHistory(clearSearchHistory());
        showToast("已清空搜索历史");
    };

    const hasHistory = history.length > 0;

    return (
        <div className="search-history-panel">
            <div className="search-history-head">
                <span className="search-history-title">搜索历史</span>
                {/* 空历史没有可清的东西，垃圾桶跟着藏起来 */}
                {hasHistory && (
                    <span
                        className="search-history-clear"
                        title="清空搜索历史"
                        onClick={handleClear}
                    >
                        <Icon name="trash" size={14} />
                    </span>
                )}
            </div>

            {/* 没有历史也要出面板，只是换成一句空提示 —— 不然「点了搜索框没反应」看着像坏了 */}
            {!hasHistory ? (
                <div className="search-history-empty">暂无搜索历史</div>
            ) : (
                <>
                    <div className={`search-history-clip${expanded ? "" : " collapsed"}`}>
                        <div
                            ref={chipsRef}
                            className={`search-history-chips${overflowing ? " has-toggle" : ""}`}
                        >
                            {history.map((word) => (
                                <div
                                    key={word}
                                    className="search-history-chip"
                                    title={word}
                                    // 拦掉按下事件的默认行为：否则点历史时输入框会先失焦（光标闪一下再回来）
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => onPick(word)}
                                >
                                    <span className="search-history-chip-text">{word}</span>
                                    <span
                                        className="search-history-chip-remove"
                                        title="删除这条历史"
                                        onClick={(e) => {
                                            // 不能顺手触发外层的「用这条历史搜索」
                                            e.stopPropagation();
                                            setHistory(removeSearchHistory(word));
                                        }}
                                    >
                                        <Icon name="close" size={11} />
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {overflowing && (
                        <span
                            className="search-history-toggle"
                            title={expanded ? "收起" : "展开全部"}
                            onClick={() => setExpanded((v) => !v)}
                        >
                            <Icon
                                name="chevronDown"
                                size={14}
                                style={{ transform: expanded ? "rotate(180deg)" : "none" }}
                            />
                        </span>
                    )}
                </>
            )}
        </div>
    );
}
