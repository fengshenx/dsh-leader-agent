<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/fengshenx/dsh-leader-agent/main/docs/assets/readme/logo-zh-dark.svg">
    <img src="https://raw.githubusercontent.com/fengshenx/dsh-leader-agent/main/docs/assets/readme/logo-zh.svg" alt="dsh-leader-agent：Leader 节点扇出三条并行执行轨" width="460">
  </picture>
</p>

<p align="center">
  <a href="README_EN.md">English</a> | <strong>简体中文</strong> | <a href="https://fengshenx.github.io/dsh-leader-agent/">官网</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-leader-agent"><img alt="npm 版本" src="https://img.shields.io/npm/v/dsh-leader-agent?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/fengshenx/dsh-leader-agent/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/fengshenx/dsh-leader-agent/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="dsh 版本要求" src="https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2-4b6fff?style=flat-square">
  <img alt="状态" src="https://img.shields.io/badge/status-developer%20preview-7da1de?style=flat-square">
  <a href="https://www.npmjs.com/package/dsh-leader-agent"><img alt="npm 月下载量" src="https://img.shields.io/npm/dm/dsh-leader-agent?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/fengshenx/dsh-leader-agent/stargazers"><img alt="GitHub Stars" src="https://img.shields.io/github/stars/fengshenx/dsh-leader-agent?style=flat-square&color=4b6fff"></a>
</p>

# dsh-leader-agent

> 一个 Leader 帮你推进开发和 Review，解放你的注意力：同时并行开发 10 个 feature，而不是逐个陪跑。
>
> DeepSeek Harness（dsh）的 leader / 执行者编排 bundle。Leader 拆解、派工、盯完成、收产物、组织审查；worker 在后台各自干活、完成自动回报，任务事实落进按项目组织的看板。一人一个 worktree 是本仓的约定，不是 bundle 的硬性要求。

## 亮点

1. **通过一个 Leader，帮你推进开发和 Review** — 你只说一次目标：它拆卡、派工、盯住每个 worker 的完成、验证产物、组织审查。目标规模是一次并行开发 10 个 feature。
2. **一块看得见谁在干活的看板** — 一个项目一块，**工作**列表或**炫酷**线路图两种呈现；卡面是执行者槽位与实时信号灯，点卡看详情，点槽位直接钻进那个 Agent 的会话接着聊。
3. **编排规则写进两份文件** — `LEADER.md` 写 Leader 的 prompt 与本项目的编排规则，`SLOTS.md` 按角色给 worker 写。改文件即改行为，下一次请求生效，不用重建会话。
4. **每个 worker 用合适的模型** — 派工时按任务挑模型与 effort：重活用强模型、查证用快模型；`SLOTS.md` 可按角色写默认，`message_worker` 续聊时也能换，派工前用 `list_worker_models` 查可选 route。
5. **多项目并行，每个项目一个 Leader** — 加项目即绑定一个 leader 会话并列出它派出的 worker；删项目只删记录、保留文件夹与会话；换 Leader 时原班 worker 与未投递的回报一并改投。
6. **给 Leader 的编排 Skill，不是一句人设** — `leader-mode` 按讨论 → 设计 → 实现交付 → 审查 → 合入分阶段给 playbook，另有并行协作与交接规范。
7. **卡住的任务会浮出来，不会无限等** — worker 超过 15 分钟没有回报时，会触发一条带「【后台巡查】」前缀的提醒，附挂着的卡、最后回报与可照抄的回看调用；`read_worker_session` 只读回放它做过什么，不唤醒 worker。

## 安装

### 桌面版安装（DeepSeek Harness Desktop）

桌面版用独立 profile（`$DSH_HOME/profiles/desktop`），与上面的 `web` 互不相通：插件要在对应 profile 里分别安装，装好后两侧功能一致（含看板与项目树）；会话、项目与卡片数据共享。

**图形界面安装**：左侧 SidePanel 打开「插件」，点右上角「添加插件」，在包名框填 `dsh-leader-agent` 后点「安装」：

