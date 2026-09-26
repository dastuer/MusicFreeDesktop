import React from "react";

/**
 * 播放器遥控图标的原始路径数据：桌面歌词的菜单栏托盘图标要把这些形状
 * 画进 canvas 导出 PNG（主进程拿不到 JSX），所以单独放一份；
 * 下面 iconPaths 的对应项由它生成，改形状只改这里。
 */
export const playerIconData = {
    play: {
        d: "M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5z",
        filled: true,
    },
    pause: {
        d: "M7 5h3.4v14H7zM13.6 5H17v14h-3.4z",
        filled: true,
    },
    prev: {
        d: "M7 6a1 1 0 0 1 2 0v12a1 1 0 0 1-2 0zm10.5.2-8.2 5.2a.7.7 0 0 0 0 1.2l8.2 5.2A.8.8 0 0 0 18.8 17V7a.8.8 0 0 0-1.3-.8z",
        filled: true,
    },
    next: {
        d: "M17 6a1 1 0 0 1 2 0v12a1 1 0 0 1-2 0zM6.5 6.2l8.2 5.2a.7.7 0 0 1 0 1.2l-8.2 5.2A.8.8 0 0 1 5.2 17V7a.8.8 0 0 1 1.3-.8z",
        filled: true,
    },
    heart: {
        d: "M12 20.7 4.7 13.4a5 5 0 0 1 7-7.1l.3.2.3-.2a5 5 0 0 1 7 7.1z",
        filled: false,
    },
    heartFilled: {
        d: "M12 20.7 4.7 13.4a5 5 0 0 1 7-7.1l.3.2.3-.2a5 5 0 0 1 7 7.1z",
        filled: true,
    },
} as const;

const iconPaths: Record<string, React.ReactNode> = {
    home: <path d="M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
    search: (
        <>
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="m20 20-4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
    ),
    toplist: <path d="M5 20V10m7 10V4m7 16v-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />,
    localMusic: (
        <>
            <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        </>
    ),
    history: (
        <>
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 7v5l3.5 2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
    ),
    plugin: <path d="M10 3a2 2 0 1 1 4 0v1h3a2 2 0 0 1 2 2v3h1a2 2 0 1 1 0 4h-1v3a2 2 0 0 1-2 2h-3v1a2 2 0 1 1-4 0v-1H7a2 2 0 0 1-2-2v-3H4a2 2 0 1 1 0-4h1V6a2 2 0 0 1 2-2h3z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />,
    settings: (
        <>
            <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.7 5.3l-1.9 1.9M7.2 16.8l-1.9 1.9M18.7 18.7l-1.9-1.9M7.2 7.2 5.3 5.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
    ),
    play: <path d={playerIconData.play.d} fill="currentColor" />,
    pause: <path d={playerIconData.pause.d} fill="currentColor" />,
    // 上一首：左侧竖条 + 左向三角。路径本身已经是正确的朝向，
    // 早期误加的 scale(-1,1) 会把两个图标一起镜像，导致「上一首/下一首」看起来反了。
    prev: <path d={playerIconData.prev.d} fill="currentColor" />,
    next: <path d={playerIconData.next.d} fill="currentColor" />,
    volume: <path d="M4 9.5h3L12 5v14l-5-4.5H4zM15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
    volumeMute: <path d="M4 9.5h3L12 5v14l-5-4.5H4zM16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
    repeatOff: <path d="M7 7h10a4 4 0 0 1 4 4v1M17 17H7a4 4 0 0 1-4-4v-1m1-5L7 4m-3 3h3m10 10 3 3m3-3h-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
    repeatQueue: <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
    repeatSingle: <path d="M7 7h10a4 4 0 0 1 4 4v1M17 17H7a4 4 0 0 1-4-4v-1m1-5L7 4m-3 3h3m10 10 3 3m3-3h-3M12 10v5m0-5-1.5 1M12 10l1.5 1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
    playQueue: <path d="M4 6h12M4 12h12M4 18h8M19 9v9m0 0a2.2 2.2 0 1 1-2-2.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
    /** 收藏到歌单：三条列表线 + 右下角加号 */
    addToSheet: (
        <>
            <path d="M4 6h9M4 12h9M4 18h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M17.5 10.5v7M14 14h7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
    ),
    heart: <path d={playerIconData.heart.d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
    heartFilled: <path d={playerIconData.heartFilled.d} fill="currentColor" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
    check: <path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />,
    trash: (
        <>
            <path d="M4 6h16M9.5 6V4.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V6m4.5 0-.9 13.1a2 2 0 0 1-2 1.9H7.9a2 2 0 0 1-2-1.9L5 6m4.5 4v7m5-7v7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </>
    ),
    plus: <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
    close: <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
    back: <path d="M14.5 6 8.5 12l6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
    forward: <path d="m9.5 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
    more: <path d="M6 12h.01M12 12h.01M18 12h.01" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />,
    chevronDown: <path d="m6 9.5 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
    musicNote: <path d="M9 18.5V6l10-2v12.5M9 18.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zm10-2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
    download: (
        <>
            <path d="M12 3.5v10m0 0 4-4m-4 4-4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </>
    ),
    open: <path d="M14 4h6v6M20 4 11 13M9 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
    /** 备份（导出）：托盘 + 向上箭头 */
    backup: (
        <>
            <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 3.5v11m0-11L8 7.5m4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </>
    ),
    /** 恢复（导入）：托盘 + 向下箭头 */
    restore: (
        <>
            <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 14.5v-11m0 11L8 10.5m4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </>
    ),
    /** 云端：WebDAV 相关操作 */
    cloud: <path d="M7 18h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 6.7 8.6A3.7 3.7 0 0 0 7 18z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />,
};

interface IIconProps {
    name: keyof typeof iconPaths | string;
    size?: number;
    className?: string;
    style?: React.CSSProperties;
    onClick?: (e: React.MouseEvent) => void;
    title?: string;
}

export default function Icon(props: IIconProps) {
    const { name, size = 18, className, style, onClick, title } = props;
    return (
        <span
            className={className}
            style={{ display: "inline-flex", alignItems: "center", ...style }}
            onClick={onClick}
            title={title}
        >
            <svg
                width={size}
                height={size}
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden
            >
                {iconPaths[name] ?? null}
            </svg>
        </span>
    );
}
