/**
 * electron-builder 配置（从 package.json 的 "build" 字段迁出）
 *
 * 迁移原因：接入 Sparkle 2 应用内更新（electron-sparkle-updater）需要把
 * sparkleBuilderConfig() 返回的 JS 对象合并进构建配置，JSON 字段做不到。
 * 注意该片段含顶层 mac/dmg/zip 键，直接 spread 会覆盖本文件的 mac 配置，
 * 所以这里手动按键合并（mac.extendInfo、extraFiles、asarUnpack、files 拼接）。
 *
 * mac 更新链路：Sparkle 2 + ad-hoc 签名（免 Developer ID 证书），
 *   经 electron-sparkle-updater 的 N-API 桥工作；Windows 维持 NSIS/portable，
 *   应用内更新暂不做（服务端只做检查 + 跳转下载页）。
 */

const {
    sparkleBuilderConfig,
    adHocSignAfterPack,
} = require("electron-sparkle-updater/builder");

/** Sparkle EdDSA 公钥（私钥在发布者本机钥匙串，名 https://sparkle-project.org） */
const SPARKLE_PUBLIC_ED_KEY = "38LHF3fdC4xjvz5+LhEHCgKSTvZJKShpMDKRWJkKlTk=";

const sparkleFragment = sparkleBuilderConfig({
    feedUrl:
        "https://github.com/dastuer/MusicFreeDesktop/releases/latest/download/appcast.xml",
    publicEdKey: SPARKLE_PUBLIC_ED_KEY,
});

/** 基础打包内容：Sparkle 片段要求排除 vendor 目录（framework 由 extraFiles 注入） */
const files = [
    "dist-electron/**/*",
    "dist-renderer/**/*",
    "package.json",
    ...sparkleFragment.files,
];

module.exports = {
    appId: "com.huah.musicfree-desktop",
    productName: "MusicFreeDesktop",
    directories: {
        output: "release",
        buildResources: "build",
    },
    files,
    mac: {
        icon: "build/icon.icns",
        category: "public.app-category.music",
        // Sparkle 2 要求 bundle 有有效签名，ad-hoc（"-"）即可，免费免证书；
        // afterPack 的 adHocSignAfterPack 会在框架注入后统一重签
        identity: "-",
        target: [
            {
                target: "dmg",
                arch: ["arm64"],
            },
            {
                // Sparkle appcast 要求 zip 产物做更新包（dmg 只用于首次安装）
                target: "zip",
                arch: ["arm64"],
            },
        ],
        // Sparkle 片段的 extendInfo：SUFeedURL/SUPublicEDKey/本地化声明等
        extendInfo: sparkleFragment.mac.extendInfo,
    },
    win: {
        icon: "build/icon.ico",
        target: [
            {
                target: "nsis",
                arch: ["x64"],
            },
            {
                target: "portable",
                arch: ["x64"],
            },
        ],
    },
    nsis: {
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: "MusicFree",
        artifactName: "MusicFreeDesktop-Setup-${version}.exe",
        deleteAppDataOnUninstall: false,
        runAfterFinish: true,
    },
    portable: {
        artifactName: "${productName}-Portable-${version}.${ext}",
    },
    afterPack: require.resolve("./scripts/afterPack.cjs"),
    // framework 注入与原生 addon 解包
    extraFiles: sparkleFragment.extraFiles,
    asarUnpack: sparkleFragment.asarUnpack,
    // blockmap 是 electron-updater 的差量元数据，更新走 Sparkle appcast，用不上
    dmg: sparkleFragment.dmg,
};
