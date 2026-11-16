# Agent Note: 视频任务使用独立流程与审核角色

Status: implemented

## Problem

本仓的 `LEADER.md` 与 `SLOTS.md` 原本只为研发任务设计：`dev` 负责实现，`review` 按 diff、测试、宿主 API 下限与 client 产物审查。视频任务的交付物是成片、封面、旁白与发布包，验收要看事实、平台画幅、首末帧、390 宽可读性、音频和 `media.json`，与代码审查没有交集。

直接用代码 review 审视频，会漏掉事实错误和平台规格；把视频制作拆成脚本、分镜、动效、发行多个角色，又会让小团队把时间花在交接上。与此同时，`LEADER.md` 只有 75 个单位余量、`SLOTS.md` 只有 33 个单位余量，角色正文写不下，流程只能靠 leader 每次口头补。

## Decision

- `LEADER.md` 增加任务类型路由：`研发` 走 `dev → review → CI`，`视频` 走 `video → video-review → 发布包`。`kind` 是 `create_card`/`update_card` 的卡片字段，不写在 `LEADER.md` 或 `SLOTS.md` 的配置里；`LEADER.md` 只约定取值词汇，流程由 leader 按 `kind` 选择并写进卡 `spec`，不新增运行时分支。
- 小团队只增加两个槽位：`video` 串行完成脚本、分镜、TTS、动画、渲染、封面和发布包；`video-review` 独立审片，不改片。审核会话可以在视频卡挂 `video-review`、在代码卡挂 `review`，一次只服务一张 active 卡。
- 不新增 `script` / `visual` / `motion` / `publish` / `content-review`。脚本、视觉、渲染、发行是同一个 `video` 的不同 gate，不是五个 worker；只有审核独立，避免自审。
- 视频简报必须点名技能入口：`promo-video` 是入口，旁白加载 `doubao-tts`，封面加载 `promo-stills`，真实截图加载 `e2e-scenarios`，终审对照 `promo-video/references/qa.md`。`LEADER.md` 只写何时加载，不复制技能正文。
- `LEADER.md` 预算从 1400 上调到 3300；`SLOTS.md` 从 682 上调到 5900。四个角色正文分别约 1235 / 1080 / 1468 / 1226 个单位，每节落在 1000–1500 的目标区间；天花板按实际值留约 10%，仍受 12% 上限约束。

## Consequences

`SLOTS.md` 的每个角色正文明显变长，但一次只注入被绑定的一个槽位；`video` 与 `video-review` 不会同时进入同一会话。`LEADER.md` 每轮都注入，增大的主要是 leader 上下文，不增加 worker 的固定开销。

视频任务现在有两套验收：`video-review` 决定能不能进入发布包，`review` 决定代码能不能合。视频里改了 `src/`、构建脚本或插件代码时，仍必须另开研发卡；`video-review` 不能替代代码门禁。

`kind` 不是工作流引擎：若要“视频卡没过脚本就不允许派工”的硬门禁，必须改派工或卡片代码，本次没有做。一张卡只能有一个 kind；同时有代码和视频工作就拆两张卡，不存在混合卡。存量项目要使用新角色，需要在卡片的 `slots` 里把槽位绑到会话；只改 `SLOTS.md` 不会自动绑定。

## Alternatives considered

- **复用 `review` 审视频**：少一个槽位，但代码审查的判据是 diff、测试和宿主 API，视频需要事实、平台、帧和音频；混在一个提示词里会让两边都做浅，否决。
- **拆成 script / visual / motion / publish / content-review 五个角色**：并行度更高，但 60–90 秒的片子交接成本大于并行收益，也不符合小团队编制，否决。
- **把视频流程写进派工代码，按 `kind` 强制门禁**：能做到硬约束，但要新增状态与迁移，超出本次文档与提示词范围；先由 `LEADER.md` 约束，后续确有需要再改代码。
- **保持原预算，压缩视频段**：只能写口号，写不下失败模式、验收证据和小团队边界；预算上调有明确理由，且仍保留约 11% 余量，否决继续压在小预算里。

## Testing

- `npm run check`：1160 个用例通过（17 跳过）；Agent Note 格式、文档工具名、文档预算、语法与覆盖率门禁全过。
- 角色正文按 `countDocUnits` 逐节计数：dev 1235、review 1080、video 1468、video-review 1226，均在 1000–1500 区间；SLOTS 总计 5358 / 5900，LEADER 2982 / 3300。
- 未改运行时与前端代码，未跑 e2e；本次变化只影响项目级提示词与文档预算。
