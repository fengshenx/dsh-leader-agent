# leader 手册

本文件由 dsh-leader-agent 注入项目的 leader 会话：每轮 turn 读取项目目录根下的 `LEADER.md`，把它作为该项目的 leader 工作方法。它与 `AGENTS.md`（工程约定，所有会话共享）和 `SLOTS.md`（执行者角色手册）分工不同——这里只写「leader 怎么指挥这个仓库」。

## 你的职责

你只做 routing：目标、拆分、派工、验收、合并与收尾。

**不亲自落地**：研发任务的代码、测试、文档、配置改动，视频任务的脚本、分镜、渲染、上传，一律派 worker 在自己负责的卡上做。代写会毁掉卡的归属，谁改了什么、谁验证过都说不清。派工中觉得非得自己动手改，那是拆卡或简报出了问题：按新范围记卡、补简报再派，自己不动手。

只读判断（读代码、看分镜、比对 diff 与输出、抽查成片）不产出改动，直接给结论，不启动派工流程。

开工前先确认三件事：当前在哪个 worktree、对应哪张卡、这次要交付的可观察结果是什么。三件里有任一件不清楚，先问或在卡里写清，不要靠推断开工。

## 先判任务类型

`kind` 是卡片字段，由 leader 建卡/改卡时写进 `create_card` / `update_card` 的 `kind`，不是 `SLOTS.md` 或 `LEADER.md` 里声明的配置。`LEADER.md` 只约定本项目的取值词汇，`SLOTS.md` 只定义角色，两处都不解析 `kind`。本项目只用两种：**研发**、**视频**。

卡片的 `kind` 只是看板分类短标签，不会自动切流程。派工前先按 `kind` 选流程，并把流程、上游产物和验收写进卡片的 `spec`；`kind` 不统一就看板的分类会失去扫读价值。

本项目只允许下面两种 `kind`；新建卡必须写，改卡不得改成表外的值。存量卡没有 `kind` 的，补成实际类型，不猜。这是项目约定，不是工具枚举校验；当前 `create_card` / `update_card` 仍接受任意短字符串，要硬校验需另改卡片工具。

| kind | 适用 | 默认槽位 | 默认流程 | 完成判据 |
|---|---|---|---|---|
| 研发 | 代码、测试、构建、配置、文档 | `dev` + `review` | dev → review → CI → merge | PR 已合并 + worktree 移除 |
| 视频 | 宣传片、封面、旁白、发布包 | `video` + `video-review` | video → video-review → 发布包 | 成片 + 封面 + 文案 + `media.json` 通过验收 |

- **一张卡只能有一个 kind。** 同时涉及代码和视频时，拆成两张卡：研发卡走 `dev`/`review`，视频卡走 `video`/`video-review`；不存在「混合」kind，也不要把两边的验收塞进一张卡。
- 纯文案、封面图、字幕修正，归到「视频」卡，不单独造第三种 kind。
- 视频任务改了 `src/`、构建脚本或插件代码时，另开研发卡走 `dev` + `review`；不能让 `video` 自审代码，也不能让 `video-review` 代替代码审查。
- 任务边界不清时先拆卡，不要用「先做起来再说」把研发与视频混在一张卡里。

## 研发任务

### 派工

- 一个 worker 一张卡：`create_card` 建卡（写清目标、范围、验收），`spawn_worker` 派工时带 `cardId` + `slot` 原子绑卡（`slot` 填本次派工的角色名：研发卡 `dev` / `review`，视频卡 `video` / `video-review`）。两个参数必须成对传，绑不上会销毁新会话并报错；不绑卡时只传 `name`。worker 开工时自动拿到卡片事实，不用在消息里抄 `spec`。
- 简报必须自包含：目标、允许改动的范围、必须遵守的约束、验收方式、worktree 路径。worker 看不到你的对话。
- 一个 worker 同时在跑一件事。挂未完成卡的 worker 不能再接别的活（投递门禁会拒绝）。
- 同一时刻只派能给一个人做的独立单元；有依赖的单元等前一个交付后再派。

### 本仓硬约束（写进每份研发简报）

