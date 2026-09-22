import { atom, getDefaultStore, useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";

/**
 * 主题系统：CSS 变量 + data-theme 属性
 * 对齐网易云桌面端：亮色为 #ec4141 品牌红，暗色为 #ea3d3d
 */

export type ThemeType = "light" | "dark";
export type ThemeSetting = ThemeType | "auto";

/** 用户的选择而不是解析结果：系统为浅色时"浅色"和"跟随系统"会解析出同一个主题，
 *  拿解析结果判高亮会导致点"跟随系统"毫无反馈 */
export const themeSettingAtom = atom<ThemeSetting>("light");

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
    // Windows 的标题栏按钮由系统绘制并叠在标题栏上，底色不跟主题走会在右上角留一块白
    window.mfp?.invoke("window:setCaptionOverlay", {
        color: theme.pageBackground,
        symbolColor: theme.text,
    });
}

function resolveTheme(setting: ThemeSetting): ThemeType {
    if (setting !== "auto") return setting;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useThemeSetup() {
    const setThemeSetting = useSetAtom(themeSettingAtom);

    useEffect(() => {
        const saved = ((localStorage.getItem("theme") as string) || "light") as ThemeSetting;
        setThemeSetting(saved);
        const initial = resolveTheme(saved);
        applyTheme(initial);

        const media = window.matchMedia("(prefers-color-scheme: dark)");
        const handler = () => {
            if (localStorage.getItem("theme") === "auto") {
                applyTheme(media.matches ? "dark" : "light");
            }
        };
        media.addEventListener("change", handler);
        return () => media.removeEventListener("change", handler);
    }, [setThemeSetting]);
}

export function setTheme(setting: ThemeSetting): ThemeType {
    localStorage.setItem("theme", setting);
    getDefaultStore().set(themeSettingAtom, setting);
    const resolved = resolveTheme(setting);
    applyTheme(resolved);
    return resolved;
}

export function useThemeSetting() {
    return useAtomValue(themeSettingAtom);
}
