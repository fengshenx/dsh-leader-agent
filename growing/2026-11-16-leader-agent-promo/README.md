# 2026-11-16 · dsh-leader-agent 宣发

**我同时开发 20 个需求的经验。**

封面只讲这一句：不靠加班，靠把追问交给 Leader Agent。视频开头 9.5 秒就是封面段，纯文字、无截图；第一帧可直接给抖音当封面。

![封面预览](preview.jpg)

## 成品

| 内容 | 位置 |
|---|---|
| 竖屏视频 1080×1920，85.7 秒，60fps | [promo-1080x1920-v2.mp4](https://dsh-agent-leader.oss-cn-beijing.aliyuncs.com/growing/2026-11-16-leader-agent-promo/video/promo-1080x1920-v2.mp4) |
| 单文件交互 HTML（下载后打开） | [promo-standalone-v2.html](https://dsh-agent-leader.oss-cn-beijing.aliyuncs.com/growing/2026-11-16-leader-agent-promo/html/promo-standalone-v2.html) |
| 旁白 MP3 | [narration-zh-v2.mp3](https://dsh-agent-leader.oss-cn-beijing.aliyuncs.com/growing/2026-11-16-leader-agent-promo/audio/narration-zh-v2.mp3) |
| 封面 9:16（视频首帧） | [cover-9x16-v2.png](https://dsh-agent-leader.oss-cn-beijing.aliyuncs.com/growing/2026-11-16-leader-agent-promo/covers/cover-9x16-v2.png) |
| 封面 3:4 | [cover-3x4-v2.png](https://dsh-agent-leader.oss-cn-beijing.aliyuncs.com/growing/2026-11-16-leader-agent-promo/covers/cover-3x4-v2.png) |
| 源 HTML + 小素材 + 3:4 封面源文件 | [`source/`](source/) |
| 分镜与旁白 | [`storyboard.md`](storyboard.md)、[`script.md`](script.md) |
| 音频时间轴 | [`timeline.json`](timeline.json) |
| 媒体清单 | [`media.json`](media.json) |

> 视频、音频、standalone 与全尺寸封面都在 OSS；Git 只保留源文件、文本、索引和 31 KB 预览图。
>
> OSS 标准域名对 HTML 会强制下载（`Content-Disposition: attachment`），这是 OSS 的安全策略；下载后用浏览器打开即可。要在线直接预览，需要给 bucket 绑定自定义域名。

## 这次改了什么

- **封面标题**从“我的 20 个并行任务，终于不用一个个追了”改成“**我同时开发 20 个需求的经验**”，把“我的经验”放在标题里。
- **封面去掉截图和任务卡**，只留标题、副标题、品牌与深色背景；视频第一帧就是完整封面。
- **视频开头加 S0 封面段**（9.5 秒），有独立旁白解说，之后才进入“同时跑五个任务”的现场。
- **全片“Leader”统一为“Leader Agent”**，包括旁白、标题、看板汇报头和 S3 光球。
- **修正 S4B 的产品表述**：卡片是“正在处理的任务”，不是“正在工作的会话”；同一任务背后可能有多个 Worker Agent 会话。
- **结尾补 DeepSeek Harness 安装说明**：画面加“在 DeepSeek Harness 里安装”，旁白也说明；安装命令保留 `dsh plugin --profile web add dsh-leader-agent`。
- **帧率从 30fps 提到 60fps**，逐帧渲染，避免抖音播放时明显卡顿。

## 事实

- 画幅：1080×1920，60fps，H.264 + AAC。
- 旁白：豆包 TTS 2.0，`zh_male_jieshuoxiaoming_uranus_bigtts`，语速 −5。
- 旁白分 9 段合成，按实测时长重排场景；总长 85.688 秒。
- 封面：9:16 直接取 S0 首帧；3:4 单独排版，见 [`source/cover-3x4.html`](source/cover-3x4.html)。
- 叙事结构：封面经验 → 5 个任务压过来 → 人成了循环的阻碍点 → 把追问交给 Leader Agent → 输入/卡片/汇报三段演示 → 效率与注意力 → DeepSeek Harness 安装 + 品牌收尾。

## 这次沉淀下来的方法

1. **封面先写“我的经验”**：标题是“我同时开发 20 个需求的经验”，不是“分享我的工作流”；用户先被具体经历吸引，再听方法。
2. **视频首帧就是封面**：S0 第一帧完整显示标题，不做黑屏淡入；抖音取首帧时不会拿到空画面。
3. **音频优先**：先逐段 TTS、测长，再由 `lead + speech + tail` 推场景起点；新增 S0 后所有场景起点整体后移。
4. **60fps 逐帧渲染**：用 `seek(t)` + 截图，不依赖屏幕录制；旁白与画面都按同一份 timeline 对齐。
5. **多阶段场景单独记 mark**：S4 的输入/卡片/汇报不是三个独立场景，用局部偏移 `b/c` 管理。
6. **成品外置**：仓库保留可编辑源文件与媒体索引，OSS 保存字节。

## 媒体

- Bucket：`dsh-agent-leader`（`oss-cn-beijing`，公共读，专用 bucket）
- 前缀：`growing/2026-11-16-leader-agent-promo/`
- v2 使用 `-v2` key；v1 保留在 OSS，不覆盖。重做继续用新 key，并追加到 `media.json`。
- 上传/校验方法见 [`../AGENTS.md`](../AGENTS.md) 与 [`../scripts/upload-media.sh`](../scripts/upload-media.sh)。
