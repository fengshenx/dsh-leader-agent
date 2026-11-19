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
| 参数 | `sessionId` 必填；`reason` 可选，trim、换行折成空格后 ≤ 200 字符；`discardPending` 可选布尔（默认 false，必须在 stop 调用当时决定） |
| 授权 | 与 `message_worker` 同一套：调用方是项目 leader、目标在派工登记表里（或本进程 `owners` 兜底）、`parentSessionId` 等于调用方；退役 leader 调用时拒绝 |
| 卡门禁 | 不做。停止不是换卡，卡与槽位都不动 |
| 取 agent | `workerSessions.get(sessionId)?.agent`，否则 `ctx.get('agents').get(sessionId)` |
| 读 | 先读 `agent.status` 与 `agent.inbox.hasPending`，用于回执 |
| 人的轮次 | 见「仍待拍板」第 1 条：建议只在目标本轮由 leader 发起（`inflight` 有记录）或空闲时动作 |
| 动作 | `agent.cancel({ kind: 'hook', reason: 'dsh-leader-agent/stop_worker' + (reason ? ': ' + reason : '') }, { keepInbox: !discardPending })`；`discardPending` 只在 `inflight` 有记录时允许 |
| 返回 | `{ sessionId, name, status: 'stopping' \| 'idle' \| 'not-attached', pending: boolean, droppedPending?: true }` |
| 等待 | 不等 `turn/end`。回执只说「已请求中止」；超过既有 stall 阈值仍无完成通知，按巡查 / `read_worker_session` 处理，不把回执当终态 |

用 `hook` 而不是 `user` / `parent`：后两者分别代表宿主界面上的停止与父会话取消，插件冒充会污染审计，也让「谁停的」不可判。前缀 `dsh-leader-agent/stop_worker` 是这个 cause 的稳定身份，结算与日志都按它认。

拒绝用 `dispose()` 代替：那是拆会话（停 loop、摘注册表、从活表移除），会丢掉续聊能力，而且只对创建方手里的句柄有效。停止是「这一轮不跑了」，会话要留着。

### 宿主事实（`engines.dsh` 下限 `0.2.1-rc.2`）

- `cancel(cause, options?)` 默认先清空 inbox，再中止当前活动；`{ keepInbox: true }` 只中止活动、保留排队与 steer。空闲时调用不会 arm 后续工作，但 inbox 照样清空。
- cause 取值：`{ kind: 'user' }`、`{ kind: 'parent' }`、`{ kind: 'hook', reason }`、`{ kind: 'disposed' }`；它会原样落进 `turn/end` 的 `reason`，例如 `{"kind":"aborted","reason":{"kind":"hook","reason":"…"}}`。宿主自己的停止按钮走 `cancel({ kind: 'user' }, { keepInbox: true })`。
- **abort 是协作式的，不是硬杀**：宿主工具契约要求异步工作 observe/forward `exec.signal`，不能 hard-kill 同进程代码；批调度只停尚未开始的调用，已开始的会被 drain；pipeline 也明确不 abandon 已启动的 body。结果是模型生成/step 边界能断、原生 bash 转发 signal 能 kill、不转发 signal 的工具停不下来、worker 甩出的 background job 不随本轮中止。
- `inbox` 待办落在 `agent/inbox/spliced` 事件里，跨重启还在；清空也是持久 splice，但只有 agent 在本进程 attach 时才够得着——为一个「停止」去冷恢复不值得。

所以工具只能承诺「已请求中止」，终态仍以 `turn/end` 为准。把「已停止」写进回执，遇到不响应 signal 的工具就是假回执。

### 结算与通知

`turn/end` 是唯一的终态来源，`settleTurn` 已经在这条路径上。改动点：`describeTurnFailure` 认出 `aborted` 的 cause（`user` / `parent` / `hook` + 本工具前缀 / 其他 `hook` / `disposed` / 未知），把 reason 带进通知；`settleTurn` 把「aborted + 本工具前缀」记成 `stopped` 而不是 `failed`；`buildNotificationText` / `buildWorkerReport` 按终态分叉，通知写「状态：stopped / 中止原因」与「已中止：…」气泡。

`stopped` 的 summary 是中止原因，不是停止前已产出的文本；要看半截产物用 `read_worker_session`。`lastReportAt` 照常更新（结算的既有副作用），卡与槽位不动——停止不等于放弃任务。

### 顺序：先等 `stopped`，再投下一条

