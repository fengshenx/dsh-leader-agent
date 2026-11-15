# Agent Note: 宣传片制作拆成入口技能与可复用能力

Status: implemented

## Problem

宣传片制作需要串联真实 UI 截图、文案、TTS、HTML 动画、录制与封面。此前这些方法只存在于一次性的会话与 `.dev` 脚本里，下一次容易重新踩三个坑：先写死时长再硬贴旁白、把桌面截图整体缩小当手机可读、把 API Key 写进脚本。按制作阶段平铺成五个 skill 会让关键接缝无人负责；做一个大 skill 又会让只做封面的任务加载整套 TTS 与录制细节。

## Decision

- **一个入口**：`promo-video` 负责分镜、时间轴契约、录制、封面编排与验收；文案留在入口的 references 里，不单独拆。
- **两个能力**：`doubao-tts` 只管分段合成、测长与补静音；`promo-stills` 只管 HTML→PNG 封面/静帧与标题公式。
- **截图复用**：真实 UI 截图继续走 `e2e-scenarios`，只加“宣传素材截图”一节，不新建平行 skill。
- **凭据只走环境变量**：脚本从 `DOUBAO_TTS_KEY` / `DOUBAO_TTS_API_KEY` 读取，缺变量即失败；不读密钥文件，不打印密钥。
- **时间轴音频优先**：旁白逐段测长，场景起点由 `lead + speech + tail` 累加；禁止把总时长写死。

## Consequences

- 用户只加载 `promo-video` 就能拿到端到端流程；单独做 TTS 或封面时按需加载能力 skill，上下文更小。
- e2e 的宿主、seed、截图纪律只有一处归属，不会出现两套截图夹具各自漂移。
- 代价是入口需要维护三条跨技能链接；能力脚本依赖仓库的 Playwright/ffmpeg 环境，安装包内不自动执行。
- 收益：宣传片制作从一次性会话经验变成可发现、可复用、无密钥落盘的协议层技能。

## Alternatives considered

- **五个阶段各一个 skill**：入口、TTS、截图、视频、图片并列；听起来整齐，但“音频长度 → 场景边界 → 动画关键帧”的接缝没有 owner，用户还得自己编排。
- **一个大 skill 包全部**：一次加载所有细节，做封面也会读到 TTS 鉴权与录制排错；后续复用 TTS 时无法独立触发。
- **新建独立的宣传截图 skill**：与现有 e2e 夹具重复，宿主/seed/清理规则会各自漂移；因此只在 `e2e-scenarios` 内补一节。

## Testing

更新 `tests/skills.test.js` 与 `tests/leader-wiring.test.js` 的发现名单并跑 `npm run check`；`tts.mjs --help` 与缺环境变量路径验证不打印密钥、失败即退出。真实合成只在用户明确要求时用环境变量调用。