<img src="https://raw.githubusercontent.com/fengshenx/dsh-leader-agent/main/docs/assets/readme/desktop-add-plugin.png" alt="Add plugin 向导：输入 dsh-leader-agent" width="880">

**命令行安装**：系统 `dsh` 拒绝管理 desktop profile，要用桌面安装自带的 CLI：

```sh
# 先完全退出应用（关窗口只是隐藏）
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add dsh-leader-agent
```

Windows / Linux 换成安装目录里对应的 `runtime/cli/bin/dsh`。应用只在启动时读 profile，同一时刻只能挂一个版本；`DSH_HOME` 要用绝对路径或 `~/` 写法。会话、项目与卡片数据与 `web` 共享，插件包与激活状态各自一份。

`npm run desktop` 用 dev 根 `.dev/desktop-home`；`npm run desktop:prod` 用正式数据（影子根 `.dev/desktop-prod-home`，共用日常，线上 profile 不动）。都用本仓代码，直接启动仍用线上；`-- --remove` 清根，旧版用 `-- --remove --remove-mount` 摘。

### Web 版安装

从 npm 安装（包名 `dsh-leader-agent`）：

```sh
dsh plugin --profile web add dsh-leader-agent
dsh web
```

profile 名必须用 `web`；自定义名不在 `PROFILE_TEMPLATES` 里，装出来缺 web-app bundle，客户端半边不加载。需要 dsh `>=0.2.1-rc.2 <0.3.0`。

指定版本、卸载、开发期安装与不装 profile 直接试跑见[开发](docs/development.md)。

## 预览

<div align="center">
  <img src="https://raw.githubusercontent.com/fengshenx/dsh-leader-agent/main/docs/assets/readme/board.png" alt="工作模式：左栏项目树、中栏 Leader 的会话、右栏列表形态的交付看板" width="1200">
</div>

**工作模式（默认）**：纯列表，一卡一件事，槽位 chip 标出执行者。左栏项目树、中栏 Leader 会话、右栏看板；点执行者即可下钻到它的会话。

<div align="center">
  <img src="https://raw.githubusercontent.com/fengshenx/dsh-leader-agent/ab19c6307736fc21675bbac2847dd9bce3bf7a81/docs/assets/readme/board-cinema.png" alt="炫酷模式（深色主题）：交付看板画成线路图，卡片挂在主干上，执行者支线按运行状态点亮" width="1200">
</div>

**炫酷模式**：同一块看板画成线路图——卡片挂主干，执行者是右侧支线，只有执行中的支线跑光点。纯演示，社交媒体传播用。图为深色主题；浅色宿主下是电蓝正交线条。

在 **设置 → Leader Agent → 任务看板** 切换，选择只存本实例；工作模式截图取自真实会话，炫酷模式取自 e2e 夹具（真实宿主 + 本地 mock）。

## 它是怎么跑起来的

```text
你 ──────▶ Leader（leader 会话，项目的唯一指挥）
             │  create_card     记下要做什么、验收是什么
             │  spawn_worker    建 worker 会话，立即返回
             │  message_worker  投第一条消息——开工的是它
             ▼
      worker ─ worker ─ worker        各自在自己的项目目录里后台并行
             │                        （一人一个 worktree 是项目约定，见「前提」）
             │  turn 结束由机制侧结算（worker 不用调工具交作业）
             ▼
      Leader 被唤醒 ──▶ 看板信号灯更新 ──▶ 你打开任一 worker 接着聊
```

这些行为由机制保证，不靠提示词：

