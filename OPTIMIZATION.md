# MusicFreeDesktop 优化路线图

> 基于 2026-10-07 的全量源码分析（播放核心 `src/core/trackPlayer.ts`、主进程 `electron/services/*`、全部页面与组件），对比 Spotify / 网易云 / 酷狗 / 酷我 桌面端整理。
> 完成一项就把 `- [ ]` 勾成 `- [x]`。

## 现状总结

**已经做得很好的**（多数是主流播放器都没做好的）：无缝音质切换（影子 audio 预缓冲交接）、音质降级重试 + 坏源自动跳歌、播放卡顿 12s 自救、写穿式磁盘缓存 + 断点续传（`mediaCache`/`mediaDownloader`）、退出会话恢复（歌 + 进度首帧就位）、「下一首播放」在随机/单曲循环下也保证生效的登记机制、WebDAV 备份、桌面歌词（mac 菜单栏 + Win 悬浮窗双形态）、网易云日推/歌单导入匹配流水线。

**四大差距**：系统集成（托盘/媒体键/全局快捷键几乎空白）、歌词（翻译未接、桌面歌词无样式设置）、播放队列面板（功能单薄）、一批「数据已有但 UI 没接上」的半成品。

---

## 第一梯队：数据/机制现成，纯接线（感知最强、成本最低）

- [x] **歌词翻译**：`ILyricSource.translation` 已定义（`src/types/core.d.ts`）但 `loadCurrentLyric` 只解析 `rawLrc`，翻译被丢弃。详情页歌词区改为原文 + 译文双行。
- [x] **倍速播放入口**：`rateAtom`/`setRate`（`trackPlayer.ts`）已完整实现（含影子元素同步）但无 UI 入口；播放栏加倍速菜单，并做持久化（重启记住）。
- [x] **播放队列面板增强**（`PlayQueuePanel.tsx`）：拖拽排序（复用 react-draggable 交互）、右键菜单（下一首播放/收藏/下载/查看专辑）、行内封面与时长、「保存为歌单」。
- [x] **歌手/专辑可点**：MusicList 歌手名/专辑列点击跳转，右键菜单补「查看歌手」（`artistDetail` 页面现成，缺入口）。
- [x] **单实例锁**：`requestSingleInstanceLock` + second-instance 唤起已有窗口（当前双开会双份音频 + 数据竞争）。
- [x] **死代码清理**：downloading 页 `onDownloadMore` 死接线、pluginManage 恒 null 死三元、空目录 `src/components/mediaItem/`。

## 第二梯队：桌面播放器的「及格线」体验

- [x] **系统托盘 + 关闭行为设置**：`electron/services/systemIntegration.ts` 全平台常驻托盘（可设置隐藏），菜单含 播放/暂停/上一首/下一首/喜欢/显示主窗口/完全退出；关闭行为可设「最小化到托盘（默认）/ 直接退出」，关窗前照常走一次会话落盘。托盘图标由渲染进程 canvas 画成（mac 模板图随深浅色反色 / win 白色实心）。
- [x] **媒体键（Windows SMTC）**：MediaSession 补齐 `playbackState`（play/pause 事件同步）、`setPositionState`（1s 限频）与 `seekto/seekforward/seekbackward` handler——Electron 33 桥接 SMTC 需要 metadata+handler 齐全才出系统面板与媒体键；macOS 控制中心同步获得进度条与拖动。
- [x] **全局快捷键**：媒体键（MediaPlayPause/Next/Prev）+ `Cmd/Ctrl+Alt+M` 显示/隐藏主窗口，默认关闭、设置页开启（避免与其它应用抢键）；应用内快捷键在设置页有说明区。
- [x] **下载写标签**：`electron/services/tagWriter.ts` 零依赖手写 ID3v2.3（TIT2/TPE1「/」分隔/TALB/TYER/TRCK/TCON/USLT/APIC，中文走 UTF-16）与 FLAC（Vorbis Comment 多 ARTIST 字段 + PICTURE + LYRICS）；downloadService 下载完成后经插件 getLyric 拿歌词（译文并轨）、artwork 拉封面写入，非 mp3/flac 退同名 .lrc 边车。round-trip 经 music-metadata 官方解析器验证（含二次写入保留旧字段）。
- [x] **桌面歌词设置**：右键播放栏「词」按钮弹样式面板——形态（mac 菜单栏/悬浮窗）、字号四档、双行（原文+译文，菜单栏拼「原文 · 译文」）、鼠标穿透锁定（`setIgnoreMouseEvents` forward，锁定时悬浮窗不吃鼠标、隐藏遥控钮）；设置 localStorage 持久化 + 主进程落盘，悬浮窗高度随字号/行数自适应，开着切形态即时换装。
- [x] **定时关闭（睡眠定时器）**：`core/sleepTimer.ts`，播放栏「更多」菜单入口——10/20/30/45/60/90 分钟倒计时或播完 1/3/5 首后 `pause()`，到点自动停、菜单行实时显示剩余，可随时取消。
- [x] **本地歌词匹配**：`loadCurrentLyric` 对 localPath 不再跳过。优先级：内嵌歌词（MP3 USLT/FLAC LYRICS，主进程 `services/localLyrics.ts` 解析）→ 同名 .lrc 边车（UTF-8/GB18030 自动识别）→ 上次匹配的 localStorage 缓存 → 联网（装机 getLyric 插件按「标题+歌手」搜索，titleSim/artistSim 打分 ≥0.78 采信）。命中后经主进程把歌词+封面写回文件（下次即「文件自带」），封面同步进缓存与本地音乐列表。
- [x] **任务栏缩略图按钮**：Windows `setThumbarButtons`（上一首/播放暂停/下一首），图标与托盘同源由渲染进程生成，播放状态切换即时换图。
- [x] **检查更新**：`electron/services/updater.ts` 走 GitHub Releases 渠道（`releases/latest` API + compare-versions 比版本），只查不装（免签分发没有统一静默升级通道）。启动后渲染进程挂载时自动查一次（已打包 + 设置开启才联网，失败静默），设置页「关于」节可手动检查、开关「启动时自动检查更新」、展示新版本与更新说明并跳转 release 页；发现新版 App 内弹 toast 可直达。配置存 `app.updates.autoCheck`（默认开）。