同一轮里连续调用 `stop_worker` 与 `message_worker` 看起来「先停再投」，但**不能写进工具描述或使用协议**。原因：本仓的在飞记录按 session 覆盖——`message` 投递后直接 `inflight.set(sessionId, record)`；旧轮的 `turn/end` 到达时，`settleTurn` 按 session 取到的是**新**记录。于是旧轮结算了新任务、把新任务标成「被取消」，新轮自己的 `turn/end` 找不到记录，结果没有通知（最小探针实测只送达 1 条，期望 2 条）。

**A（本提案）**：`stop_worker` 只请求中止、立刻回执；leader 等这一轮的 `stopped` 完成通知（下一轮）再 `message_worker`。验收必须断言旧轮 `stopped` 与新轮 `completed` 各一条通知，新任务不得被标成 cancelled。这条顺序写进工具描述，不能只靠文档。**A 依赖「停止后仍发完成通知」**（见「仍待拍板」第 2 条）：没有这条通知，leader 就没有「旧轮已结算」的信号。

**B（将来）**：若要让 `stop_worker` 自己带 next message、在同一批里完成「停旧轮 + 改方向」，前提是把在飞记录从「按 session 覆盖」改成按 turn 归属（turn 号或队列；[worker 回报投递语义](../architecture/2026-11-03-worker-delivery-idempotency.md)已提出队列化），并补「旧轮 `turn/end` 晚于新记录」的顺序测试；只断言调用顺序不算数。B 落地前不提供 next message 参数。

### 行为矩阵

| 情形 | 动作 | 回执 |
|---|---|---|
| leader 发起的轮次在跑 | cancel（默认 `keepInbox`） | `stopping`，`pending` 如实报告 |
| leader 轮在跑、stop 当时显式 `discardPending` | cancel（清 inbox） | `stopping`，`droppedPending: true` |
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
- **保留不是无损的**：旧消息会在下一轮被唤醒时一起消费——A 顺序里的 `message_worker` 就会触发，旧 steer 会和新指令一起进上下文。要连排队一起停，只能在 stop 调用当时带 `discardPending: true`。
- **`discardPending` 的时机**：它只在 `inflight` 存在时允许；等 `stopped` 通知后 `inflight` 已被 `settleTurn` 清掉，再传会被拒绝。所以「停这一轮也停排队」必须在 stop 当时决定，不能等通知。
- 只有显式 `discardPending: true` 才调用不带 `keepInbox` 的 `cancel`，且要求 `inflight` 有记录；回执 `droppedPending: true`，清的是整个 inbox。没有 `inflight`（空闲、人的轮次、`not-attached`）一律拒绝 `discardPending`。
- 即使 `inflight` 存在，pending 也可能混着人的消息；`discardPending` 是调用方的明确选择，不是默认路径。

### 停止后的卡与槽位

停止只中止这一轮，不改卡状态、不动槽位；后续按意图收尾：

- **续跑**：等 `stopped` 通知后 `message_worker` 同一会话（卡仍 active 时带 `cardId`）。注意 inbox 里若还有旧消息，这一轮会一起消费，见上一节。
- **放弃**：`update_card` 把卡标 `done`（可逆）或 `archived`（终态）。这会清空**全部** `slots`，不是只清目标槽位；同次再带非空槽位会被工具拒绝。只想换掉一个槽位、保留 review 等其他槽位时，不要用关闭卡，改走下面的显式改派。
- **换人重派**：先 `spawn_worker` 拿新会话，再用 `update_card` 整体替换 `slots` 把目标槽位指向新会话（其余槽位要一起写全），最后 `message_worker` 带 `cardId` 投递。槽位仍绑旧会话时直接 `spawn_worker` 会被 `bindSlot` 拒绝；关掉再重开也不会恢复任何槽位。

`worktree:prune` 清的是本仓已合并的 worktree，与 worker 中止无关。

### 不做的事

- 不拆会话、不删会话日志（`dispose()` 的职责，且宿主没有删除已存在会话的公开 API）；不释放卡槽位、不改卡状态。
- 不跨进程、不处理别的 dsh 实例里的 worker；不硬杀不响应 signal 的进程内代码，也不承诺停掉 worker 甩出的后台 job。
- 不等待 `turn/end`；不冒充 `user` / `parent` cause；B 落地前不提供 next message；不默认清 inbox。

### 仍待拍板

