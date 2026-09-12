import { atom, getDefaultStore, useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";

/**
 * 主题系统：CSS 变量 + data-theme 属性
 * 对齐网易云桌面端：亮色为 #ec4141 品牌红，暗色为 #ea3d3d
 */

export type ThemeType = "light" | "dark";

export const themeTypeAtom = atom<ThemeType>("light");

export const lightTheme = {
    primary: "#ec4141",
    pageBackground: "#ffffff",
    sidebarBackground: "#f5f5f7",
    hoverBackground: "rgba(0,0,0,0.06)",
    activeBackground: "rgba(0,0,0,0.09)",
    text: "#333333",
    textSecondary: "#666666",
    textTertiary: "#999999",
    textPlaceholder: "#cccccc",
    divider: "rgba(0,0,0,0.09)",
    playerBarBackground: "#f5f5f7",
    mask: "rgba(0,0,0,0.4)",
};

export const darkTheme = {
    primary: "#ea3d3d",
    pageBackground: "#1a1a1a",
    sidebarBackground: "#141414",
    hoverBackground: "rgba(255,255,255,0.08)",
    activeBackground: "rgba(255,255,255,0.12)",
    text: "#e5e5e5",
    textSecondary: "#a8a8a8",
    textTertiary: "#7c7c7c",
    textPlaceholder: "#5c5c5c",
    divider: "rgba(255,255,255,0.09)",
    playerBarBackground: "#191919",
    mask: "rgba(0,0,0,0.6)",
};

const themeVars: Record<keyof typeof lightTheme, string> = {
    primary: "--primary-color",
    pageBackground: "--page-bg",
    sidebarBackground: "--sidebar-bg",
    hoverBackground: "--hover-bg",
    activeBackground: "--active-bg",
    text: "--text-color",
    textSecondary: "--text-secondary",
    textTertiary: "--text-tertiary",
    textPlaceholder: "--text-placeholder",
    divider: "--divider",
    playerBarBackground: "--playerbar-bg",
    mask: "--mask",
};

function applyTheme(type: ThemeType) {
    const theme = type === "dark" ? darkTheme : lightTheme;
    (Object.keys(themeVars) as (keyof typeof lightTheme)[]).forEach((key) => {
        document.documentElement.style.setProperty(themeVars[key], theme[key]);
    });
    document.documentElement.dataset.theme = type;
}

export function useThemeSetup() {
    const setThemeType = useSetAtom(themeTypeAtom);

    useEffect(() => {
        const saved = (localStorage.getItem("theme") as string) || "light";
        const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        const initial: ThemeType =
            saved === "auto" ? (systemDark ? "dark" : "light") : (saved as ThemeType);
        setThemeType(initial);
        applyTheme(initial);

        const media = window.matchMedia("(prefers-color-scheme: dark)");
        const handler = () => {
            if ((localStorage.getItem("theme") as string) === "auto") {
                const next: ThemeType = media.matches ? "dark" : "light";
                setThemeType(next);
                applyTheme(next);
            }
        };
        media.addEventListener("change", handler);
        return () => media.removeEventListener("change", handler);
    }, [setThemeType]);
}

export function setTheme(type: "light" | "dark" | "auto") {
    localStorage.setItem("theme", type);
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved: ThemeType = type === "auto" ? (systemDark ? "dark" : "light") : type;
    applyTheme(resolved);
    getDefaultStore().set(themeTypeAtom, resolved);
    return resolved;
}

export function useThemeType() {
    return useAtomValue(themeTypeAtom);
}
