# 2026-11-16 · dsh-leader-agent 宣发

**我的 20 个并行任务，终于不用一个个追了。**

把“人卡在开发循环里”讲成一个具体的转变：从同时追五个任务，到把追问交给 Leader Agent，最后只负责决定。

![封面预览](preview.jpg)

## 成品

| 内容 | 位置 |
|---|---|
| 竖屏视频 1080×1920，66.9 秒 | [promo-1080x1920.mp4](https://dsh-agent-leader.oss-cn-beijing.aliyuncs.com/growing/2026-11-16-leader-agent-promo/video/promo-1080x1920.mp4) |
| 单文件交互 HTML（下载后打开） | [promo-standalone.html](https://dsh-agent-leader.oss-cn-beijing.aliyuncs.com/growing/2026-11-16-leader-agent-promo/html/promo-standalone.html) |
| 旁白 MP3 | [narration-zh.mp3](https://dsh-agent-leader.oss-cn-beijing.aliyuncs.com/growing/2026-11-16-leader-agent-promo/audio/narration-zh.mp3) |
| 封面 9:16 | [cover-9x16.png](https://dsh-agent-leader.oss-cn-beijing.aliyuncs.com/growing/2026-11-16-leader-agent-promo/covers/cover-9x16.png) |
| 封面 3:4 | [cover-3x4.png](https://dsh-agent-leader.oss-cn-beijing.aliyuncs.com/growing/2026-11-16-leader-agent-promo/covers/cover-3x4.png) |
| 源 HTML + 小素材 | [`source/`](source/) |
| 分镜与旁白 | [`storyboard.md`](storyboard.md)、[`script.md`](script.md) |
| 音频时间轴 | [`timeline.json`](timeline.json) |
| 媒体清单 | [`media.json`](media.json) |

> 视频、音频、standalone 与全尺寸封面都在 OSS；Git 只保留源文件、文本、索引和 64 KB 预览图。
>
> OSS 标准域名对 HTML 会强制下载（`Content-Disposition: attachment`），这是 OSS 的安全策略；下载后用浏览器打开即可。要在线直接预览，需要给 bucket 绑定自定义域名。

## 事实

- 画幅：1080×1920，30fps，H.264 + AAC。
- 旁白：豆包 TTS 2.0，`zh_male_jieshuoxiaoming_uranus_bigtts`，语速 −5。
- 旁白分 8 段合成，按实测时长重排场景；总长 66.914 秒。
- 封面标题：`我的 20 个并行任务，终于不用一个个追了`；眉标：`分享我的 AI 工作流`。
- 叙事结构：5 个任务压过来 → 人成了循环的阻碍点 → 把追问交给 Leader → 输入/卡片/汇报三段演示 → 效率与注意力 → 品牌收尾。

## 这次沉淀下来的方法

1. **音频优先**：先逐段 TTS、测长，再由 `lead + speech + tail` 推场景起点；不要先写死 72 秒再硬贴旁白。
2. **多阶段场景单独记 mark**：S4 的输入/卡片/汇报不是三个独立场景，用局部偏移 `b/c` 管理，避免全局时间互耦。
3. **真实截图只做上下文**：桌面 App 窗口负责“真的在跑”，手机上要读的标题/槽位/状态用裁切卡片和 HTML 大字重排。
4. **封面独立做**：标题先写“我的经验 + 具体问题 + 方法/收益”，再从视频素材里选 2 张卡，不把视频第一帧当封面。
5. **成品外置**：仓库保留可编辑源文件与媒体索引，OSS 保存字节；这样代码仓库不会被几百 MB 媒体污染。

## 媒体

- Bucket：`dsh-agent-leader`（`oss-cn-beijing`，公共读，专用 bucket）
- 前缀：`growing/2026-11-16-leader-agent-promo/`
- 所有 key 不可覆盖；重做换 `-v2` 等新 key，并把新记录追加到 `media.json`。
- 上传/校验方法见 [`../AGENTS.md`](../AGENTS.md) 与 [`../scripts/upload-media.sh`](../scripts/upload-media.sh)。
