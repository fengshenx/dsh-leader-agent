# dsh-leader-agent 架构

本文是 dsh-leader-agent 的架构地图：分层、运行时模型、数据流、持久化布局、宿主契约落点。它只回答「系统由什么组成、接缝在哪里、改一块会牵动谁」；安装与入门见 [README](../README.md)（[中文](../README_ZH.md)），每个动作的完整交互见[使用手册](usage.md)，限制与取舍见[已知限制](limitations.md)，宿主能力边界的实测依据见 [capability-gaps.md](capability-gaps.md)，决策推演见 [.agents/notes/](../.agents/notes/)，开发环境与构建契约见[开发](development.md)。

阅读顺序：先看[分层](#分层)与[运行时模型](#运行时模型)，再看自己要改的那一块；跨模块改动前读[宿主契约与架构约束](#宿主契约与架构约束)。

## 分层

bundle 只贡献一层插件配置（`cordis.patch.yml`），实现分四处，横跨两个进程：

| 层 | 位置 | 运行位置 | 职责 |
|---|---|---|---|
| 宿主侧 | `src/host/` | Node 进程 | 工具、派工、会话生命周期、卡片与项目存储、项目通道、提示词注入 |
| 客户端 | `src/client/` | 浏览器进程 | 左栏项目区块、项目树、右栏看板、worker 回报气泡、弹窗与提示条 |
| 共用 | `src/shared/` | 两端 | 纯函数与消息来源约定（frontmatter 解析、项目共享规则、回报 source kind） |
| 协议层 | `.agents/skills/` | 模型上下文 | `leader-mode` 派工协议与 `init-leader-agent` 初始化方法 |

两端不共处一个进程：宿主侧拿不到 client 服务，客户端没有文件系统，项目与卡片的真源都在宿主侧，浏览器侧经 Typert 远程通道读写。

**零运行时依赖的边界**：宿主侧只用 Node 内置模块与 Cordis 注入的 `ctx`，不 peer 依赖任何 dsh 内部包——宿主解析失败会让整个 bundle 加载失败。运行时唯一依赖 `minidenticons`（worker 头像），只用于客户端产物。

**插件行必须是纯包名**：`cordis.patch.yml` 的插件行写成 `dsh-leader-agent/src/host` 这类子路径时，浏览器侧定位不到包 manifest，宿主便不下发 client bundle。

## 运行时模型

### 三种会话身份

| 身份 | 判定 | 工具面 |
|---|---|---|
| leader | 项目注册表 `leaderSessionId` 指向的会话 | 全部工具，但摘掉 `list_agents` / `send_message` / `interrupt_agent` |
| worker | 本 bundle 派出的根会话，登记表 + 内存集合判定 | 没有 `spawn_worker` / `message_worker` / `list_cards` / `create_card`；保留 `update_card`（限自己挂着的卡，不能改状态、规格、标题与槽位） |
| 普通会话 | 其余会话 | 与 worker 相同，再少掉 `create_card` / `update_card`；保留宿主 subagent 三件工具 |

身份决定工具面，工具面在会话创建时裁剪（见[工具面分配](#工具面分配)），不是靠提示词隐藏。

### 派工与唤醒

worker 是本 bundle 用 `ctx.agents.create` 建的**普通根会话**，不走宿主 subagent 机制：生命周期由本 bundle 持有的 `AgentHandle` 决定，人可以直接打开它说话；会话各有一份独立 JSONL，进程重启后由 `agents.resume()` 冷恢复。宿主的 subagent 换不来这件事——结算即销毁、界面只读。

建 worker 与冷恢复都要显式把 `agentPresets.mount()` 交给 `setup` 并把 preset id 写进 `meta.agentPreset`，否则只剩全局工具（[capability-gaps 第 38 条](capability-gaps.md)）。挂上的是整个标准组合（persona、`agent-instructions`、time-context、`subagent` / `workflow`、`ask_user_question`、`todo`、`web`…），因此 worker 也能向用户提问。worker 的沙箱模式与审批策略在派工时从 leader 继承，回执写回读到的实际权限（[capability-gaps 第 41 条](capability-gaps.md)、[限制](limitations.md#worker-的控制面)）。

派工分两步：`spawn_worker` 建会话、登记、可选绑卡槽位后**立即返回且不开工**；开工由 `message_worker` 的第一条消息触发。这样槽位绑定与卡片事实先落盘，首轮请求就带着它们。`message_worker` 既是开工入口也是续聊入口：会话活着就把消息 `steer` 进它的当前轮次（下一步注入，空闲则立即开一轮），进程重启后先冷恢复再投；回执按会话在不在内存分 `merged` / `sent`，可选 `rename` 改名。

完成信号由机制侧从会话事件里认：`dispatch.js` 订阅宿主的 `session/event`，在 `turn/end` 折叠这一轮的 `assistant/message` 文本与终态——worker 不调用任何工具回报，模型漏写一句话不会让 leader 卡在等待里。唤醒走 `agent.followup()`，补上 dsh 原生缺失的「worker 结束 → leader 自动被唤醒」。通知有两条硬边界：排进 `inbox['next-turn']`（下一个 turn 的一次输入，不插进当前这一步）且父会话空闲才投；为什么这样定、代价是什么见[限制](limitations.md#宿主语义与运行形态)。人下钻到 worker 会话直接对话不经过这条路径：那种轮次不登记在飞记录，不结算。

### 工具面分配

工具面按角色在**会话创建时**裁剪，落在 `agent/created` 上：

- leader 拿到全部工具，但没有 `list_agents` / `send_message` / `interrupt_agent`——它们对 worker 无效，从工具面直接摘掉，模型就不会照描述去用一个拿不到效果的东西；
- 普通会话与 worker 都没有 `spawn_worker` / `message_worker` / `list_cards`——没进项目语境，看不到项目里有哪些卡，也不该派工；
- `create_card` 只给 leader：建卡与派工是 leader 的一条动作链（建卡 → `spawn_worker` 带卡槽位 → 投递），`SLOTS.md` 的各槽位没有让执行者建卡的步骤；worker 攒下的待办由它回报、leader 建卡（普通会话为什么一并收掉见[已知限制](limitations.md#看板与卡片)）。
- `update_card` 给 leader 与 worker：worker 边干活边把产物链接与进展写回**自己挂着的卡**，普通会话没有。工具面在会话创建时一次裁完，换 leader 不重建旧会话，所以每次写入按当前身份再判一次（`src/host/tools/cards.js` 的 `assertCardWriter`，判定在 `tools/gate.js` 的 `canWriteCardsFor`，索引未就绪时问不出身份就拒绝）。worker 另有范围闸：只能改自己挂着的卡，不能改 `slots` / `status` / `spec` / `title`——完成、重开与换执行者归 leader，规格与标题是验收锚点，进展与产物走回报与 `links`；`create_card` 同样在执行时再判一次，worker 建卡两面都关。退役者的写卡边界见[已知限制](limitations.md#看板与卡片)，推演见[决策笔记](../.agents/notes/implemented/simplification/2026-11-02-card-write-tools-scope.md)。

实现在 `src/host/tools/gate.js`，用宿主的 `tools.restrict({ deny })`，对 `agent.ctx` 调一次；已发布版本里 `tools.register()` 不接受按步条件，所以只能在会话创建时做。leader 身份来自项目注册表——**索引重建完成前不裁**，此时问不出谁是 leader，而少给工具会让 leader 首轮干不成活。

### agent-team 并存时

宿主加载 `@deepseek-ai/dsh-experimental-agent-team-profile` 后，`agentTeams` 服务存在，`tool-agent-team` 会给每个普通根会话装团队工具（`agent-team/src/roster.ts` 的 `tryMembership`：无 `parentSession`、无 subagent descriptor 的 root 都算 lead）。本 bundle 的 worker 正是普通根会话，于是被当成隐式 Lead；leader 也同时看到两套派工工具。

工具面挡不住它们：团队工具注册在 Agent scope，而 `tools.restrict({ deny })` 只接受全局工具名（宿主 `packages/core/tools/src/index.ts` 的 `restrictableNames`），`tool-subagent*` 的全局注册又被 agent-team-profile 禁用了。所以本 bundle 只做两件事——第一次会话创建时告警一次，以及给 leader 与 worker 注入运行时上下文（`dsh-leader-agent:team-ban`，order 106），按各自工具面分开写禁令；普通会话不注入，它们可能真的在用 teammate。要彻底隔离只能从 profile 移除那个 package。

## 项目与会话归属

项目是**显式注册的实体，不是目录**。一条项目记录有名字、目录，并绑定一个 leader 会话（`projects.json` 的 `leaderSessionId`）。它与 dsh 的「工作区」不是同一层语义：工作区管代码语境（目录 + 会话归组），项目管编排语境（leader / 卡 / worker / 手册），同一个目录可以挂多个项目，两者不合并（见[项目作用域与角色槽位](../.agents/notes/implemented/architecture/2026-10-23-project-scope-and-role-slots.md)）。

服务层语义：

- **建项目 = 建实体 + 建 leader 会话 + 绑定**，两步一体；任一步失败整体回滚，不留半条记录。
- **目录不可改**：目录是项目身份的一部分，改目录等于换项目。
- **会话归属按 realpath**：会话头没有项目字段，`session-index.js` 按 cwd 与项目目录的 realpath 精确相等归到项目；两个项目指向同一目录时先注册的归属。项目树的名单在它之上再并两类：worker 看登记表，退役 leader 看 `retiredLeaderSessionIds`。
- **项目不碰 dsh 工作区**：既不注册工作区，也不把 leader / worker 挂进去，删项目不动任何工作区。项目会话因此落在官方树的「未分组」里，由渲染层排除（见[限制](limitations.md#项目树与工作区)）；旧版本挂进去的历史会话在启动时一次性摘掉（`detachFromWorkspaces`）：只处理**目录等于某个项目目录**的工作区，并按目录配对——那个工作区里只摘该项目自己的 leader / 退役 leader 加上登记的 worker（worker 认不出归属，按全局摘），用户拖到别处的会话与别项目拖进来的会话都不碰；`detachSession` 幂等，重跑是零写盘空操作。
- **leader 换人**：原班 worker 的派工归属与未投递的完成回报一并改投新 leader（派工记录留 `reassignedFrom`），退役会话降级为项目里的普通会话，`spawn_worker` / `message_worker` / 跨项目 `list_cards` / `create_card` / `update_card` 在调用时按当前身份判定并拒绝。

项目注册表**只经左栏项目区块操作**（模型侧的工具缺口与目录校验的后果见[限制](limitations.md#项目树与工作区)）；打开与换 leader 前先过 `assertUsableDirectory`。

## 卡片与看板

卡片落盘在 `$DSH_HOME/dsh-leader-agent/cards.json`：编号全局递增、不复用，`revision` 做乐观并发，归档是终态，**项目归属由宿主判定**（`create_card` 时按调用方会话反查项目写 `projectId`，模型不传项目参数）。`list_cards` 默认只列本项目，`scope=all` 才跨项目；有归属的卡只能被本项目会话改。

看板是**项目的看板**：一个项目一个看板，跨会话聚合，leader 与 worker 建的卡在同一处。数据源是宿主的卡片库（经项目远程通道读取），不是会话事件流——事件流是会话维度的，一个项目的卡散在多个会话里，重放既慢又会漏。卡片仍随 `tool/result` 事件的 `meta` 投影进 session log（历史完整），但那是历史，不是看板的数据源。

看板只对**项目会话**（leader 与该项目派出的 worker）展示。leader 建卡后右栏自动打开（或聚焦）看板 tab，只有出现新卡才打断。卡面信号灯七档由槽位会话状态实时投影，不落盘。

## 客户端注入面

dsh 的客户端没有「第三方并列区块」这类扩展点，本 bundle 的呈现面都是在既有槽位、DOM 与远程通道上拼出来的：

| 呈现面 | 做法 |
|---|---|
| 左栏项目区块 | 在「面板列表 nav」之后 DOM 注入容器，用 portal 渲染；布局取位「自动化任务之下、工作区之上」，找不到锚点时退回原槽 |
| 项目树 | 自建树，列出该项目派出的 worker 与退役 leader；行形态与活动提示（宿主 `StateDot`）复刻官方工作区行，但行首图标用宿主 `apps-add-outline`（三格 + 一个加号），不用官方目录字形 |
| 官方树排除 | 渲染层按 `data-row-key="session:<id>"` 给 leader 与 worker 行加隐藏类；数据层不动，因此官方计数与搜索仍包含它们 |
| 会话水位折叠 | 复刻宿主工作区树口径：默认 5 条，每次加 5 条；运行中会话抬高水位；只升不降，收起回基线 |
| leader 会话形态 | 注册第三方会话视图目标并激活，外壳切到 active 形态（输入框停靠、无欢迎页）；不产生模型调用 |
| leader 引导卡 | `conversation.input.dock` 上的独立条目（与视图入口同槽），会话快照 `blank` 且未关闭时画出一行上手说明（与输入框同宽同圆角）；「了解怎么用」经宿主 `inputActions` 发一条消息：先讲协作方式，再问是否初始化 `LEADER.md` 与 `SLOTS.md`（确认前不写文件）；关闭标记存 localStorage |
| worker 回报气泡 | 独立 Chat node kind + exclusive claim，左侧气泡、头像、名字可下钻；只渲染最后一次回报 |
| 看板 tab 与入口 | 右栏 tab 类型静态注册；「开始」页入口接管自己那枚胶囊的渲染，只在项目会话里画出来 |
| 浮层与提示条 | 弹窗外壳（`modal-shell.js`）与菜单复刻官方源码改写；一次性消息走宿主的 `shell.overlay` 槽位，4 秒淡出 |

## 持久化布局

运行时数据根是 `$DSH_HOME`（开发实例在 `.dev/home`），按宿主 `dsh-home-paths` 的口径解析（`~` 展开、相对路径 `resolve`、空白按未设，见 `src/host/home-paths.js`）。本 bundle 的数据全在 `dsh-leader-agent/` 下：

| 文件 | 内容 |
|---|---|
| `projects.json` | 项目注册表：名字、目录、leader 会话、退役 leader 会话列表；数组顺序即左栏显示顺序（拖拽改，见[笔记](../.agents/notes/implemented/feature/2026-11-02-project-row-drag-order.md)） |
| `cards.json` | 任务卡片：编号、状态、说明、链接、槽位、项目归属、revision |
| `workers.json` | worker 登记表：会话 id → 父会话与名字，续聊跨进程找回归属 |
| `notifications.json` | 完成通知落盘队列：投递失败留队，父会话重开时补投 |

会话本体是宿主的 JSONL（`$DSH_HOME/sessions/`），不在本 bundle 手里。仓外插件不能新增 session event 类型（[capability-gaps 第 8 条](capability-gaps.md)），卡片与通知状态因此走独立存储域 + session projection。

## 项目级提示词与协议层

| 来源 | 注入对象 | 生效时机 |
|---|---|---|
| `.agents/skills/leader-mode/` | 模型可发现并加载的协议层 | 模型调用 `skill` 工具时 |
| `.agents/skills/init-leader-agent/` | 项目初始化方法（`AGENTS.md` + `LEADER.md` + `SLOTS.md`） | 模型调用 `skill` 工具时 |
| `LEADER.md` | 该项目的 leader 会话 | 每轮请求求值，读文件内容变化才追加 |
| `SLOTS.md` | 卡片 `slots` 字段绑定的会话 | 每轮请求求值，读文件内容变化才追加 |
| 卡片事实 | 卡片 `slots` 字段绑定的会话 | 每轮请求求值，卡片内容变化才追加 |

这三类注入都走运行时上下文（`systemPrompt.context`）：宿主在每次模型请求前求值 provider，只有渲染文本与上一份快照不同时才作为一条 user 消息追加。因此正文没变的轮次不重复注入，改动在下一个模型请求生效，不需要 watcher。

`LEADER.md`、`SLOTS.md` 与卡片事实都**只贡献提示词文本，不授予工具权限**。`LEADER.md` 按身份注入（项目注册表指针），不需要卡片绑定；`SLOTS.md` 与卡片事实按卡片绑定注入。`LEADER.md` 读失败或正文为空时注入空串，不阻断会话；文件缺失（含只有空白）时改为注入初始化提示：告诉模型怎么解释这个 bundle、怎么问用户要不要初始化两份手册，用户确认后才创建文件。配置错误大声告警，且同一问题只报一次。

卡片状态变为 `done` 或 `archived` 时，`cards.store.update` 把 `slots` 一并清空：**关闭卡片即释放执行者**。重新打开不恢复绑定——那是新的指派，要显式再绑一次。投递门禁按绑定卡的 `status === 'active'` 判断；同时挂多张 `active` 卡一律拒绝投递（角色注入只按一张卡算），要把卡先收敛到一张。名册到顶给候选时，挂卡 worker 单列、不当作可复用。

`SLOTS.md` 的槽位名是 ASCII 机器标识（小写字母、数字、下划线、连字符，最长 32 字符），卡片工具与解析器共用同一条规则；frontmatter 的 `slots:` 只声明界面显示名。没写 `SLOTS.md` 的项目回落默认两角色 `dev` / `review`。

协议层随 bundle 分发到包内 `.agents/skills/`（装机后位于 `node_modules/dsh-leader-agent/.agents/skills/`）。这个路径同时是 dsh 的项目级 skill 目录：任何项目在自己的 `.agents/skills/` 放同名副本即可覆盖，项目副本优先——dsh 的 skill 发现按来源层级取优，项目级 rank 200 低于 bundle 的 600。

## 目录职责

| 目录 | 职责 |
|---|---|
| `src/host/` | 工具注册与角色裁剪、派工与结算、worker 会话生命周期与权限继承、卡片与项目存储、项目通道、提示词注入 |
| `src/host/tools/` | 六个工具的实现：`spawn_worker` / `message_worker` / `read_worker_session` / `create_card` / `update_card` / `list_cards` |
| `src/client/` | 左栏项目区块与项目树、右栏看板与卡片详情、worker 回报气泡、浮层与提示条 |
| `src/shared/` | 两端共用的纯函数与线上类型（frontmatter 解析、卡片链接判定、项目通道方法名） |
| `.agents/skills/` | 协议层 `leader-mode` 与项目初始化方法 `init-leader-agent` |
| `build/`、`scripts/` | 客户端构建（原子替换）与开发实例、worktree、门禁脚本 |

单个文件的职责写在文件头注释里——那是权威来源，不在文档里再抄一份。改某块前按 [AGENTS.md 的按任务查阅](../AGENTS.md#按任务查阅)找归属文档。

## 编排动作与工具

| 动作 | 工具 | 来源 |
|---|---|---|
| 派工给后台 worker | `spawn_worker` | 本 bundle |
| 给 worker 续聊 / 改名 | `message_worker` | 本 bundle |
| worker 轮次结束的自动回报 | `session/event` → `turn/end` | 宿主 |
| 读 worker 回报 | 完成通知 | 本 bundle 的唤醒器 |
| 回看 worker 的会话回合（不唤醒） | `read_worker_session` | 本 bundle（读宿主的 `sessionQuery.readSession`） |
| 建卡 / 改卡 / 查卡 | `create_card` / `update_card` / `list_cards` | 本 bundle |

这套接口是为「leader 派活、worker 干活并自动回报」设计的：会话由 `agents.create` 建，生命周期归本 bundle 管，不经 dsh 的 subagent 机制。

## 宿主契约与架构约束

规则速查在 [AGENTS.md 的宿主契约要点](../AGENTS.md#宿主契约要点)，逐条的实测依据在 [capability-gaps.md](capability-gaps.md)。本节只记这些约束落到了哪一层：

| 约束 | 落点 |
|---|---|
| 宿主 API 按下限挑（`>=0.2.1-rc.2 <0.3.0`） | 落在 `agent/created` 上的新 API 最危险：下限版本抛一次 `TypeError` 就是每个会话创建都失败，引入前先查宿主仓库的 tag |
| 不改宿主仓库、不 import 宿主内部包、不 peer 依赖 dsh 包 | 零运行时依赖的边界见[分层](#分层)；理由写在 `src/host/message.js` 头注释 |
| 身份先于会话（[第 37 条](capability-gaps.md)） | `src/host/tools/gate.js` 在 `agent/created` 上按身份 `restrict({ deny })`；leader 身份先写进项目注册表，再建会话 |
| 不能新增 session event 类型（[第 8 条](capability-gaps.md)） | 卡片、通知、项目状态各自独立落盘（`cards/`、`notification-store.js`、`projects/`），会话侧只做 projection |
| client 产物不能用 `node:`、不引 React / jsdom（[第 23 条](capability-gaps.md)） | `src/client/` 只用宿主模块表与 `React.createElement`，产物由 `build/client.mjs`（薄入口）与 `build/client-bundle.mjs`（配置）打 |
| 浏览器侧 → 宿主侧只有 Typert 远程通道 | `src/host/projects/remote.js`：`connection.rpc.handle` 对仓外插件不可用，`/api` 被官方 gateway 占用。代价与版本耦合面见[限制](limitations.md#客户端与宿主耦合) |

## 协作与文档机制

本仓的长期记忆分三层，各管一件事：常驻规则在 `AGENTS.md`（每个任务都适用的铁律与按任务查阅入口），决策记忆在 `.agents/notes/{lifecycle}/{class}/`（非平凡改动的永久决策与边界，取值见[目录 README](../.agents/notes/README.md)），长期文档在 `docs/`（架构、限制、宿主能力边界、开发与取证）。分层规则、编辑纪律与文档预算见 [AGENTS.md 的编辑本文件与文档分层](../AGENTS.md#编辑本文件与文档分层)。
