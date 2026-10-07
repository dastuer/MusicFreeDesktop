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

- [ ] **系统托盘 + 关闭行为设置**：现在 `window-all-closed → app.quit()`（macOS 也是关窗即退），无托盘。目标：关闭 = 最小化到托盘（可设置），托盘菜单含播放/暂停/上一首/下一首/退出。
- [ ] **媒体键（Windows SMTC）**：macOS 已走 MediaSession；Windows 侧 Electron 33 理论上自动桥接 MediaSession → SMTC，实测确认，不生效则补主进程方案。
- [ ] **全局快捷键**：`globalShortcut` 可选注册 + 设置页说明区（当前快捷键只藏在按钮 tooltip 里）。
- [ ] **下载写标签**：`downloadService.ts` 下载完不写 ID3/FLAC 元数据、不嵌封面。补标题/歌手/专辑/封面写入 + 歌词 .lrc 同步落盘。
- [ ] **桌面歌词设置**：字体大小、双行（原文+翻译）、鼠标穿透锁定（`setIgnoreMouseEvents`）。参考网易云桌面歌词样式面板。
- [ ] **定时关闭（睡眠定时器）**：倒计时 + `pause()`，成本极低。
- [ ] **本地歌词匹配**：本地歌曲拿不到歌词（`loadCurrentLyric` 对 `localPath` 直接跳过）。用 `neteaseMatch` 的匹配能力按「标题+歌手」补歌词/封面；同时支持同名 `.lrc` 与内嵌 USLT。
- [ ] **任务栏缩略图按钮**：Electron `setThumbarButtons` 现成。

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