1. **人正在跟 worker 对话的那一轮，leader 能不能停？** 建议拒绝：只停「本轮是 leader 发起（`inflight` 有记录）」或空闲的会话，人开的轮次让那个会话里停。代价是人不在场时那种轮次停不了。
2. **停止后是否保留完成通知？** 这不是偏好：**A 顺序靠这条通知当「旧轮已结算」的信号**，清理 `inflight`、更新 `lastReportAt` 也在同一条路径。建议保留；若否决，A 不成立，要么另造等价信号，要么等 B 的 turn 归属落地。
3. **终态词用 `stopped` 还是 `aborted`？** 建议 `stopped`（面向 leader 与通知的词汇），`aborted` 留给宿主日志语义。

## Alternatives considered

- **继续只靠 `message_worker` / 让 worker 自己收尾**：steer 要等下一步，卡在长工具调用或死循环时无效；这正是要补的洞。
- **用 `dispose()` 代替停止**：拆会话会丢续聊能力，且只对创建方手里的句柄有效；停止只应结束一轮。
- **同一批 `stop_worker` → `message_worker`（B 的简化版）**：在飞记录按 session 覆盖时，旧轮会结算新记录、新轮没有通知；在 B 的前提落地前不可用，A 是唯一安全顺序。
- **默认不带 `keepInbox`、顺手清 inbox**：inbox 没有来源信息，会把人留下的 pending 一起丢掉；改为默认保留、显式 `discardPending`。

## Acceptance criteria

- 单测（假 agent 只给 rc.2 已有的面）：非 leader、退役 leader、跨会话、目标不是 worker 都拒绝；running 的 `cancel` 收到 `hook` cause 与 `keepInbox: true`；idle + pending 保留 pending 并回执 `idle`；`discardPending` 在没有 `inflight` 时被拒绝、有 `inflight` 时才清；`not-attached` 不 `resume`、不建会话。
- 结算：hook 前缀 → `stopped` 且 reason 进通知；其他 `hook` 不被误判；气泡文案是「已中止」。
- 顺序 A：`stop_worker` → 收到旧轮 `stopped` 通知 → 下一轮 `message_worker` → 新轮 `completed` 通知；断言两条通知都在，新任务不被标成 cancelled。若完成通知被抑制，A 用例不成立，必须先解决信号来源。
- 顺序 B（在飞记录改为按 turn 归属之后才可落地）：旧轮 `turn/end` 晚于新记录时只结算旧记录，新轮自己的 `turn/end` 照常结算；只断言调用顺序不算数。
- 行为矩阵每一行都有对应断言或人工读数；不响应 signal 的工具超过 stall 阈值无通知时，按 `read_worker_session` / 巡查处理，不把回执当终态。
- 卡与槽位步骤按现状工具跑通：关闭卡清空**全部** slots、同次带槽位被拒；改派后 `message_worker` 首轮带卡片事实。
- `npm run check` 全绿；实现 PR 按本文更新 `usage.md`、`limitations.md`、`capability-gaps.md` 与协议层工具名。

## Risks

- **中止仍是协作式的**：不响应 signal 的工具或 worker 甩出的后台 job 停不下来；没有后续 `turn/end` 时连 `stopped` 通知也不会有。超过既有 stall 阈值仍无通知时，用 `read_worker_session` 回看现场、按巡查提醒请人处理，**不要把工具回执当终态**。
- **在飞记录仍是按 session 覆盖的**：这正是 B 的前提问题（见 [worker 回报投递语义](../architecture/2026-11-03-worker-delivery-idempotency.md)）；在它落地前，同一批 `stop_worker` → `message_worker` 会抢走新一轮的结算，A 的等待顺序是硬约束。
- **inbox 归属不可判**：即使 `inflight` 存在，pending 也可能混入人的消息；`discardPending` 仍可能丢掉它，所以只做显式选项。默认 `keepInbox` 又会让旧消息在下一轮被消费——stop 之后一定要处理 `pending` 回执，不能假设队列已空。
- **跨进程停止不在方案内**：`not-attached` 只说明本进程没有 agent，不能断言 worker 没在跑；另一个 dsh 进程驱动时只能请人去那个会话停。
- **人的轮次被拒绝**：人不在场时，那种轮次停不了；这是为了不误杀人正在进行的对话。
- **本笔记会过期**：实现合入后要把行为边界拆进 usage / limitations / capability-gaps，并按生命周期归档，避免与发布行为漂移。
