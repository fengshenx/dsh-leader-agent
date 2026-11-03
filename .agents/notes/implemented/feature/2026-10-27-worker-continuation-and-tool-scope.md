# worker 续聊、工具面分配与会话折叠

**状态**：implemented（2026-10-27）
**范围**：`src/host/dispatch.js`、`src/host/worker-registry.js`、`src/host/tools/message-worker.js`、`src/host/tools/gate.js`、`src/host/projects/service.js`、`src/host/index.js`、`src/client/session-watermark.js`、`src/client/project-section.js`

## 背景

三条需求：worker 派出去只能跑一轮、不能接着聊；协调者与普通会话、worker 的工具面没有区别；项目下的会话列表没有官方工作区树那套折叠。

## 决策

### 续聊走冷恢复，不复用宿主的 `send_message`

`send_message` 是 dsh 自己的子会话协议，三条硬约束都对不上：发送者必须是活着的 agent、目标必须是直接子会话、目标必须可续聊。worker 结算后 agent 已经没了，`send_message` 根本发不出去。所以另开 `message_worker`：`childId` + `message`，宿主 `ctx.subagents.sendMessage()` 冷恢复同一个子会话。

**`delivery` 不进工具参数**。它是宿主侧的交付语义，让模型传等于把实现细节暴露到调用面。`spawn_worker` 用 `'caller'`（宿主对首轮保持沉默，由本 bundle 的通知体系交付）；冷恢复的 `delivery` 由宿主硬编码 `'parent'`，我们改不了，也不该改。

**续聊必须能跨进程找回归属**。`sendMessage` 只认子会话 id，所以派工时就把 `childId → { parentSessionId, label, task }` 写进 `workers.json`（`src/host/worker-registry.js`，原子写 + 串行链 + 损坏备份）。不落盘的话进程重启后这个 worker 就再也接不上话。

**派工前置 Fail Loud 检查持久化后端**。缺 `sessionPersistence` 或 `sessionQuery` 时拒绝派工，而不是悄悄降级成「只能跑一轮」的 worker——用户以为能续聊，实际不能，比直接报错更糟。

**在飞与已结算分开处理**。worker 还在跑时发消息，宿主会把消息并入当前 activation（`merged`），结算仍是首轮那份结果，不需要额外信号；已结算才登记续聊，等 `subagent/end` 事件收尾。

**续聊轮吞掉宿主的英文结算通知**。冷恢复的 `delivery` 固定 `'parent'`，宿主必发一条 `Background subagent X finished...` 的 notice。本 bundle 的通知体系（落盘队列 + next-turn 投递 + worker 汇报气泡 + 复制按钮）是既定交付形态，同一件事不能报两遍。在 `agent/inbox/inserted` 里用 `inbox.remove()` 摘掉它；摘不掉（已投出）就透传宿主那条兜底，本轮不再自发——宁可让用户看到英文通知，也不能两边都没有。

**续聊轮用 `subagent/end` 而不是 `activation.result`**。`sendMessage` 只返回 messageId，拿不到冷恢复 activation 的 promise。事件带 `id` / `stopReason` / `lastAssistantMessage`，与 `SubagentResult.output` 同源，信息量足够。首轮仍用 `activation.result`：只有它能拿到 reject 的具体失败原因，而且事件先于 promise 结算，首轮事件查续聊表自然落空，两套路径不冲突。

**顺手修了首轮结算链缺 catch 的隐患**。`activation.result.then(...)` 原来没有 `.catch`，落盘失败会变成 unhandled rejection，宿主对它的处理是 `proc.exit(1)`——一条通知写不进去就带走整个 dsh 进程。

### 工具面按角色裁剪，落在会话作用域上

**用 `tools.restrict()`，不用 `register(def, { when })`**。已发布的最新 dsh（`0.2.1-rc.4`）里 `tools.register()` 仍只收一个参数；按步求值的 `when` 只在源码仓 HEAD 上，装不进去。`restrict` 要求 scoped context（`agent.ctx`），所以在 `agent/created` 时对每个 agent 调一次 `restrict({ deny })`——会话每次创建（含冷恢复）都重算，作用域是新建的，不会带着上一次的限制。

**分配**：协调者全有；普通会话没有 `spawn_worker` / `message_worker` / `list_cards`；worker 再少掉项目注册表的五个工具（`list_projects` / `add_project` / `switch_project` / `remove_project` / `init_project`）。`create_card` / `update_card` 对所有会话开放——worker 边干活边把状态写回卡片，普通会话也能为项目登记待办。（2026-11-02 改为只给协调者与 worker，另加执行时身份闸，见 [card-write-tools-scope](../simplification/2026-11-02-card-write-tools-scope.md)。）

**协调者身份在建项目时就定下**。`projects.json` 的 `coordinatorSessionId` 是唯一真源，建项目时自动建的协调者会话直接写进去，不需要运行时从会话内容推断。

**索引重建完成前不裁**。这时注册表里的协调者还没读回内存，问不出答案；返回「不是协调者」会让协调者首轮看不到编排工具，活直接干不成。多给的危害是零——每个工具执行时都按调用方会话再校验一次归属（`update_card` 的跨项目拒绝、`spawn_worker` 的 `directoryOfCoordinator`）。

### 会话折叠复刻官方水位口径

宿主工作区树的折叠函数全是模块私有、不导出（`packages/client/AGENTS.md` 明写 UI plugin 不导出超出 cordis 加载需要的值），只能照同一套口径自己算：默认露出 5 条、每次加 5 条、剩余不足 5 条一次放完、运行中的会话把水位抬到它所在位置（只在前 50 条内生效）、水位只升不降、收起回落到基线、每个项目各自计数、状态留在组件本地不持久化。

**已知差异**：宿主还会为「有子代理在跑」「等你输入」「未读完成」「当前会话」四种注意力抬水位，我们手里只有会话行的 `running`。收起只在全部放完时出现（宿主 `sessionsExpanded = hiddenCount === 0` 也是这么判的），所以会话很多时要连点若干次「展开其余 N 个会话」。

## 证据

mock 实例实测（隔离 `DSH_HOME`，绝不触达真实 API）：三种角色各落一份工具面快照——协调者有 `spawn_worker` / `message_worker` / `list_cards`，普通会话没有，worker 连项目工具也没有。折叠在项目树下实测 5 → 10 条、文案从「展开其余 719 个会话」递减。