- **身份决定工具面**：Leader 拿得到 `spawn_worker` / `message_worker`，worker 拿不到；工具面在会话创建时由宿主裁剪，不是靠提示词约束模型。
- **完成由机制结算并自动唤醒**：worker 那一轮结束时，Leader 自动收到一条回报（渲染成 worker 的发言气泡），不轮询、不靠 worker 自觉。
- **worker 是常驻根会话**：能同时跑多个，人可以直接打开它的会话接着聊，进程重启后能冷恢复。代价是 Leader 侧不能强杀它，见[当前限制](#当前限制)。
- **项目会话有标签栏**：第一个标签是项目名（Leader 入口），点开的 worker 带着状态灯加入；栏右端是会话「更多」与右栏开关。关标签只丢快捷方式，会话仍在项目树里。

## 设计取舍

- 这个项目不复刻 [DeepSeek Harness 团队的 Super-agent 研究原型](https://github.com/deepseek-ai/dsh-superagent-prototype)（研究原型，不是 DeepSeek 官方产品；它盯一个仓库、按事件起会话），要解决的是另一件事：让 1 个人管理 20 个以上的 Session，有 Leader、看板和并行任务（[项目落地页 FAQ](https://fengshenx.github.io/dsh-leader-agent/#faq)）。
- 当前 agent 还不能无人值守，所以你可以随时打开 worker 的会话，直接看它的消息流：做到哪、卡在哪，再决定打断或推进。
- routing 层用的是完整大模型，实际使用中，routing 层由于知道全局信息，经常能够把多个 PR 串起来思考，解决单 Worker 看不到的问题。
- Agent 编排的泛化。Card 是任务本身的描述，可以用在非编码场景，也可以和各种 Skill 集成。
- 项目还缺少一些初始化机制，实际使用时你需要在你的项目内初始化 `LEADER.md`（Leader 的人设 Prompt 以及编排流）和 `SLOTS.md`（任务的角色分工以及对应的人设 Prompt）。
- 项目设计成了 Leader 领导 Worker，Worker 之间绝不通信（Tool Use 层就杜绝了），因为当前的 Agent 被训练成了强指令遵循，两个 Agent 对话一旦出现一个错误的噪音，会把整个对话带偏。

## 快速开始

最短路径：加项目 → 加载 `leader-mode` → 派工 → 记卡 → 看看板。完整走一遍见[上手](docs/getting-started.md)，每个动作见[使用手册](docs/usage.md)。

1. **加项目**：左栏「项目」点「加项目」选目录；项目当场建好并绑定 Leader，项目行就是入口。详见[项目](docs/usage.md#加项目)与[上手](docs/getting-started.md#二加一个项目就得到一个-leader)。
2. **加载协议**：在 Leader 会话里加载 `leader-mode`，先读 `playbooks/program.md`，再按阶段读对应 playbook。
3. **派工**：`spawn_worker` 建 worker（可带 `cardId` + `slot`、`model` / `effort`），`message_worker` 投第一条消息才开工；之后再用就是纠偏或续聊。worker 继承 Leader 的沙箱与审批策略，回执报实际权限；用 `read_worker_session` 回看、`list_workers` 盘点。详见[派工](docs/usage.md#派工)与[worker 控制面](docs/limitations.md#worker-的控制面)。
4. **记任务事实**：`create_card` / `update_card` / `list_cards` 管卡；改内容带 `expectedRevision`；链接只挂交付物入口，用 `links` / `addLinks`。worker 只能改自己挂着的卡的链接；`read_card` 找回任务，长规格用 `specOffset` 分页。详见[卡片](docs/usage.md#卡片)。
5. **看看板**：右栏「看板」Tab 按当前项目拉卡，Leader 建卡后自动打开；点卡面看详情，点槽位 chip 进执行者会话。详见[看板](docs/usage.md#看板)。

`LEADER.md` 与 `SLOTS.md` 是项目手册，`leader-mode` 是协议，目标项目的 `AGENTS.md` 仍由宿主作为共享工程约定读取；三者都不授予工具权限。见[项目提示词](docs/usage.md#项目提示词)、[上手](docs/getting-started.md#三两份文件leader-的人设worker-的工作方法)与 `init-leader-agent` skill。

## 前提：多 worktree 隔离

每个任务一个 worktree、一个独立 dsh 实例与数据根；否则并行任务会互相覆盖插件版本、争抢会话与数据。详见[开发](docs/development.md)与[架构](docs/architecture.md#项目与会话归属)。

## 当前限制

- **后台编排需要长驻宿主**（web / desktop / sdk）：headless 是一次性 CLI，没有载体接收回报。
- **Leader 能纠偏、不能中止 worker**：宿主的 subagent 工具对 worker 无效；真卡死只能请人进它的会话处理。
- **回报依赖轮次正常结束**：进程在 worker 跑完前被杀，那一轮不结算。
- **看板与项目树只对项目会话展示**；标签栏是 DOM 注入，状态按项目存在浏览器 localStorage。
- **卡片详情只能改链接或删卡**；其它卡片修改仍归 Leader 的工具。
- **项目注册表只经左栏操作**，项目会话与官方工作区树并存。
- **客户端与宿主版本耦合。**

完整限制清单见[已知限制](docs/limitations.md)。

## 开发

```sh
npm run worktree:spawn <任务名>   # 建 worktree + feature 分支
cd .worktrees/<任务名>
npm run dev                       # 起挂当前工作树的 dsh 实例
npm run check                     # 全量门禁
npm run e2e                       # 浏览器 e2e
```

数据根、实例覆盖项、构建契约与测试口径见[开发](docs/development.md)；常用命令见 [AGENTS.md](AGENTS.md#常用命令)。`npm start` 起日常实例。

## 贡献

改代码前先读 [AGENTS.md](AGENTS.md)：worktree 纪律、验证要求与文档机制都在那里。最短路径是 `npm install` → `npm run check` → 开 PR；提交信息用中文，非平凡改动同 PR 带 `.agents/notes/` 决策笔记。

## 文档

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 仓库铁律与按任务查阅入口 |
| [docs/getting-started.md](docs/getting-started.md) | 上手路线：使用前提、加项目与 Leader、两份项目文件、一张卡从创建到下钻 |
| [docs/usage.md](docs/usage.md) | 使用手册：项目、派工、卡片、看板、槽位与手册 |
| [docs/architecture.md](docs/architecture.md) | 分层、运行时模型、数据流、持久化布局、宿主契约落点 |
| [docs/limitations.md](docs/limitations.md) | 已知限制清单 |
| [docs/development.md](docs/development.md) | 开发环境、实例、构建契约与测试口径 |
| [docs/capability-gaps.md](docs/capability-gaps.md) | 宿主能力边界的实测依据（改宿主侧前先读） |
| [docs/e2e-testing.md](docs/e2e-testing.md) | 浏览器 e2e 车道（命令、夹具、mock 约定、截图）与人工取证规范；断言纪律与失败诊断见 `.agents/skills/e2e-scenarios/` |
| [growing/](growing/) | 增长资产索引：案例、文案、源文件；媒体在 OSS |
| [.agents/notes/](.agents/notes/) | 非平凡改动的决策记忆 |
| [.agents/skills/leader-mode/](.agents/skills/leader-mode/) | 协议层：派工、接力、事件调度、卡片维护、验收裁决 |
| [.agents/skills/promo-video/](.agents/skills/promo-video/) | 宣传片流水线（需本仓开发环境：Playwright + ffmpeg）：分镜、旁白时间轴、录制与封面制作；旁白见 `doubao-tts/`，封面见 `promo-stills/` |

## 致谢

本方案在设计时参考过 **Cursor 的 Project 实现**与 **PStack 的编排机制**：把项目当成一等实体、按项目聚合会话与交付物，以及「leader 派工 / 执行者回报 / 交付看板」这条主线。

会话标签栏参考了 [dsh-session-tabs](https://github.com/QIN-SMART/dsh-session-tabs)（MIT）的主面板定位与标签持久化实现；完整第三方清单见 [THIRD_PARTY_LICENSE](THIRD_PARTY_LICENSE)。

也感谢 **DeepSeek Harness 团队**：宿主的插件契约，以及 worktree 并发、Agent Note、AGENTS.md 渐进式披露、文档防腐化这套工程实践，是本仓直接对照的来源。

## 许可证

[MIT](LICENSE)

第三方许可：[THIRD_PARTY_LICENSE](THIRD_PARTY_LICENSE)。