## 第三梯队：体验升级

- [ ] **均衡器 / 播放增益**：WebAudio `BiquadFilter` 链 10 段 EQ + 预设（酷狗蝰蛇音效/网易云云村均衡器对标），需验证 `MediaElementSource` 与 `mfs://` 代理流兼容；增益允许音量 >100%。
- [ ] **淡入淡出（crossfade）**：可复用无缝换源的影子 audio 机制做双元素交叉衰减（Spotify 招牌）。音量均衡（ReplayGain）插件场景难扫描，可降级为「限制最大响度」。
- [ ] **收藏专辑/歌手**：`collections.ts` 目前只是去重工具；专辑/歌手页加收藏入口 + 侧边栏分组。
- [ ] **歌单内歌曲拖拽排序 + 自定义封面**：歌单目前只能按添加顺序倒序，封面取第一首歌不可换。
- [ ] **单歌单导入/导出**：JSON / M3U8 导出、剪贴板/文件导入，配合网易云匹配流水线可「分享歌单」。
- [ ] **大列表虚拟滚动**：MusicList 非分页模式最终挂载全部行，千首级歌单会卡；引入 react-window 之类。
- [ ] **迷你模式**：mini 悬浮播放器（酷狗/酷我有）。
- [ ] **历史页按日分组**：`playAt` 字段已有未用；顺带单条删除、历史内搜索、事件驱动刷新（当前 5s 轮询）。

## 观望（依赖插件生态，先不动）

- MV / 评论 / 电台 / 播客 / 逐字卡拉OK（YRC/QRC）：`IPlugin` 协议没有这些方法，等生态。
- 搜索联想 / 热搜榜：插件接口一般不提供，可由聚合源兜底再做。
- Hi-Res 细分音质档：当前 low/standard/high/super 四档（`core.d.ts`），依赖插件声明。

---

## 已知问题清单（bug / 半成品）

- [x] `electron/services/pluginHost.ts` 传给插件的 env 恒为 `os:"mac"`、`appVersion:"1.0.0"`——Windows 上插件拿错平台、版本判断失真。→ 已修：`os` 按 `process.platform` 映射，`appVersion` 读 `app.getVersion()`。
- [x] `electron/services/downloadService.ts` `removeTask` 不 abort 在途流，取消后文件继续写完成为孤儿。→ 已修：取消时中止 axios 流。
- [ ] 网易云 cookie 无续期机制，过期只能重新扫码（过期提示已有）。
- [ ] `albumDetail` 仍是「加载更多」旧分页，头部无「…」多选入口（落后于 `usePagedMusicList` 体系）。
- [ ] `musicHistory` 页 5s 轮询刷新，应改事件驱动。
- [x] `src/pages/downloading/index.tsx` `onDownloadMore` 死接线（从未渲染按钮）。→ 已清。
- [x] `src/pages/pluginManage/index.tsx` 恒为 null 的死三元。→ 已清。
- [x] `src/components/mediaItem/` 空目录。→ 已删。
