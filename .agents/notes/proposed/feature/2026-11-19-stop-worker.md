# Agent Note: worker 中止工具（`stop_worker`）

Status: proposed

## Problem

leader 能纠偏、不能止损：`message_worker` 的 `steer` 只把消息插进 worker 当前轮的下一步，worker 卡在长工具调用或模型死循环里时要等它自己走到边界；宿主的 `interrupt_agent` 对常驻 worker 是假成功（返回成功回执、实际不停），只能请人打开会话按停止。这与[已知限制的 worker 控制面](../../../../docs/limitations.md#worker-的控制面)一致。

宿主从 `0.2.1-rc.2`（本仓 `engines.dsh` 下限）起就有 `Agent.cancel(cause, options)`，本 bundle 又持有 worker 的 `AgentHandle`：缺的是把它接成模型可调用的工具，不是宿主能力（[能力边界第 13 条](../../../../docs/capability-gaps.md)）。

## Proposal

### 工具契约

| 项 | 设计 |
|---|---|
| 名字 | `stop_worker` |
| 参数 | `sessionId` 必填；`reason` 可选，trim、换行折成空格后 ≤ 200 字符；`discardPending` 可选布尔（默认 false） |
| 授权 | 与 `message_worker` 同一套：调用方是项目 leader、目标在派工登记表里（或本进程 `owners` 兜底）、`parentSessionId` 等于调用方；退役 leader 调用时拒绝 |
| 卡门禁 | 不做。停止不是换卡，卡与槽位都不动 |
| 取 agent | `workerSessions.get(sessionId)?.agent`，否则 `ctx.get('agents').get(sessionId)` |
| 读 | 先读 `agent.status` 与 `agent.inbox.hasPending`，用于回执 |
| 人的轮次 | 见「仍待拍板」第 1 条：建议只在目标本轮由 leader 发起（`inflight` 有记录）或空闲时动作 |
| 动作 | `agent.cancel({ kind: 'hook', reason: 'dsh-leader-agent/stop_worker' + (reason ? ': ' + reason : '') }, { keepInbox: !discardPending })`；`discardPending` 只在 `inflight` 有记录时允许 |
| 返回 | `{ sessionId, name, status: 'stopping' \| 'idle' \| 'not-attached', pending: boolean, droppedPending?: true }` |
| 等待 | 不等 `turn/end`。回执只说「已请求中止」，终态由完成通知确认 |

用 `hook` 而不是 `user` / `parent`：后两者分别代表宿主界面上的停止与父会话取消，插件冒充会污染审计，也让「谁停的」不可判。前缀 `dsh-leader-agent/stop_worker` 是这个 cause 的稳定身份，结算与日志都按它认。

拒绝用 `dispose()` 代替：那是拆会话（停 loop、摘注册表、从活表移除），会丢掉续聊能力，而且只对创建方手里的句柄有效。停止是「这一轮不跑了」，会话要留着。

### 宿主事实（`engines.dsh` 下限 `0.2.1-rc.2`）

- `cancel(cause, options?)` 默认先清空 inbox，再中止当前活动；`{ keepInbox: true }` 只中止活动、保留排队与 steer。空闲时调用不会 arm 后续工作，但 inbox 照样清空。
- cause 取值：`{ kind: 'user' }`、`{ kind: 'parent' }`、`{ kind: 'hook', reason }`、`{ kind: 'disposed' }`；它会原样落进 `turn/end` 的 `reason`，例如 `{"kind":"aborted","reason":{"kind":"hook","reason":"…"}}`。
- 宿主自己的停止按钮走 `sessionController.cancel` → `cancel({ kind: 'user' }, { keepInbox: true })`。
- 取 agent 有两条路：本 bundle 活表里的 `AgentHandle.agent`，以及 `ctx.get('agents').get(sessionId)`（GUI 打开或宿主启动恢复的会话只在后者里）。

**abort 是协作式的，不是硬杀**：宿主工具契约要求异步工作 observe 或 forward `exec.signal`，并在自己持有的工作收敛后才 settle，契约原话明确「it cannot hard-kill same-process code」；批调度只停止尚未开始的调用，已开始的调用会被 drain，未派发的收到 `ABORTED_BEFORE_DISPATCH`；pipeline 也明确「Cancellation never abandons the body」。实际效果：

| 场景 | 结果 |
|---|---|
| 模型正在生成 / step 之间 | signal 下传或每步检查，停在下一个边界 |
| 原生 bash（前台、绑定本轮的 job） | 转发 signal，进程被 kill |
| 不转发 signal 的工具（部分 MCP、in-process 同步长活） | **停不下来**，轮次要等它自己返回 |
| worker 自己 `run_in_background` 甩出的 job | 不随本轮中止，继续跑 |

所以工具只能承诺「已请求中止」，终态仍以 `turn/end` 为准。把「已停止」写进回执，遇到不响应 signal 的工具就是假回执。

`inbox` 待办落在 `agent/inbox/spliced` 事件里，由投影重建，跨重启还在；清空同样是持久 splice，但只有 agent 在本进程 attach 时才够得着——不在内存的会话要冷恢复才能清，而为一个「停止」去建一次 agent 不值得。

### 结算与通知

`turn/end` 是唯一的终态来源，`settleTurn` 已经在这条路径上。改动点：

1. `describeTurnFailure` 认 `aborted` 的 cause：`user` → 被用户中止；`parent` → 被父会话中止；`hook` 且带本工具前缀 → 由 leader 中止（附 reason）；其他 `hook` → 插件中止（附 reason）；`disposed` → 会话被销毁；未知 → 原因未记录。现在只打印 cause 的 `kind`，reason 文本会丢。
2. `settleTurn` 把「aborted + 本工具前缀」记成 `stopped`，而不是 `failed`。
3. `buildNotificationText` / `buildWorkerReport` 按终态分叉：`stopped` 打印「中止原因」而不是「失败原因」，气泡打印「已中止：…」。

leader 收到的通知：

```
任务「impl-cards」已结束。
子会话：worker-…
状态：stopped
中止原因：由 leader 中止（方向错了）
下一步：按 leader 协议判断验收、返工或派新工。
```

`stopped` 的 summary 是中止原因，不是停止前已产出的文本；要看半截产物用 `read_worker_session`。`lastReportAt` 照常更新（结算的既有副作用），卡与槽位不动——停止不等于放弃任务。

### 顺序：先等 `stopped`，再投下一条

同一轮里连续调用 `stop_worker` 与 `message_worker` 看起来「先停再投」，但**不能写进工具描述或使用协议**。

原因：本仓的在飞记录按 session 覆盖——`message` 投递后直接 `inflight.set(sessionId, record)`；旧轮的 `turn/end` 到达时，`settleTurn` 按 session 取到的是**新**记录。于是旧轮结算了新任务、把新任务标成「被取消」，新轮自己的 `turn/end` 找不到记录，结果没有通知（最小探针实测只送达 1 条，期望 2 条）。

**A（本提案）**：`stop_worker` 只请求中止、立刻回执；leader 等这一轮的 `stopped` 完成通知（下一轮）再 `message_worker`。验收必须断言旧轮 `stopped` 与新轮 `completed` 各一条通知，新任务不得被标成 cancelled。这条顺序要写进工具描述，不能只靠文档。

**B（将来）**：若要让 `stop_worker` 自己带 next message、在同一批里完成「停旧轮 + 改方向」，前提是把在飞记录从「按 session 覆盖」改成按 turn 归属（turn 号或队列；[worker 回报投递语义](../architecture/2026-11-03-worker-delivery-idempotency.md)已提出队列化），并补「旧轮 `turn/end` 晚于新记录」的顺序测试；只断言调用顺序不算数。B 落地前不提供 next message 参数。

### 行为矩阵

| 情形 | 动作 | 回执 |
|---|---|---|
| leader 发起的轮次在跑 | cancel（默认 `keepInbox`） | `stopping`，`pending` 如实报告 |
| leader 轮在跑且显式 `discardPending` | cancel（清 inbox） | `stopping`，`droppedPending: true` |
| 空闲、有 pending | cancel（`keepInbox`） | `idle`，pending 保留 |
| 空闲、无 pending | cancel（`keepInbox`） | `idle` |
| 人的轮次在跑 | 拒绝 | 抛错说明 |
| 本进程没有该 agent | 不动作 | `not-attached` |
| 工具不响应 signal | cancel 被接受，轮次仍挂着 | `stopping`；可能没有后续通知 |
| worker 甩出的 background job | 不受影响 | — |

`not-attached` 不能写成「没在跑」：另一个 dsh 进程正在驱动它时本进程就没有 agent，跨进程停止不在本方案里（与 `message_worker` 的 `SessionAlreadyOwnedError` 是同一个边界）。

### inbox：默认不清，清必须显式

`cancel` 不带 `keepInbox` 会清空整个 inbox，而 inbox 不记录消息来源：人下钻插的话与 leader 排的 steer 混在一起，`droppedPending` 只说明「有」，不说明「是谁的」。为了不让人留下的 pending 被顺手丢掉：

- 默认 `{ keepInbox: true }`：只中止当前活动，不清队列；回执用 `pending` 报告是否还有排队消息。
- 只有显式 `discardPending: true` 才调用不带 `keepInbox` 的 `cancel`，且要求 `inflight` 有记录（当前轮由 leader 发起）；回执 `droppedPending: true`。它清的是整个 inbox。
- 没有 `inflight`（空闲、人的轮次、`not-attached`）一律 `keepInbox: true`；`discardPending` 直接拒绝，不把「没有 leader 在飞轮次」当默认清空的理由。
- 即使 `inflight` 存在，pending 也可能混着人的消息；`discardPending` 是调用方的明确选择，不是默认路径。

### 停止后的卡与槽位

停止只中止这一轮，不改卡状态、不动槽位；后续按意图收尾：

- **续跑**：等 `stopped` 通知后 `message_worker` 同一会话（卡仍 active 时带 `cardId`）。
- **放弃**：`update_card` 把卡标 `done`（可逆）或 `archived`（终态）；两者都会清空 `slots`、释放执行者，worker 之后能接新卡。
- **换人重派**：先 `spawn_worker` 拿新会话，再用 `update_card` 整体替换 `slots` 把该槽位指向新会话（其余槽位要一起写全），最后 `message_worker` 带 `cardId` 投递。不能直接对仍绑旧会话的槽位 `spawn_worker`——`bindSlot` 会拒绝，要显式改派；如果先关掉卡再重开，槽位不会恢复，这时要等槽位空出来，再在 `spawn_worker` 里带 `cardId` + `slot`。

`worktree:prune` 清的是本仓已合并的 worktree，与 worker 中止无关。

### 不做的事

- 不拆会话、不删会话日志（`dispose()` 的职责，且宿主没有删除已存在会话的公开 API）。
- 不释放卡槽位，不改卡状态；不跨进程、不处理别的 dsh 实例里的 worker。
- 不硬杀不响应 signal 的进程内代码；也不承诺停掉 worker 甩出的后台 job。
- 不等待 `turn/end`：等就可能被那个不响应 signal 的工具拖住整个工具调用。
- 不冒充 `user` / `parent` cause；B 落地前不提供 next message；不默认清 inbox。

### 仍待拍板

1. **人正在跟 worker 对话的那一轮，leader 能不能停？** 建议拒绝：只停「本轮是 leader 发起（`inflight` 有记录）」或空闲的会话，人开的轮次让那个会话里停。代价是人不在场时那种轮次停不了，而它本来也不是 leader 的活。
2. **停止后是否保留完成通知？** 建议保留：它同时承担清理 `inflight`、更新 `lastReportAt` 的职责，抑制要额外开分支。代价是 leader 先拿工具回执、再收到一条 `stopped` 通知。
3. **终态词用 `stopped` 还是 `aborted`？** 建议 `stopped`（面向 leader 与通知的词汇），`aborted` 留给宿主日志语义。

## Alternatives considered

- **继续只靠 `message_worker` / 让 worker 自己收尾**：steer 要等下一步，卡在长工具调用或死循环时无效；这正是要补的洞。
- **用 `dispose()` 代替停止**：拆会话会丢续聊能力，且只对创建方手里的句柄有效；停止只应结束一轮。
- **冒充 `user` / `parent` cause**：污染审计，且「谁停的」不可判；用 `hook` + 稳定前缀。
- **同一批 `stop_worker` → `message_worker`（B 的简化版）**：在飞记录按 session 覆盖时，旧轮会结算新记录、新轮没有通知；在 B 的前提落地前不可用，A 是唯一安全顺序。
- **默认不带 `keepInbox`、顺手清 inbox**：inbox 没有来源信息，会把人留下的 pending 一起丢掉；改为默认保留、显式 `discardPending`。
- **等 `turn/end` 再回执**：不响应 signal 的工具会把工具调用一起拖住；回执只承诺请求中止。

## Acceptance criteria

- 单测（假 agent 只给 rc.2 已有的面）：非 leader、退役 leader、跨会话、目标不是 worker 都拒绝；running 的 `cancel` 收到 `hook` cause 与 `keepInbox: true`；idle + pending 保留 pending 并回执 `idle`；`discardPending` 在没有 `inflight` 时被拒绝、有 `inflight` 时才清；`not-attached` 不 `resume`、不建会话。
- 结算：hook 前缀 → `stopped` 且 reason 进通知；其他 `hook` 不被误判；气泡文案是「已中止」。
- 顺序 A：`stop_worker` → 收到旧轮 `stopped` 通知 → 下一轮 `message_worker` → 新轮 `completed` 通知；断言两条通知都在，新任务不被标成 cancelled。
- 顺序 B（在飞记录改为按 turn 归属之后才可落地）：旧轮 `turn/end` 晚于新记录时只结算旧记录，新轮自己的 `turn/end` 照常结算；只断言调用顺序不算数。
- 行为矩阵每一行都有对应断言或人工读数。
- 人工 / 真机（mock provider，无付费 API）：长 bash 的 worker 在 `stop_worker` 后进程被 kill，`turn/end` 是 `aborted` + hook，leader 收到 `stopped`；不响应 signal 的假工具只回执 `stopping`，轮次仍挂着。
- 卡与槽位步骤按现状工具跑通：`done` / `archived` 清空槽位；改派后 `message_worker` 首轮带卡片事实。
- `npm run check` 全绿；实现 PR 按本文更新 `usage.md`、`limitations.md`、`capability-gaps.md` 与协议层工具名。

## Risks

- **中止仍是协作式的**：不响应 signal 的工具或 worker 甩出的后台 job 停不下来；没有后续 `turn/end` 时连 `stopped` 通知也不会有，不能把回执当终态。
- **在飞记录仍是按 session 覆盖的**：这正是 B 的前提问题（见 [worker 回报投递语义](../architecture/2026-11-03-worker-delivery-idempotency.md)）；在它落地前，同一批 `stop_worker` → `message_worker` 会抢走新一轮的结算，A 的等待顺序是硬约束。
- **inbox 归属不可判**：即使 `inflight` 存在，pending 也可能混入人的消息；`discardPending` 仍可能丢掉它，所以只做显式选项。
- **跨进程停止不在方案内**：`not-attached` 只说明本进程没有 agent，不能断言 worker 没在跑；另一个 dsh 进程驱动时只能请人去那个会话停。
- **人的轮次被拒绝**：人不在场时，那种轮次停不了；这是为了不误杀人正在进行的对话。
- **本笔记会过期**：实现合入后要把行为边界拆进 usage / limitations / capability-gaps，并按生命周期归档，避免与发布行为漂移。