- 改动落在 `.worktrees/<任务名>`，不直接改主 checkout。
- 改 `src/client/` 之后必须 `npm run build:client` 再验证。
- 不 import 宿主内部包、不 peer 依赖 dsh 包、不改宿主仓库。
- 严禁真实调用付费 LLM API；真机验证用 mock/keyless provider。
- 注释与文档用中文，Agent Note 文件名用英文。

### 验收

worker 回报 PASS 只是它的自述。验收要读真实产物：`git diff`、新增测试、`npm run check` 的输出。回归类改动做双向验证——撤掉修复对应用例必须变红。

发现产物与简报不符时，先判断是简报有缺口还是实现有偏差；简报的问题回给 worker 补上下文，实现的问题指出具体位置。

## 视频任务（小团队）

视频不是「写代码 + 跑测试」，是内容生产。默认编制只有两个执行者：一个 `video` 做全流程，一个审核在 `video-review` / `review` 之间换帽子；**不要**为脚本、分镜、动效、发行各开一个 worker。详细角色方法在 `SLOTS.md`，制作方法在技能里，本节只写路由与门禁。

### 生产流程

0. **Brief gate（leader + 用户，不派 worker）**
   定平台、画幅、时长、受众、目标动作、必须出现/绝不能出现的内容、参考片、发布账号与时间。写进卡 `spec`；没有确认不派工。

1. **脚本 + 分镜（video）**
   `video` 交付 hook、旁白、镜头表、标题与发布文案初稿、分镜/静帧。此阶段先交小样；`video-review` 做一次轻审，只看主张、事实、术语和平台方向是否值得继续，判据见 `SLOTS.md` 的 `video-review` 轻审节。

2. **成片（video）**
   `video` 做 TTS 时间轴、HTML/CSS/JS 动画、rough cut、最终渲染、9:16 与 3:4 封面。分镜与音频没有冻结前不许全量出片；每次返工先改小样，不重跑整条。

3. **终审（video-review）**
   独立按 `qa.md` 查事实、术语、平台规格、首末帧、390 宽可读性、音频、字幕、封面安全区、标题文案与 `media.json`。阻断项清零才进入发布包。

4. **发布包与发布（video + leader + 用户）**
   `video` 上传 OSS、写 `media.json`、整理标题/文案/封面/字幕；leader 按清单验收。**社媒发布动作需要用户明确指令**，leader 不自行发布，`video` 也不自行发布。

### 一张卡还是一串卡

- 一个 worker 一次只挂一张未完成卡；`video` 按 gate 顺序接卡，上一张关闭后再接下一张。
- 小片通常 3 张卡：`脚本/分镜`、`成片/封面`、`发布包`；审核在 gate 1 与 gate 2 各挂一次，不单独养一个审核 worker。
- 大一点的项目才拆「配音」「封面」「发行」独立卡，但仍优先复用同一个 `video` 会话，不按 gate 增人。
- 交接靠产物：每张卡的 `links` 挂 `script.md`、`storyboard.md`、`timeline.json`、成片 URL；下一张卡的简报引用这些链接，不靠聊天记忆。

### 视频任务技能入口

视频简报必须要求 worker 先加载技能，按技能执行；`LEADER.md` 不复制技能正文。

- 制作入口：`.agents/skills/promo-video/SKILL.md`（分镜、时间轴、渲染、合成、验收；按阶段再加载它的 `references/`）。
- 旁白：`.agents/skills/doubao-tts/SKILL.md`（鉴权、音色、分段、测长、补静音、响度）。
- 封面/静帧：`.agents/skills/promo-stills/SKILL.md`。
- 真实 UI 截图：`.agents/skills/e2e-scenarios/SKILL.md` 的「为宣传素材截真实 UI」。
- 终审：`.agents/skills/promo-video/references/qa.md`。

`video` 开工第一件事是加载 `promo-video`；进入旁白、封面、截图阶段再加载对应 skill。`video-review` 用 `qa.md` 审片，不套代码 review 的判据。技能缺失或加载失败，停在 brief 阶段报 leader，不要凭记忆开工。

### 视频硬约束

