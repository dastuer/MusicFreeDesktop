# MusicFree Desktop（macOS / Windows）

基于 Electron + React + TypeScript 全新实现的 MusicFree 桌面版。前端全部页面与交互参考网易云音乐 macOS 客户端重构：左侧边栏导航 + 顶部标题栏（红绿灯内嵌、前进/后退、搜索框）+ 底部播放条 + 正在播放大封面歌词页。Windows 侧复用同一套界面，只单独适配了标题栏按钮、图标与安装方式。

**与 MusicFree 移动端音源插件（.js）完全兼容**——插件在主进程沙箱中运行，可用依赖与移动端一致（cheerio / crypto-js / axios / dayjs / qs / he / big-integer / webdav）。

## 开发

```bash
npm install          # 国内网络建议先执行: npm config set electron_mirror https://npmmirror.com/mirrors/electron/
npm run dev          # 开发模式（vite + esbuild watch + electron）
npm run build        # 生产构建（dist-renderer + dist-electron）
npm start            # 运行生产构建
```

## 打包与发布

```bash
npm run reinstall    # 本机自用：只出 .app 并覆盖 /Applications，随后启动
npm run dist:mac     # macOS dmg → release/MusicFreeDesktop-<version>-arm64.dmg
npm run dist:win     # Windows → release-win/ 下的 Setup 与 Portable exe
```

Windows 版可直接在这台 macOS 上交叉构建，不需要 wine。两个平台的产物都**未签名 / 未公证**：
macOS 首次打开需右键 →「打开」，Windows 首跑会有 SmartScreen 提示。

已经发布的版本与安装包：[Releases](https://github.com/dastuer/MusicFreeDesktop/releases)（当前最新 `v1.0.0`）。

## 桌面端兼容性设计

| 要求 | 实现 |
| --- | --- |
| 字体 | macOS 系统字体栈 `-apple-system / SF Pro Text / PingFang SC`，`-webkit-font-smoothing: antialiased`，全部 px 定尺寸（无移动端 rpx 缩放） |
| 图片像素 | 高分屏下封面按 CSS 尺寸 1:1 渲染不强制放大；`<img>` 原图直出 + `object-fit: cover`；加载失败回退矢量占位 |
| 原生窗口 | `titleBarStyle: hiddenInset` 红绿灯内嵌，侧边栏毛玻璃（vibrancy: sidebar），拖拽区域精确限定 |
| 系统集成 | `navigator.mediaSession` 对接 macOS 控制中心 / 触控栏（封面、歌名、上下首控制） |

## 架构

```
electron/                 主进程
  main.ts                 窗口、IPC 路由、渲染进程控制台转发
  services/
    pluginHost.ts         插件宿主（与移动端相同的 Function 沙箱 + _require 白名单，
                          方法结果自动注入 platform，等价于移动端 resetMediaItem）
    mediaProtocol.ts      mfs:// 自定义协议：代理远程音频流（携带插件返回的
                          Referer/UA/headers，支持 Range 拖动进度，axios 流式实现）
    localMusic.ts         本地音乐扫描（music-metadata 解析 ID3/FLAC 标签与内嵌封面）
    configStore.ts        userData 持久化（插件元信息、播放历史、用户歌单）
src/                      渲染进程
  core/
    trackPlayer.ts        HTMLAudio 播放核心（与移动端 ITrackPlayer 同构的 API 面：
                          playList/currentMusic/repeatMode/rate/seekTo + jotai hooks）
    ipc.ts                IPC 桥 + 插件调用（30s 超时）+ mfs:// 链接构造
    theme.ts              明暗主题（CSS 变量 + data-theme，支持跟随系统）
    router.ts             栈式路由（前进/后退/replace）
    musicHistory.ts / musicSheet.ts / appConfig.ts
  components/
    layout/               Sidebar / PlayerBar / MusicDetailOverlay / PlayQueuePanel
    base/                 Icon(SVG) / Cover / Slider / MusicList / MediaHeader /
                          ContextMenu / Toast / AddToSheetPanel
  pages/                  home / search / sheetDetail / albumDetail / artistDetail /
                          topList / topListDetail / localMusic / history /
                          pluginManage / settings
```

## 功能清单

- 发现音乐：推荐歌单（tag 切换）+ 排行榜入口（来自插件 `getRecommendSheetTags` / `getTopLists`）
- 搜索：单曲/歌单/专辑/歌手 四类，可切换音源插件，分页加载
- 歌单 / 专辑 / 歌手 / 榜单详情页（通用媒体头 + 歌曲表格，分页加载更多、多选批量操作）
- 播放：列表循环 / 随机 / 单曲循环、倍速、音量、进度拖动（Range 流式）、下一首播放、播放队列面板。
  在列表里点歌会把整份列表换进播放队列，队列记住自己来自哪份列表，同一份里继续点歌不会重复重排
- 快捷键：空格播放 / 暂停，← → 上一首 / 下一首，↑ ↓ 音量
- 正在播放页：大封面 + 歌词滚动（`getLyric`，支持网络 LRC）
- 本地音乐：文件夹扫描、ID3 元数据、内嵌封面、本地文件流播放
- 下载管理：批量下载、断点目录可配、下载完成后可直接播放本地文件
- 最近播放（主进程持久化，重启恢复）
- 用户歌单：创建 / 收藏单曲 / 侧边栏入口
- 音源插件管理：网络安装 / 本地安装、启用禁用、排序、用户变量、卸载
- 设置：主题（浅色/深色/跟随系统）、默认音质（低/标准/高/无损）、记忆播放进度、媒体缓存清理、歌单与配置备份
- 播放列表与当前歌曲持久化，重启后恢复

## 已知限制

- 桌面歌词、歌单导入 / 分享、自定义主题背景图尚未实现
- 音源可用性取决于插件与其上游平台（部分平台有网络/风控限制）
- 安装包未签名 / 未公证，首次启动需要手动放行（见上面「打包与发布」）

## 插件安装

设置 → 音源插件，输入插件 js 地址（如官方列表中的条目）或从本地 .js 文件安装。官方插件列表：https://github.com/maotoumao/MusicFreePlugins
