# dsh-leader-kit 架构

本文是 dsh-leader-kit 的架构文档：分层与模块职责、运行时模型、数据流、持久化布局、宿主契约与取舍。安装与入门见 [README](../README.md)，每个动作的完整交互见[使用手册](usage.md)；宿主能力边界的实测依据见 [capability-gaps.md](capability-gaps.md)；设计决策与实测记录见 [.agents/notes/](../.agents/notes/)。

阅读顺序：先看[分层](#分层)与[运行时模型](#运行时模型)，再看自己要改的那一块；跨模块改动前读[宿主契约与架构约束](#宿主契约与架构约束)。

## 分层

bundle 只贡献一层插件配置（`cordis.patch.yml`），实现分四处，横跨两个进程：

| 层 | 位置 | 运行位置 | 职责 |
|---|---|---|---|
| 宿主侧 | `src/host/` | Node 进程 | 工具、派工、会话生命周期、卡片与项目存储、项目通道、提示词注入 |
| 客户端 | `src/client/` | 浏览器进程 | 左栏项目区块、项目树、右栏看板、worker 回报气泡、弹窗与提示条 |
| 共用 | `src/shared/` | 两端 | 纯函数与消息来源约定（frontmatter 解析、项目共享规则、回报 source kind） |
| 协议层 | `.agents/skills/` | 模型上下文 | `leader-mode` 派工协议与 `init-project` 初始化方法 |

两端不共处一个进程：宿主侧拿不到 client 服务，客户端没有文件系统，项目与卡片的真源都在宿主侧，浏览器侧经 Typert 远程通道读写。

**零运行时依赖的边界**：宿主侧只用 Node 内置模块与 Cordis 注入的 `ctx`，不 peer 依赖任何 dsh 内部包——宿主解析失败会让整个 bundle 加载失败。运行时唯一依赖 `minidenticons`（worker 头像），只用于客户端产物。

**插件行必须是纯包名**：`cordis.patch.yml` 的插件行写成 `dsh-leader-kit/src/host` 这类子路径时，浏览器侧定位不到包 manifest，宿主便不下发 client bundle。

## 运行时模型

### 三种会话身份

| 身份 | 判定 | 工具面 |
|---|---|---|
| 协调者 | 项目注册表 `coordinatorSessionId` 指向的会话 | 全部工具，但摘掉 `list_agents` / `send_message` / `interrupt_agent` |
| worker | 本 bundle 派出的根会话，登记表 + 内存集合判定 | 没有 `spawn_worker` / `message_worker` / `list_cards` |
| 普通会话 | 其余会话 | 与 worker 相同，但保留宿主 subagent 三件工具 |

身份决定工具面，工具面在会话创建时裁剪（见[工具面分配](#工具面分配)），不是靠提示词隐藏。

### worker 是常驻根会话

worker 是本 bundle 用 `ctx.agents.create` 建的**普通根会话**，不走宿主 subagent 机制：

- 生命周期由本 bundle 持有的 `AgentHandle` 决定，不 dispose 就一直活着；
- 会话是普通会话，人可以直接打开、输入新指令；
- 有独立 JSONL，进程重启后由 `agents.resume()` 冷恢复。

宿主的 subagent 换不来这件事：结算即销毁（`settlementState()` 走到 `ready` 就 `close()`），界面上还只读，既不能常驻也不能让人下钻对话。

`agents.create` 不会自己挂 **agent preset**，而内建工具（`bash` / `read` / `write`…）就在 preset 组合里——建 worker 与冷恢复 worker 都要显式把 `agentPresets.mount()` 交给 `setup`，并把 preset id 写进 `meta.agentPreset`（宿主从会话投影读回），漏了就只剩全局工具（[capability-gaps 第 38 条](capability-gaps.md)）。

挂上的是**整个标准组合**，不只一两个工具：persona、`agent-instructions`（会读项目 `AGENTS.md`）、time-context、`subagent` / `workflow`、`ask_user_question`、`todo`、`web` 等一起进来。worker 是常驻后台会话，因此它也能向用户提问。

### 派工与唤醒

`spawn_worker` 建会话后**立即返回**，不等结果：工具返回会话 id，父 turn 正常结束，worker 在后台继续。

完成信号由机制侧从会话事件里认：`dispatch.js` 订阅宿主的 `session/event`，在 `turn/end` 那一刻折叠这一轮的 `assistant/message` 文本与终态。worker 不调用任何工具回报——与宿主 subagent 的 `captureLocalResult()` 同一机制：产出与终态都由机制侧取，模型漏写一句话不会让协调者卡在等待里。

唤醒走 `agent.followup()`（queue a follow-up turn and wake the driver），补上 dsh 原生缺失的一环：「worker 结束 → 协调者自动被唤醒并继续」。

通知走两条硬边界：

1. **next-turn**：通知是「下一个 turn 的一次输入」，排进 `inbox['next-turn']`，不插进协调者当前这一步。
2. **父会话空闲才投**：协调者正忙时先不投，留在落盘队列，检测到空闲再投。否则它会像用户输入一样挂在输入框上方的「消息队列」面板里，把人的消息和后台通知混在一起。

人下钻到 worker 会话直接对话不经过这条路径：那种轮次不登记在飞记录，不结算，协调者不会被打扰。

`message_worker` 是续聊入口：会话活着就直接投（返回 `merged`），进程重启后先冷恢复再投（返回 `sent`）；可选 `rename` 同时改会话标题与登记表。派工要求组合里有 `sessionPersistence` / `sessionQuery`，缺任一就拒绝，而不是悄悄降级成一次性 worker。

### worker 不走宿主的三件 subagent 工具

`list_agents` 只列 subagent 目录里的子会话（worker 是根会话，列表里没有它）；`send_message` 要校验子会话的 `parentSession` 血统（worker 没有，走不通）；`interrupt_agent` 找不到目标时**静默返回成功**——拿它当中止手段会得到一个假回执。worker 的一切交互只经 `spawn_worker` 与 `message_worker`。

dsh 另有一套同名的同伴模型工具（`tool-agent-team`，experimental，base bundle 未启用），按 teammate 名字寻址，与本流程的 worker 不是同一批，不要混用。

### agent-team 并存时

宿主加载 `@deepseek-ai/dsh-experimental-agent-team-profile` 后，`agentTeams` 服务存在，`tool-agent-team` 会给每个「普通根会话」装团队工具（`agent-team/src/roster.ts` 的 `tryMembership`：无 `parentSession`、无 subagent descriptor 的 root 都算 lead）。本 bundle 的 worker 正是普通根会话，于是被当成隐式 Lead，能自己拉 teammate、自己记 team 任务；协调者也同时看到两套派工工具。

工具面挡不住它们：团队工具注册在 Agent scope，而 `tools.restrict({ deny })` 只接受全局工具名（宿主 `packages/core/tools/src/index.ts` 的 `restrictableNames`），`tool-subagent*` 的全局注册又被 agent-team-profile 禁用了。所以本 bundle 只做两件事——第一次会话创建时告警一次，以及给协调者与 worker 注入运行时上下文（`dsh-leader-kit:team-ban`，order 106）。

禁令按各自的工具面分开写：协调者的出口是 `spawn_worker` / `message_worker` 与卡片；worker 的这三件工具正被 deny（`tools/gate.js` 的 `COORDINATOR_ONLY_TOOLS`），所以它只被告知当轮交付、自己的 worktree 与 PR、以及用 `update_card` 汇报。普通会话不注入：它们可能真的在用 teammate。要彻底隔离，只能从 profile 移除 `@deepseek-ai/dsh-experimental-agent-team-profile`。

### 工具面分配

工具面按角色在**会话创建时**裁剪，落在 `agent/created` 上，不是靠参数隐藏：

- 协调者拿到全部工具，但没有 `list_agents` / `send_message` / `interrupt_agent`——它们对 worker 无效，从工具面直接摘掉，模型就不会照描述去用一个拿不到效果的东西；
- 普通会话与 worker 都没有 `spawn_worker` / `message_worker` / `list_cards`——没进项目语境，看不到项目里有哪些卡，也不该派工；
- `create_card` / `update_card` 对所有会话开放——worker 边干活边把状态写回卡片。

完成回报不占工具面。普通会话保留那三件宿主工具：它可能真的用官方 subagent，那时它们是有效的。

实现在 `src/host/tools/gate.js`，用宿主的 `tools.restrict({ deny })`：它会按会话角色算出禁用的工具名，对 `agent.ctx` 调一次。`tools.register()` 在已发布版本里不接受按步条件，因此裁剪只能在会话创建时做。协调者身份来自项目注册表——**索引重建完成前不裁**，此时问不出谁是协调者，而少给工具会让协调者首轮干不成活。

## 项目与会话归属

项目是**显式注册的实体，不是目录**。一条项目记录有名字、目录，并绑定一个协调者会话（`projects.json` 的 `coordinatorSessionId`）。它与 dsh 的「工作区」不是同一层语义：工作区管代码语境（目录 + 会话归组），项目管编排语境（协调者 / 卡 / worker / 手册），同一个目录可以挂多个项目，两者不合并（见[项目作用域与角色槽位](../.agents/notes/2026-10-23-project-scope-and-role-slots.md)）。

服务层语义：

- **建项目 = 建实体 + 建工作区 + 建协调者会话 + 绑定**，四步一体；协调者会话建不出来时项目不落盘，项目落盘失败时尽力撤销刚建的会话与自建工作区，不留半条记录与孤儿工作区。
- **目录不可改**：目录是项目身份的一部分，改目录等于换项目。
- **会话归属按 realpath**：`session-index.js` 把会话按 cwd 与项目目录的 realpath 精确相等归到项目；两个项目指向同一目录时先注册的归属。子目录里的 worker 不算项目下的 worker。项目树的名单在它之上再并两类：worker 看登记表，退役协调者看项目记录的 `retiredCoordinatorSessionIds`。
- **worker 建完挂进同一工作区**：`agents.create` 不接受 `workspaceId`，派工器按父会话反查项目的 `workspaceId`，在投递成功后调 `attachToWorkspace` 挂进去。fire-and-forget：归属只影响分组，挂失败只记日志，下次点项目行自愈。
- **协调者换人**：原班 worker 的派工归属与未投递的完成回报一并改投新协调者（派工记录留 `reassignedFrom`），退役会话降级为项目里的普通会话，`spawn_worker` / `message_worker` / 跨项目 `list_cards` 在调用时按当前身份判定并拒绝。

项目注册表**只经左栏项目区块操作**，模型没有 `add_project` / `list_projects` / `switch_project` / `remove_project`。

**加项目就把它注册成 dsh 工作区**（幂等，已有则复用）：项目会话必须归属工作区——不归属会落进官方树的「未分组」，而本仓把项目会话行藏掉之后那里只剩一棵空组头。协调者会话直接以 `workspaceId` 建（cwd 由工作区 path 给出，仍是项目目录），worker 建完再挂进同一个工作区。项目自建的工作区记下 `workspaceId`，删项目时据此一并摘掉；复用来的用户工作区不记、删项目时也不动。工作区行本身在左栏照常显示——项目目录也是用户能在官方树里手动开会话的入口。

**工作区被用户删掉后按需重建**：宿主的 `WorkspaceRegistry.delete` 只删记录，会话与文件都不动，于是项目会话变成松散会话、落回「未分组」。点项目行时 `attachCoordinator` 重建工作区（`create` 幂等）并把三类会话挂回去——协调者、退役协调者、该项目登记过的 worker；名单来自 `coordinatorAttachTargets()`（协调者 + 退役集合 + worker 登记表），用户在项目目录里手动开的会话不碰。重建出来的工作区会回到左栏，但用户点的是项目行、未必注意到，所以客户端给一条顶部提示。

**打开与换协调者前先确认目录还在**：宿主注册工作区不校验目录，挂在已删目录上会抛一句英文技术错。`attachCoordinator` 与 `replaceCoordinator` 都先过 `assertUsableDirectory`，目录不在就回一句能照做的中文原因，也避免凭空注册一个指向已删目录的工作区。

## 卡片与看板

卡片落盘在 `$DSH_HOME/dsh-leader-kit/cards.json`，规则：

- 编号全局递增、不复用（归档与删除都不回收），`@#n` 跨项目不歧义；
- `revision` 做乐观并发，改内容要带 `expectedRevision`；
- 归档是终态；
- **项目归属由宿主判定**：`create_card` 时按调用方会话反查项目并写入 `projectId`，模型不传项目参数。`list_cards` 默认只列本项目，`scope=all` 才跨项目；有归属的卡只能被本项目会话改。

看板是**项目的看板**：一个项目一个看板，跨会话聚合，协调者建的卡与 worker 建的卡在同一处。数据源是宿主的卡片库（经项目远程通道读取），不是会话事件流——事件流是会话维度的，一个项目的卡散在多个会话里，重放既慢又会漏，worker 会话被回收后窗口就没了。卡片仍随 `tool/result` 事件的 `meta` 投影进 session log（历史完整），但那是历史，不是看板的数据源。

看板只对**项目会话**（协调者与该项目派出的 worker）展示；同目录的普通会话与已退役的协调者只看到提示。协调者建卡后右栏自动打开（或聚焦）看板 tab，只有出现新卡才打断，改卡不会。卡面信号灯七档由槽位会话状态实时投影，不落盘。

## 客户端注入面

dsh 的客户端没有「第三方并列区块」这类扩展点，本 bundle 的呈现面都是在既有槽位、DOM 与远程通道上拼出来的：

| 呈现面 | 做法 |
|---|---|
| 左栏项目区块 | 在「面板列表 nav」之后 DOM 注入容器，用 portal 渲染；布局取位「自动化任务之下、工作区之上」，找不到锚点时退回原槽 |
| 项目树 | 自建树，列出该项目派出的 worker 与退役协调者；行形态复刻官方工作区行（目录图标 / 悬停展开箭头 / 行尾「更多」） |
| 官方树排除 | 渲染层按 `data-row-key="session:<id>"` 给协调者与 worker 行加隐藏类；数据层不动，因此官方计数与搜索仍包含它们 |
| 会话水位折叠 | 复刻宿主工作区树口径：默认 5 条，每次加 5 条；运行中会话抬高水位；只升不降，收起回基线 |
| 协调者会话形态 | 注册第三方会话视图目标并激活，外壳切到 active 形态（输入框停靠、无欢迎页）；不产生模型调用 |
| worker 回报气泡 | 独立 Chat node kind + exclusive claim，左侧气泡、头像、名字可下钻；只渲染最后一次回报 |
| 看板 tab 与入口 | 右栏 tab 类型静态注册；「开始」页入口接管自己那枚胶囊的渲染，只在项目会话里画出来 |
| 浮层与提示条 | 弹窗外壳（`modal-shell.js`）与菜单复刻官方源码改写；一次性消息走宿主的 `shell.overlay` 槽位，4 秒淡出 |

## 持久化布局

运行时数据根是 `$DSH_HOME`（开发实例在 `.dev/home`），本 bundle 的数据全在 `dsh-leader-kit/` 下：

| 文件 | 内容 |
|---|---|
| `projects.json` | 项目注册表：名字、目录、协调者会话、退役协调者会话列表、自建工作区 id；数组顺序即左栏显示顺序（拖拽改，见[笔记](../.agents/notes/2026-11-02-project-row-drag-order.md)） |
| `cards.json` | 任务卡片：编号、状态、说明、链接、槽位、项目归属、revision |
| `workers.json` | worker 登记表：会话 id → 父会话与名字，续聊跨进程找回归属 |
| `notifications.json` | 完成通知落盘队列：投递失败留队，父会话重开时补投 |

会话本体是宿主的 JSONL（`$DSH_HOME/sessions/`），不在本 bundle 手里。仓外插件不能新增 session event 类型（[capability-gaps 第 8 条](capability-gaps.md)），卡片与通知状态因此走独立存储域 + session projection。

开发实例的数据根落在工作树内的 `.dev/home`，删掉即重置，不碰日常的 `~/.dsh`。

## 项目级提示词与协议层

| 来源 | 注入对象 | 生效时机 |
|---|---|---|
| `.agents/skills/leader-mode/` | 模型可发现并加载的协议层 | 模型调用 `skill` 工具时 |
| `.agents/skills/init-project/` | 初始化方法 | 模型调用 `skill` 工具时 |
| `COORDINATOR.md` | 该项目的协调者会话 | 每轮 turn 读文件，改动下一轮生效 |
| `SLOTS.md` | 卡片 `slots` 字段绑定的会话 | 每轮 turn 读文件，改动下一轮生效 |

`COORDINATOR.md` 与 `SLOTS.md` 都**只贡献提示词文本，不授予工具权限**。`COORDINATOR.md` 按身份注入（项目注册表指针），不需要卡片绑定；`SLOTS.md` 按卡片绑定注入。文件缺失、读失败或正文为空时注入空串，不阻断会话，也不生成兜底正文（协议层 skill 已覆盖通用方法）；配置错误大声告警，且同一问题只报一次。

`SLOTS.md` 的槽位名是 ASCII 机器标识（小写字母、数字、下划线、连字符，最长 32 字符），卡片工具与解析器共用同一条规则；frontmatter 的 `slots:` 声明界面显示名，只影响界面，不进入注入正文。没写 `SLOTS.md` 的项目回落默认三角色 `discuss` / `dev` / `review`（正文为空）。

协议层随 bundle 分发到包内 `.agents/skills/`（装机后位于 `node_modules/dsh-leader-kit/.agents/skills/`）。这个路径同时是 dsh 的项目级 skill 目录：任何项目在自己的 `.agents/skills/` 放同名副本即可覆盖，项目副本优先——dsh 的 skill 发现按来源层级取优，项目级 rank 200 低于 bundle 的 600。

## 模块表

| 部件 | 位置 | 说明 |
|---|---|---|
| 协议层 skill | `.agents/skills/leader-mode/` | `SKILL.md` + 4 个 playbook + 2 份参考：派工、接力、事件调度、卡片维护、传话纪律、验收裁决、进度说明 |
| 初始化 skill | `.agents/skills/init-project/` | 一次性把仓库工程约定写入目标项目：skill 给出方法与正文，模型用宿主的文件能力写 `AGENTS.md` 受管区块，幂等 |
| `spawn_worker` 工具 | `src/host/tools/spawn-worker.js` | 建一个常驻 worker 会话并即刻派活，**立即返回**会话 id，不等结果 |
| `message_worker` 工具 | `src/host/tools/message-worker.js` | 给 worker 续聊：活着就直接投，进程重启后冷恢复再投；可顺手 `rename` 改名 |
| worker 会话 | `src/host/worker-sessions.js` | worker 的创建、投递、销毁：`agents.create` 建的**普通根会话**，常驻、可被人下钻对话、进程重启后能冷恢复 |
| worker 登记表 | `src/host/worker-registry.js` | 会话 id → 父会话与名字的落盘映射（`workers.json`）：续聊跨进程也要找得到归属 |
| 派工与唤醒 | `src/host/dispatch.js` | 建会话、在 worker 轮次结束时从会话事件结算产出、落盘完成通知、唤醒父会话开新 turn |
| 通知落盘队列 | `src/host/notification-store.js` | 完成通知先写盘再唤醒；投递失败留队，父会话重开时补投 |
| 卡片工具 | `src/host/tools/cards.js` | `create_card` / `update_card` / `list_cards`：建卡、改卡、查卡。卡片按项目归属（宿主按调用方会话判定，模型不传项目参数），`list_cards` 默认只列本项目，`scope=all` 才跨项目 |
| 卡片存储 | `src/host/cards/store.js` | 卡片落盘与领域规则：编号不复用、revision 乐观并发、归档终态、项目归属字段 |
| 项目存储与服务 | `src/host/projects/` | 项目注册表（`projects.json`）与项目服务：建项目连带建协调者会话并绑定，失败整体回滚。注册表只经左栏项目区块读写，模型没有对应工具 |
| 项目通道 | `src/host/projects/remote.js` | 浏览器侧 → 宿主侧的 Typert 远程通道（命名空间 `projects`，走官方 `/api` 共享通道）；方法参数名与线上类型在 `src/shared/projects.js`，浏览器侧按类型选严格 codec |
| 卡片链接判定 | `src/shared/card-links.js` | 链接草稿的规范化与 URL 校验：浏览器侧保存前与宿主侧写通道共用同一份判定（trim、丢空 label、只认 http(s)） |
| 工具面分配 | `src/host/tools/gate.js` | 按调用方角色裁剪工具：协调者全有，普通会话与 worker 都没有编排与全库查询 |
| 会话归属 | `src/host/projects/session-index.js` | 按 realpath 把会话归到项目目录，得出「项目 → 会话」映射 |
| 角色槽位 | `src/host/slots/` | 读项目目录的 `SLOTS.md`，按卡片 `slots` 字段绑定到会话，作为运行时上下文注入 |
| 协调者手册 | `src/host/coordinator-context.js` | 读项目目录的 `COORDINATOR.md`，注入该项目的协调者会话：按身份决定，不需要卡片绑定 |
| skill provider | `src/host/skills.js` | 把 bundle 内的 skill 注册进 `ctx.skills`，让模型能通过 dsh 的 `skill` 工具发现与加载 |
| 右栏看板 Tab | `src/client/index.js`、`src/client/board-guide-entry.js` | 浏览器侧注册「看板」Tab 类型与面板主体；「开始」页的入口由本插件接管渲染，只在项目会话（协调者与 worker）里画出来 |
| 看板面板 | `src/client/board.js` | 项目维度的任务看板：按当前会话解析出所属项目，再按项目拉卡片；**只对项目会话（协调者与该项目派出的 worker）展示**，同目录里的普通会话只看到提示；分组、排序、已完成折叠区与空态/骨架 |
| 看板取数 | `src/client/project-board-data.js` | 解析会话所属项目、判定项目会话（协调者 / worker）、拉该项目的卡片、算出新增卡片 id（纯函数，可单测） |
| 看板监视器 | `src/client/project-board-monitor.js` | 建卡后自动打开（或聚焦）右栏看板 tab：只跟随项目协调者会话（worker 不自动弹），轮询项目卡片，出现新卡才开 |
| 看板卡面 | `src/client/board-card.js`、`src/client/board-styles.js` | active 卡三层（标题行 / 链接行 / 槽位行）、done 卡单行变体、链接 chip 按实测宽度排布、信号灯七档、卡面零操作铬 |
| 卡片详情浮层 | `src/client/card-detail.js`、`src/client/card-links-editor.js`、`src/client/modal-shell.js` | 详情浮层（说明 / 链接）：链接可编辑（行内 label / url / purpose、增删、保存经 `updateCardLinks` 整体替换），其余字段只读；浮层外壳（portal、遮罩、ESC、Tab 焦点陷阱、初始焦点、关闭回焦）与确认弹窗共用 |
| 左栏项目区块 | `src/client/project-panel.js` | 左栏「项目」区块：在「自动化任务」之下、工作区之上（DOM 注入取位），加项目（选目录即建好）、点项目行打开协调者会话、换新协调者、删除项目 |
| 项目树 | `src/client/project-section.js` | 点标题折叠/展开整个项目列表，点行首槽位展开/收起该项目的会话行（worker 与被换下的协调者；当前协调者与用户手动开的会话都不在其中，会话行是纯文字行，无左右图标）；点项目行本身是打开该项目的协调者会话；项目名后面不跟路径。行首槽位与官方工作区行同款：平时是目录图标，悬停整行换成展开箭头，展开时箭头旋转朝下；「更多」在行右端，悬停时出现。项目下的会话列表按水位折叠（见下一行） |
| 会话水位折叠 | `src/client/session-watermark.js` | 复刻宿主工作区树的口径：默认露出 5 条，每次「展开其余 N 个会话」再加 5 条，剩余不足 5 条时一次放完；运行中的会话把水位抬到它所在位置（只在前 50 条内生效）；水位只升不降，收起回落到基线；每个项目各算各的，状态不持久化 |
| 会话归档 | `src/client/project-panel.js`、`src/host/cards/store.js` | 悬停会话行，右端露出归档按钮（与官方会话行的 hover 动作同形：24×24、三级标签色）。归档走宿主的 `workspaces.archiveSession`，成功后摘掉卡片上指向该会话的槽位、删掉派工登记；会话正在跑时弹「停止并归档」确认，其余失败直接报错 |
| worker 回报气泡 | `src/client/worker-report-view.js`、`src/client/worker-report-styles.js` | 回报正文默认折两行（按 compact 行高算 `max-height`，见[已知限制](#已知限制与取舍)），内容真的超两行时下方才出现「展示更多」，展开后变「收起」；气泡底色是前景色 2% 的极淡一层，边界由 1px 边框交代 |
| 产品图标 | `src/client/icons.js` | 内联图标路径（宿主 web 端运行时没有 sprite，`<use>` 引用必然落空） |
| 官方树排除 | `src/client/workspace-exclusion.js` | 把项目的协调者与 worker 会话从官方工作区树里隐藏（渲染层，官方数据层不动）。worker 是普通根会话，官方树不会自己滤掉，按会话 id 排除。工作区行本身照常显示（见[已知限制](#已知限制与取舍)「项目目录的工作区行照常显示」）。当前会话就是被排除的那条时，它所在工作区行的激活图标压回普通色 |
| 删除项目确认弹窗 | `src/client/confirm-dialog.js` | 「删除」的二次确认弹窗：讲清项目连同插件注册的工作区一起删、文件夹与会话记录保留（复用 `modal-shell.js` 的浮层外壳：遮罩点击 / Escape / Tab 焦点循环 / 初始焦点 / 关闭后焦点返回） |
| 一次性提示条 | `src/client/toast.js`、`src/client/toast-view.js` | 操作失败、引导下一步这类「说完就该消失」的消息走顶部居中提示条：挂宿主 `shell.overlay` 槽位，形态照宿主 Toast（暗色表面、不拦点击），停留 4 秒后淡出；同一时刻只留一条，新消息替换旧消息。项目区块不再有常驻提示行 |
| 协调者会话形态 | `src/client/coordinator-view.js`、`src/client/coordinator-view-logic.js` | 协调者会话注册一个第三方会话视图目标并激活它，官方外壳因此切到 active 形态——输入框停靠底部、会话区保持空白。没有消息、没有模型调用，也没有欢迎页 |

## 编排动作与工具

| 动作 | 工具 | 来源 |
|---|---|---|
| 派工给后台 worker | `spawn_worker` | 本 bundle |
| 给 worker 续聊 / 改名 | `message_worker` | 本 bundle |
| worker 轮次结束的自动回报 | `session/event` → `turn/end` | 宿主 |
| 读 worker 回报 | 完成通知 | 本 bundle 的唤醒器 |
| 建卡 / 改卡 / 查卡 | `create_card` / `update_card` / `list_cards` | 本 bundle |

`spawn_worker` / `message_worker` 这套接口是为「协调者派活、worker 干活并自动回报」设计的：会话由 `agents.create` 建，生命周期归本 bundle 管，不经 dsh 的 subagent 机制。

## 开发

### 多 worktree 并发

每个任务一个 worktree、一个独立 dsh 实例，是这个仓库的开发形态——它同时也是本 bundle 玩法成立的前提（见 README 的[前提](../README.md#前提先跑通多-worktree-并发)）。`npm run worktree:spawn <任务名>` 建目录与分支（base 取最新 `origin/main`），进去后 `npm run dev` 起实例。

`npm run dev` 不碰你日常的 `~/.dsh`：数据根落在工作树内的 `.dev/home`（会话、项目、卡片都在那里，删掉即重置），profile 从 `~/.dsh/profiles/web` 派生，`node_modules` 逐条符号链接到源 profile、只有 `dsh-leader-kit` 指向当前工作树。所以几个工作树可以同时跑，各自的插件版本与数据互不干扰；源 profile 升级 dsh 或改插件组合时，开发实例跟着走。

- 凭据文件跟着数据根独立，新工作树第一次起实例本来要在界面上重填 API key：启动前会把源 HOME `.credentials.yaml` 的 `refs` 并进开发实例那一份。只搬 `refs`（按环境变量名存的密钥），不搬 `records`——账号授权的刷新令牌两个实例各持一份会互相踢掉登录。目标里已有的条目不动，界面里改过的值优先；要重新跟随源就删掉 `.dev/home/.credentials.yaml` 里那一条。块式与行内（`refs: {}`）两种 `refs` 节形态都认，写回替换该节；认不出、重复 `refs:`、锁超时都直接报错，不猜拼接位置。目标凭据文档不是 version 1 布局时不动——pre-release 扁平布局由宿主启动时自行迁移，先追加 `refs:` 会让它两种布局都不成立。写入走临时文件 + rename、权限 600，并与运行中的实例共用宿主的写者锁。没走 `DEEPSEEK_API_KEY` 启动环境那条路：它在 dsh 的凭据解析顺序里排在存储文件之后本来就能用，但 key 会留在 agent 工具进程的环境里。
- 端口默认交给系统分配，启动日志里打印带 token 的 URL；要固定就 `DEV_PORT=3210 npm run dev`。
- 改客户端代码（`src/client/`）由 `npm run dev` 挂的 esbuild watch 自动重建，宿主 web 组合默认挂着 `client-hmr`：它每 500ms 轮询插件产物的 `mtime/ctime/size`，变化就把运行中的插件换掉（拆旧 fiber、重新 `apply`），页面不刷新、插件内 React 状态重置、会话与连接数据保留。构建失败时正式产物保持上一份，watch 打印错误后继续监听；单独重建用 `npm run build:client`。宿主侧（`src/host/`）由 Node 直接加载，重启实例即可。
- 依赖共享主 checkout 的 `node_modules`（本仓库只有 esbuild 与 minidenticons），改 `package.json` 请在主 checkout 安装。
- 覆盖项：`DSH_HOME`（数据根，**不能等于 `DSH_HOME_SOURCE`**——那条路径会把日常 profile 改写成自指死链，脚本直接拒绝）、`DSH_HOME_SOURCE`（源 HOME，默认 `~/.dsh`）、`DSH_PROFILE`（源 profile 名，默认 `web`；那个 profile 的 bundles 里必须有 `@deepseek-ai/dsh-web-app`，否则脚本拒绝——缺它的 profile 跑 `dsh web` 不监听、不打印、也不报错）、`DEV_PORT`、`DEV_NO_OPEN=1`（不自动开浏览器）。

`npm start` 起的是日常实例：数据根 `~/.dsh`（`DSH_HOME` 可换），profile 固定 `profiles/web`（`dsh web` 读的就是它），插件取该 profile 链接的版本。起之前依次检查——`dsh` 可执行文件（未装或不在 PATH 时给中文提示，`DSH_DSH` 可指定路径）、profile 存在、bundles 里有 web-app bundle 与本插件、`node_modules/dsh-leader-kit` 链接存在；全部通过后，若链接指的就是当前目录则先 `npm run build:client`（`lib/client.js` 不入库，没构建过时实例照常起来、右栏却没有看板）。从 worktree 里跑时链接指的是主 checkout，脚本跳过构建并提示那是另一个目录的代码——本目录的改动要在本目录里验证请用 `npm run dev`。额外参数原样转给 `dsh web`：`npm start -- --no-open --port 3210`。

收尾时清掉已合并的 worktree：

```sh
npm run worktree:prune                 # 只打印结论（dry-run）
npm run worktree:prune -- --apply      # 真删：worktree 目录 + 本地分支
npm run worktree:prune -- --apply --delete-remote   # 连远端分支一起删（--remote 指定远端，默认 origin）
```

守卫：有未提交改动的、当前所在的、分支没进 `main` 且 PR 未合并的，一律拒绝。分支是否已合并看两条判据——`merge-base --is-ancestor main`（merge 合并成立）与 PR 状态（squash 合并只有这条成立）。删 worktree 时 `.dev/home` 的数据与 `node_modules` 链接随之清掉，链接指向主 checkout，删的只是链接本身。

也可以不用脚本、手工把插件装进某个 profile：`dsh plugin --profile web add ../dsh-leader-kit`（改代码即生效，但会与装进同一 profile 的其他工作树互相覆盖）。

### 测试、取证与构建

命令见 [AGENTS.md 的常用命令](../AGENTS.md#常用命令)。这里只记机制：

只有 `node:test`，没有 lint：未使用的 import、死代码、拼写错误抓不到，改完要手扫。可判定逻辑抽成纯函数模块再测；IO 与 React 组件不硬测，判据在宿主 UI 里的行为用真机取证（见 [e2e-testing.md](e2e-testing.md)）。

浏览器侧产物不入库（`.gitignore` 忽略 `lib/`），发布时由 `prepublishOnly` 重建。构建入口 `build/client.mjs` 是薄壳，配置与原子写在 `build/client-bundle.mjs`：esbuild 先写 `<产物>.<pid>.<随机>.staging`，成功后才 rename 到正式路径——宿主按文件 stat 轮询产物，读到半截文件会替换失败且没有回滚，这条契约由 `tests/client-build.test.js` 守住（banner/footer 外壳、基线模块 external、构建失败保留上一份）。staging 带进程标识，同树的 watch 与手动构建并存时不会共写临时文件；两个进程仍会竞争最终产物，后完成 rename 的赢，但不保证内容新旧顺序。协议层的相对链接完整性由测试守住——搬动文件后链接断裂会直接测试失败。

## 宿主契约与架构约束

规则速查在 [AGENTS.md 的宿主契约要点](../AGENTS.md#宿主契约要点)，逐条的实测依据在 [capability-gaps.md](capability-gaps.md)。本节只记这些约束落到了哪一层：

| 约束 | 落点 |
|---|---|
| 宿主 API 按下限挑（`>=0.2.1-rc.2 <0.3.0`） | 落在 `agent/created` 上的新 API 最危险：下限版本抛一次 `TypeError` 就是每个会话创建都失败，引入前先查宿主仓库的 tag |
| 不改宿主仓库、不 import 宿主内部包、不 peer 依赖 dsh 包 | 零运行时依赖的边界见[分层](#分层)；理由写在 `src/host/message.js` 头注释 |
| 身份先于会话（[第 37 条](capability-gaps.md)） | `src/host/tools/gate.js` 在 `agent/created` 上按身份 `restrict({ deny })`；协调者身份先写进项目注册表，再建会话 |
| 不能新增 session event 类型（[第 8 条](capability-gaps.md)） | 卡片、通知、项目状态各自独立落盘（`cards/`、`notification-store.js`、`projects/`），会话侧只做 projection |
| client 产物不能用 `node:`、不引 React / jsdom（[第 23 条](capability-gaps.md)） | `src/client/` 只用宿主模块表与 `React.createElement`，产物由 `build/client.mjs`（薄入口）与 `build/client-bundle.mjs`（配置）打 |
| 浏览器侧 → 宿主侧只有 Typert 远程通道 | `src/host/projects/remote.js`：`connection.rpc.handle` 对仓外插件不可用，`/api` 被官方 gateway 占用；代价是手写的协议形状与宿主版本耦合（标记属性名、`version:1` 描述符、`typertRemote` 绑定字段），宿主改契约时要同步 |

## 协作与文档机制

本仓的长期记忆分三层，各管一件事：

| 层 | 位置 | 管什么 | 维护方式 |
|---|---|---|---|
| 常驻规则 | `AGENTS.md` | 每个任务都适用的铁律与按任务查阅入口 | 只放自包含断言或链接；细节写归属文档 |
| 决策记忆 | `.agents/notes/` | 非平凡改动的永久决策与边界 | 同 PR 携带；结构由 `npm run check` 机械校验 |
| 长期文档 | `docs/`、各文件头注释 | 宿主能力边界、架构、取证流程 | 行为变更同步 |

**Agent Note 机制**：只记永久决策与边界，不写流水账；正文按 `## 背景` / `## 决策` / `## 边界` / `## 验证` 分节，文件名用英文（`YYYY-MM-DD-<english-title>.md`），正文中文。结构由 `scripts/verify-agent-note-format.mjs` 检查（文件名、唯一 H1、首节与决策节、节名不重复），判定逻辑在 `scripts/agent-note-format.mjs`。

**AGENTS.md 渐进式披露**：根文件只列每个任务都适用的规则和一张「按任务查阅」表，细节进归属文档。改哪块先读对应文档，避免把整仓规则塞进一次上下文。

**文档防腐化**：文档与实现的漂移靠三条挡住——能机械判的交给门禁（Agent Note 结构、协议层相对链接、`npm run check`）；行为变更必须在同 PR 同步 README 与 `docs/`；临时证据（截图、探针脚本、临时数据）不入库，只把结论与读数写进 PR 或笔记。

### 交付状态与阶段编号

阶段编号（本文、`docs/capability-gaps.md`、`.agents/notes/` 通用）：P0 调研与能力缺口实测 · P1 协议层、初始化与派工唤醒 · P2 卡片存储与右栏看板 · P3 项目注册表与角色槽位 · P4 看板卡面 · P5 查卡分页、卡片项目归属、项目看板与项目树 worker 会话。

**P5 已完成**，累计交付：骨架 + 协议层 + 初始化 + 派工唤醒 + 卡片存储与卡片工具 + 右栏看板 UI + 项目注册表与左栏项目区块 + 角色槽位注入 + 看板卡面重做 + 看板按项目组织 + 建卡后自动打开看板。此后删除了项目注册表工具与卡片检查点（见[笔记](../.agents/notes/2026-10-29-drop-project-tools-and-card-checkpoint.md)），并把看板开放给项目会话（协调者与 worker）、右栏入口按会话过滤（见[笔记](../.agents/notes/2026-10-30-board-entry-per-session.md)）。

## 已知限制与取舍

### 宿主语义与运行形态

- **后台编排只适用于长驻组合**（web / desktop / sdk）。headless 是一次性 CLI，会话在 turn 结束后即被销毁，届时没有载体接收完成通知——这是宿主语义，不是本 bundle 的缺陷。
- **报告结算依赖轮次正常结束**：结算点在宿主的 `turn/end` 事件上。进程在 worker 跑完之前被杀，那一轮就不会结算（在飞表在内存里，重启即空），协调者也就收不到这次通知；重启后它会看到 worker 会话还在，可以自己打开看或续聊。订阅 `session/event` 不做运行期能力探测——cordis 的 `Context` 永远有 `on`，而宿主低于 `engines.dsh` 下限时本来就没有这个事件；下限 rc.2 已提供 `session/event` 与 `turn/end`，这是版本契约，不是装配期能判定的错误。
- **不能新增 session event 类型**：dsh 要求仓外事件带 `ignorable` 标记且不进读路径，因此卡片与通知状态走自有落盘文件。
- **项目级手册都是每轮读文件，没有 watcher**。`COORDINATOR.md` 与 `SLOTS.md` 每轮 turn 重新读取，改动在下一轮生效；正在跑的那一轮不会变。两者都是增量信息：文件缺失、读失败或正文为空时注入空串，不阻断会话，也不生成兜底正文（协议层 skill 已覆盖通用方法）。协调者手册只对项目注册表里指到该会话的协调者生效——项目索引还没重建完的那一轮不注入，下一轮补上。
- **历史消息不追溯**。改造之前发出的通知在 session log 里就是普通用户消息，重放时仍按老形态渲染（右对齐、无头像）。
- **worker 回报不进会话标题、turn 摘要与 markdown 转录导出**。宿主只把 `source.kind === 'user'` 的消息算作真人输入；本仓的回报用自定义 source kind（`dsh-leader-kit/worker-report`），因此会话自动标题不取它、turn 摘要 prompt 不取它、markdown 转录导出会跳过它。换来的是它不会被误当成用户说的话——标题、摘要、导出这三处都只认真人输入。
- **worker 回报的渲染依赖宿主的会话节点扩展位**。本仓注册一个独立的 Chat node kind 并用 exclusive claim 接管这类消息（见 [worker 回报气泡](../.agents/notes/2026-10-27-worker-report-bubble.md)）。宿主若改了 claim 或分组语义，这条消息会退化成普通的右对齐用户气泡——内容不会丢。
- **worker 回报要等父会话空闲才送达**。完成通知排进 inbox 的 next-turn 边界（下一个 turn 的一次输入），父会话正忙时先不投、留在落盘队列里，检测到空闲再投。否则它会像用户自己发的消息一样，以「一条待发消息」的形态挂在输入框上方的「消息队列」条里（对照实验：busy 时直接投，面板显示「2 queued messages」，把人的消息和 worker 回报混在一起）。代价是协调者正忙时，回报要多等它这一轮结束（见 [worker 回报的投递边界](../.agents/notes/2026-10-27-worker-report-delivery-boundary.md)）。
- **worker 头像在深色主题下轮廓弱**（既定取舍，不是待修项）。气泡底是前景色混出的 4% 一层，36% 的蓝紫色相落上去只有 1.35:1，块的外轮廓看不出边界；头像本身仍可辨。头像池只有 63 个 seed，worker 多时会有撞图（3 个约 4.7%，5 个约 15%），名字就在头像旁边，不影响身份识别。

### worker 的控制面

- **协调者没有中止 worker 的手段，也没有模型侧的名录工具**。worker 是普通根会话，宿主的 `list_agents` / `send_message` / `interrupt_agent` 都作用在 subagent 体系上，对它无效（`interrupt_agent` 还会返回一个假的成功回执）。worker 卡住或跑偏时，只能请人去那个会话里处理；要看项目里有哪些 worker，看项目树（那一层在前端，模型看不到）。这是常驻化的直接代价：换掉 subagent 换来常驻与可下钻，也就换掉了宿主的这套控制面。

### 看板与卡片

- **看板按项目组织，不按会话，且只对项目会话展示**。一个项目一个看板：面板按当前会话解析出所属项目，再确认它是该项目的协调者或该项目派出的 worker，才按项目拉卡片——协调者建的卡与 worker 建的卡在同一处。项目目录里的普通会话与已经被换下的协调者打开看板只看到「看板只在项目会话中打开」的提示；它们仍然能解析到项目（卡片归属要用），只是不拥有看板的呈现面。数据源是宿主的卡片库，不再重放会话事件流（跨不了会话，也扛不住宿主回收）。不属于任何项目的会话也没有看板，面板会说明这一点。协调者会话被归档或替换后项目绑定不会自动改：项目摘要带 `coordinatorAlive`，面板每 30 秒复核一次，旧协调者会话与项目里的执行会话切到「该项目的协调者会话已失效，请在左栏项目区块换新协调者」的提示，不再展示卡片。
- **「看板」入口按会话画，残余在 More 菜单**。右栏 tab 类型与「开始」页的入口是静态注册，宿主没有按会话过滤的扩展点；本插件接管 `sidebar.right.tab.guide.entry` 里自己那一枚胶囊的渲染，只在项目会话（协调者与 worker）里画出来，样式复刻宿主 `EntryBox`。`sidebar.right.tab.guide.actions` 是 root scope、不带会话，「开始」页的 More 菜单仍会列出「看板」；自动弹出仍只跟随协调者会话（worker 建卡不弹）。
- **卡片按项目归属，归属由宿主判定**。`create_card` 时宿主按调用方会话反查项目，把 `projectId` 写进卡片记录，模型不传项目参数——它未必知道自己在哪个项目的语境里调工具。`list_cards` 默认只列本项目，`scope=all` 才跨项目；有归属的卡只能被本项目的会话改，跨项目改卡会被拒绝。**存量卡片不迁移**（记录里没有创建会话 id，无法可靠反推归属），它们不出现在任何项目看板，只能用 `list_cards`（`scope=all`）看到。
- **卡片编号仍是全局的**。按项目过滤后编号会有空洞，但全局唯一，`@#n` 不歧义——比按项目编号更好（见[卡片存储与编号作用域](../.agents/notes/2026-10-23-card-storage-and-numbering-scope.md)）。归档与删除都不回收编号，跨项目也不复用。
- **卡片详情只写链接**。链接编辑走项目通道的 `updateCardLinks`（整体替换 `links`，宿主侧按共享的 `card-links.js` 重新校验、把 http(s) 地址按 WHATWG URL 归一化后落盘并补条目 id）；完成、置顶、重命名、删除仍归协调者的卡片工具，卡面也不放操作按钮。归档卡是终态，详情不给编辑入口。**跨项目判定不在这条通道上**：远程方法拿不到调用方会话（`direct` 调用不带 ctx），归属之下的写卡限制仍只由工具层执行；这条通道经官方 `/api` 同源链路到达宿主，任何能调 `/api` 的本机页面或进程都能按 id 改任意项目的卡——这是单机单用户威胁模型下的取舍，不比工具更宽，只是少了「防误用」的一致性检查。
- **卡片详情浮层是打开瞬间的快照**。卡片随后被协调者更新，浮层不会跟着刷新，要关掉重开；本浮层自己保存的链接会立刻回填到浮层与卡面。链接编辑不进乐观并发：详情里的 revision 是打开时的，用它做 `expectedRevision` 会在协调者改过卡后稳定冲突，而用户表达的意图就是「这些链接现在是这样」。
- **卡面不显示所属项目/工作区**。看板已经按项目过滤，卡面不必再重复标注（无 workspace chip）。
- **会话折叠只认运行态**。宿主的工作区树还会为「有子代理在跑」「等你输入」「未读完成」「当前会话」四种注意力抬高水位，我们手里只有会话行的 `running`，所以只按它抬。收起只在全部放完时出现，与宿主 `sessionsExpanded = hiddenCount === 0` 的口径一致——会话很多时要点若干次「展开其余 N 个会话」，而不是随时能收。
- **「等你输入」档暂无数据源**。宿主的待处理交互机制在（`pendingInteraction`），但当前没有任何域发布它，这一档不会亮；机制与档位都留着，等真有域发布时自动生效。「未读」档已实测跑通。
- **气泡折叠没有布局单测**。折叠水位按 compact 行高算 `max-height`（2 × 20px 行高 + 22px padding/border），是否出现「展示更多」要在 DOM 上量 `scrollHeight` 与 `clientHeight`；本仓不引 jsdom，真实布局只能用浏览器取证（[e2e-testing.md](e2e-testing.md)）。实现形态有源码断言：`tests/markdown.test.js` 钉住折叠不再用 `-webkit-line-clamp`、行高取 compact 值。旧回报走纯文本 `pre-wrap`：没有 `report` 的（回退整条通知正文，协议行）与多行 `report` 既无块级标记又无空行的（早期落盘多块用单个换行连接，Markdown 会折成一段），都不被 Markdown 折行；有空行或块级标记的照常走 Markdown。
- **归档入口只在有 hover 的设备上出现**。按钮的显示挂在 `@media (hover: hover)` 上（与官方会话行一致），触屏上不会出现；归档本身是宿主能力，也可以在别处完成，本区块会跟着 `archivedSessionIds` 快照把行藏掉。

### 项目、树与工作区

- **项目注册表只经左栏区块操作**。模型没有 `add_project` / `list_projects` / `switch_project` / `remove_project`；仓库工程约定也没有专用工具，初始化走 `init-project` skill 的文件写入。目录选择器不可用时（宿主缺 web-app 的导航服务）无法建项目，需要换用 web profile。
- **项目树是自建的，与官方工作区树并存**。官方只有按工作区分组的会话树，没有「项目」维度。本仓的项目树列出该项目的 worker 与退役协调者，判据分开：worker 看登记表（「登记表说它是本 bundle 派出的 worker」）加 cwd 与项目目录的 realpath 精确相等（worker 是普通根会话，会话头没有身份标记，只能按登记判）；退役协调者看项目记录的 `retiredCoordinatorSessionIds`。当前协调者（入口在项目行上）与用户在项目目录里手动开的会话都不算：前者由项目入口打开，后者留在官方工作区树里。
- **「项目会话不出现在官方工作区树」是渲染层排除，不是数据层**。官方没有按外部集合排除行的扩展点，本仓认 `data-row-key="session:<id>"` 给命中排除集的行加隐藏类。排除集含项目的协调者会话与全部 worker 会话（worker 是普通根会话，官方树不会自己滤掉，不排除就会同时出现在两棵树里）。代价：官方分组行上的会话计数仍包含被隐藏的会话；被隐藏的行仍在 DOM 里，官方搜索仍能命中。
- **子目录里的 worker 不算项目下的 worker**。归属按会话 cwd 与项目目录的 realpath 精确相等判定；两个项目指向同一目录时先注册的归属。
- **加项目就把它注册成 dsh 工作区**。项目会话必须归属工作区，否则会落在官方树的「未分组」里——本仓把项目会话行藏掉之后，那里就剩一棵空组头。所以建项目时先把目录注册成工作区（幂等，已有则复用），协调者会话直接以 `workspaceId` 建（cwd 由工作区 path 给出，仍是项目目录），worker 会话建完也挂进同一个工作区。
- **工作区被用户删掉后按需重建**。用户可能在工作区管理面板里删掉插件注册的那个（左栏与工作区管理面板里都有）。此时项目会话变成松散会话、落回「未分组」，点项目行会重建工作区并把协调者、退役协调者与该项目的 worker 会话一起挂回去，并给一条顶部提示。只恢复插件自己建的会话，用户在项目目录里手动开的会话不碰；重建的触发与名单见[项目与会话归属](#项目与会话归属)。
- **「未分组」组头留给用户自己**。项目会话都归属工作区，正常情况下「未分组」里没有插件的东西；唯一的例外是工作区被删、又还没点过项目行的窗口期——那时组头会露出来，会话行仍被藏着。本仓不为了这个窗口去复刻宿主的可见性规则（空会话只在它是当前会话时渲染、归档会话默认不进组），那等于把会话生命周期搬进插件。
- **被隐藏的会话不再点亮它所在的工作区**。官方按「当前会话属于哪个分组」给工作区目录图标上主色；协调者与 worker 会话在渲染层被隐藏后，点亮的分组里找不到对应的会话行——分组看着是开着的，却找不到是谁。本仓在当前会话属于排除集时，给承载它的工作区行加类，把图标压回三级标签色（同为渲染层，官方数据层不动）。只在分组视图下压当前会话所属的那一组；树模式下祖先分组仍会点亮。
- **项目目录的工作区行照常显示**。加项目会顺带把目录注册成工作区（上一条的技术原因），这行就留在官方工作区树里：它是有用的入口，用户可以在项目目录里手动开会话。代价是同一个目录在左栏出现两次（项目区块一行、工作区树一行），且组内的协调者与 worker 会话行仍被排除、计数比可见行多。早先版本按项目记录的 `workspaceId` 整组藏掉，那是渲染层判定，用户既无法从界面看出它属于哪个项目，也没法在项目目录里找到手动开的会话；后来改成一直可见。
- **项目区块靠 DOM 注入取位**。dsh 的左栏正文区只有 `sidebar.workspaces` 一个槽且已被宿主占用，slot 机制没有包装能力，第三方插不进并列区块——本仓在左栏的「面板列表 nav」之后插容器并用 portal 渲染，位置是「自动化任务之下、工作区之上」；宿主结构变化导致找不到锚点时内容退回原槽，功能不受影响。

### 客户端与宿主耦合

- **客户端依赖解析走宿主的冻结模块表**。`PLATFORM_MODULES`（`packages/client/web/src/platform.ts:8`）是宿主共享给所有 bundle 的冻结模块表，`react` / `react-dom` 也在表里；rc.2 的宿主自有包有四个——`dsh-client-store` / `dsh-client-ui-slots` / `dsh-client-ui-primitives` / `dsh-client-ui-dockkit`，由 `seed.ts:9-19` 静态 import 进 `:26` 的 `getStaticModules`（文件头写明是 shell 共享进冻结模块表的**唯一**集合）。这些 `src/` 文件不在 npm 安装包里（`files` 只发 `lib/`），核对要对着源码仓的同 tag。基线模块由构建期 `BASELINE_EXTERNALS` 留在产物外，运行时 `require` 解析到同一实例；基线里的宿主包可直接复用，本仓用到了 `ui-primitives` 的 `MarkdownText`（卡片说明与 worker 回报气泡）。**这张表没有跨版本承诺，风险方向是宿主把条目移出基线**：删掉 `ui-primitives` 后产物里的外部 `require` 解析失败，插件客户端半边在模块求值阶段整个起不来——`engines.dsh` 下限升级时按 tag 对照 `platform.ts`，不按本机最新版。**基线之外的宿主 UI 包不保证可用**——不是宿主禁止引用（`dsh.client.external` 可引入由另一个插件行 supplier 的模块，见 `scripts/verify-client-packages.ts:352-381`），而是这些包不承诺运行时可解析。`Modal` / `Menu` 本来就是 `ui-primitives` 的导出、在基线内；确认弹窗与菜单仍照 `packages/client/ui-primitives/src/Modal.tsx`、`Modal.module.css`、`Menu.tsx` 复制改写（类名换 `dsh-leader-kit-modal-*` 前缀、按本仓交互调整行为），动机是定制而不是「用不了」。代价是宿主改这些组件（含 `MarkdownText` 的签名与排版）时本仓要同步。
- **协调者会话形态依赖宿主的会话视图服务**。宿主没提供 `uiConversation` 服务时（它不在机器可读的插件 API 目录里，属于版本耦合面），协调者会话退化成官方欢迎页（居中输入框），本 bundle 不阻断打开会话，也不自绘替代界面。
- **图标数据与宿主 `artwork.ts` 耦合**。宿主 web 端把图标在构建期内联进产物，运行时 DOM 里没有 sprite 节点，第三方 bundle 在运行时渲染只能自己带路径数据——本仓内联的路径取自宿主 `dsh-client-ui-primitives` 的 `artwork.ts`（regular 字重），宿主改图标时本仓要同步。
- **工具面裁剪靠宿主的 `tools.restrict()`**。已发布的最新 dsh（`0.2.1-rc.4`）里 `tools.register()` 仍只收一个参数，按步求值的 `when` 只在源码仓 HEAD 上，所以裁剪落在 `agent/created` 时对 `agent.ctx` 调一次 `restrict({ deny })`。协调者身份来自项目注册表——**索引重建完成前不裁**：这时候问不出谁是协调者，而少给工具会让协调者首轮干不成活；工具面这一层的宽松只对读类工具安全，派工前另行 `awaitIndex()` 并复核身份。
- **浏览器侧 → 宿主侧走 Typert 远程通道**（命名空间 `projects`，经官方 `/api` 共享通道）。dsh 的 `connection.rpc.handle` 对仓外插件不可用（注册作用域拿不到 `webServer`），`/api` 又被官方 gateway 占用；Typert 的 SRC 回退通道允许第三方按协议形状注册服务，但代价是**手写的协议形状与宿主版本耦合**——本仓对齐宿主 `0.2.1-rc.2`（标记属性名、`version:1` 描述符、`typertRemote` 绑定字段、方法形参即 wire 字段名），宿主改契约时本仓要同步改。远程方法名还要避开官方命名空间服务的保留字（撞名会让整个命名空间挂不上）。