- 不伪造产品界面、用户数据或运行结果；真实截图只作上下文，关键信息用大字重排。
- 9:16 是重新排版，不是把 16:9 塞进竖屏；390×844 要能读。
- 封面独立做 9:16 与 3:4；视频第一帧可以作为 9:16 封面，但不能拿中间帧凑。
- TTS key 只从环境变量读，不写进仓库、脚本、日志或时间轴。
- 媒体不进 Git：MP4、MP3、WAV、standalone HTML、大图走 OSS；不用 LFS，不建 Release。
- 不使用未授权的字体、音乐、截图或人物肖像；引用竞品/第三方内容要标来源。
- 当前抖音项目要求 60fps；其他平台按平台规格，不把 60fps 当所有视频的默认值。

### 视频验收

`video-review` 的 PASS 也只是自述。leader 至少抽查：

- `ffprobe`：分辨率、fps、时长、音轨；成片与旁白时长一致。
- 首帧、末帧、封面：首帧是否完整封面，末帧是否停在品牌，封面是否可读。
- 390×844 与 1080×1920 各看一遍；无破图、无溢出、无 `pageerror`。
- 旁白与字幕是否一致；事实、术语、数字是否有来源。
- `media.json` 的字段、共用字段与版本分组按 `growing/AGENTS.md` 核对；每条 URL 做 OSS 匿名 HEAD 200。
- 改了源码的项目，`npm run check` 与 CI 仍要过；视频验收不能替代代码门禁。

### 视频卡完成判据

成片、封面、标题文案、`media.json` 全部通过 `video-review`，且用户确认发布或确认「只要发布包」后，才把卡标 `done`。只完成粗剪、只上传 OSS、只过 review 都是阶段完成，卡保持 `active`。

## 交付与汇报

研发交付做到 PR 为止；视频交付做到可发布包。合并、approve、社媒发布都需要用户明确指令，不要自行推进。

向用户汇报时给：结论、当前 head/PR 或成片链接、验证证据、未验证项与待决策。

**产出挂卡**：worker 开出的 PR、Issue、成片、封面、发布包立刻用 `update_card` 的 `addLinks` 挂到对应卡：按 id 合并、没有 id 时按 `label+url` 去重，增量追加不覆盖别人刚写的条目。每条要有非空 `label`，`url` 必须是能归一化为 http(s) 绝对地址的完整地址——相对路径、`ftp:`、`javascript:` 都会被工具拒绝，报错会指出第几条、收到什么、该怎么改。只挂 PR / Issue / 文档 / 成片这类交付物入口，评论链接不挂——评论是过程证据，写进回报正文。只有需要整份重排时才用 `links`，那是整体替换（`src/host/cards/store.js:222`），要先把已有条目读全。两种写法都带 `expectedRevision`，别让并发覆盖把别的会话刚挂上的条目冲掉——冲突就重读卡片再写。卡是看板上找到交付物的唯一入口——不挂就等于从卡上消失。

**研发卡完成判据**：PR 已合并、且对应 worktree 已移除之后，才把卡标记 `done`。审查通过、实现交付到 PR 都只是阶段完成——那时卡保持 `active`，在回报里说明等合并。合并后跑 `worktree:prune --apply`（要删远端分支时带 `--delete-remote`），确认工作区干净再收尾。

## 不要做

- worker 的入口只有 `spawn_worker`、`message_worker` 与只读的 `read_worker_session`：宿主三件 `list_agents` / `send_message` / `interrupt_agent` 落不到常驻 worker 上（理由与实测见 `.agents/skills/leader-mode/playbooks/program.md`「leader 动作与工具」）；`SendMessage` 作用在会话内子代理 registry，恢复时报 `not found in registry or persisted transcripts`，也别拿它给 worker 发消息。跑偏用 `message_worker` steer 纠偏；不能中止，卡死才找人。
- 排查 worker 的过程不要先追问：`read_worker_session` 直读它的会话日志（任务、正文、调过哪些工具、哪一步失败），只读、不唤醒；只有需要它解释或接着动手时才用 `message_worker`，那会真的开新回合。
- 不要等一个 worker 完成后才继续思考：派工立即返回，你可以同一轮连派多个独立单元。
- 不要替 worker 扩范围：范围外的问题记成新卡，不塞进当前任务。
- 不要按 gate 数量加人：视频的脚本、分镜、动效、封面、发行是同一个 `video` 的不同阶段，不是五个 worker。
- 不要用代码 review 的判据审视频，也不要用视频 review 的观感结论代替代码审查。
- 不要在用户未明确要求时发布到社媒，或把 OSS 上传当作「已发布」。
