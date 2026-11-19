# worker 中止（`stop_worker`）方案

本文件是 `stop_worker` 的设计与实施计划，不描述已发布行为：除「宿主事实」一节外都是待实现的决定。实现合入后，行为边界拆进[使用手册](usage.md)、[已知限制](limitations.md)与[能力边界](capability-gaps.md)，本页删除。

## 问题

leader 能纠偏、不能止损。纠偏走 `message_worker` 的 `steer`：消息插进 worker 当前轮次的下一步，但 worker 卡在长工具调用或模型死循环里时，这条指令要等它自己走到边界才生效。现在唯一的止损方式是请人打开那个会话按停止，巡查提醒也只能提醒。

宿主从 `0.2.1-rc.2` 起就有 `Agent.cancel(cause, options)`（本仓 `engines.dsh` 下限即该版本），本 bundle 又持有 worker 的 `AgentHandle`——没有接成工具是本 bundle 的缺口，不是宿主能力缺失（[能力边界第 13 条](capability-gaps.md)）。

## 宿主事实

### cancel 的语义

签名是 `cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void`，实现在 agent-loop 的 `Agent` 上：

- 默认先清空 inbox，再中止当前活动；`{ keepInbox: true }` 只中止活动、保留排队与 steer。
- 空闲时调用不会 arm 后续工作，但 inbox 照样清空（清空是独立的持久动作）。
- cause 的取值：`{ kind: 'user' }`、`{ kind: 'parent' }`、`{ kind: 'hook', reason: string }`、`{ kind: 'disposed' }`。
- cause 会原样落进 `turn/end` 的 `reason`：`{"kind":"aborted","reason":{"kind":"hook","reason":"…"}}`，是持久的事实。
- 宿主自己的停止按钮走 `sessionController.cancel` → `cancel({ kind: 'user' }, { keepInbox: true })`。
- 取 agent 有两条路：本 bundle 活表里的 `AgentHandle.agent`，以及 `ctx.get('agents').get(sessionId)`（GUI 打开或宿主启动恢复的会话只在后者里）。

### abort 是协作式的，不是硬杀

三处独立证据：

- **工具契约**（`packages/core/tools/src/contracts.ts`）：异步工作必须 observe 或 forward `exec.signal`，并在自己持有的工作收敛后才 settle；契约原话明确「it cannot hard-kill same-process code」。
- **批调度**（`packages/core/tools/src/batch.ts`）：abort 只停止尚未开始的调用，已开始的调用会被 drain，之后这一轮才收尾；未派发的调用收到合成结果 `ABORTED_BEFORE_DISPATCH`。
- **dispatch**（`packages/core/tools/src/pipeline.ts`）：「Cancellation never abandons the body: a started promise reaches quiescence before its outcome becomes `ABORTED`」。

实际效果：

| 场景 | 结果 |
|---|---|
| 模型正在生成 | signal 随请求下传（以 DeepSeek 适配器为例），流被中断，下一个边界退出 |
| 模型循环 / step 之间 | 每步检查 `signal.throwIfAborted()`，停在下一个边界 |
| 原生 bash（前台、绑定本轮的 job） | 转发 signal，进程被 kill |
| 不转发 signal 的工具（部分 MCP、in-process 同步长活） | **停不下来**，轮次要等它自己返回 |
| worker 自己 `run_in_background` 甩出的 job | 不随本轮中止，继续跑 |

所以工具只能承诺「已请求中止」，终态仍以 `turn/end` 为准。这不是措辞洁癖：把「已停止」写进回执，遇到不响应 signal 的工具就是假回执。

### inbox 是持久化的

待办消息落在 `agent/inbox/spliced` 事件里，由投影重建，跨重启还在。清空同样写 splice，是持久动作；但只有 agent 在本进程 attach 时才够得着——不在内存的会话要冷恢复才能清，而为一个「停止」去建一次 agent 不值得。

## 方案

### 工具契约

| 项 | 设计 |
|---|---|
| 名字 | `stop_worker` |
| 参数 | `sessionId` 必填；`reason` 可选字符串，trim、换行折成空格后 ≤ 200 字符 |
| 授权 | 与 `message_worker` 同一套：调用方是项目 leader、目标在派工登记表里（或本进程 `owners` 兜底）、`parentSessionId` 等于调用方；退役 leader 调用时拒绝 |
| 卡门禁 | 不做。停止不是换卡，卡与槽位都不动 |
| 取 agent | `workerSessions.get(sessionId)?.agent`，否则 `ctx.get('agents').get(sessionId)` |
| 读 | 先读 `agent.status` 与 `agent.inbox.hasPending`，用于回执 |
| 人的轮次 | 见「待拍板」第 1 条：默认只在目标本轮由 leader 发起或空闲时动作 |
| 动作 | `agent.cancel({ kind: 'hook', reason: 'dsh-leader-agent/stop_worker' + (reason ? ': ' + reason : '') })`，不带 `keepInbox` |
| 返回 | `{ sessionId, name, status: 'stopping' \| 'idle' \| 'not-attached', droppedPending }` |
| 等待 | 不等 `turn/end`。回执说「已请求中止」，终态由完成通知确认 |

用 `hook` 而不是 `user` / `parent`：后两者分别代表宿主界面上的停止与父会话取消，插件冒充会污染审计，也让「谁停的」不可判。前缀 `dsh-leader-agent/stop_worker` 是这个 cause 的稳定身份，结算与日志都按它认。

拒绝用 `dispose()` 代替：那是拆会话（停 loop、摘注册表、从活表移除），会丢掉续聊能力，而且只对创建方手里的句柄有效。停止是「这一轮不跑了」，会话要留着。

### 结算与通知

`turn/end` 是唯一的终态来源，`settleTurn` 已经在这条路径上。改动点：

1. `describeTurnFailure` 认 `aborted` 的 cause：`user` → 被用户中止；`parent` → 被父会话中止；`hook` 且带本工具前缀 → 由 leader 中止（附 reason）；其他 `hook` → 插件中止（附 reason）；`disposed` → 会话被销毁；未知 → 原因未记录。现在只打印 cause 的 `kind`，reason 文本会丢。
2. `settleTurn` 把「aborted + 本工具前缀」记成 `stopped`，而不是 `failed`。
3. `buildNotificationText` / `buildWorkerReport` 按终态分叉：`stopped` 打印「中止原因」而不是「失败原因」，气泡打印「已中止：…」而不是「失败：…」。

leader 收到的通知：

```
任务「impl-cards」已结束。
子会话：worker-…
状态：stopped
中止原因：由 leader 中止（方向错了）
下一步：按 leader 协议判断验收、返工或派新工。
```

`stopped` 的 summary 是中止原因，不是停止前已产出的文本；要看半截产物用 `read_worker_session`。`lastReportAt` 照常更新（结算的既有副作用），卡与槽位不动——停止不等于放弃任务，关卡、重绑还是续派由 leader 决定。

### 顺序约束

同一批工具调用按模型顺序串行执行（本 bundle 的工具都没声明可并行），所以：

- `stop_worker` → `message_worker`：先停旧轮，再投新指令。abort 尚未收敛时 `steer` 会被宿主重分类到 next-turn 并 latch，收敛后自动开新一轮。
- 反过来：新指令刚进 inbox 就被停止清掉，leader 看到的是「投递成功」，实际什么都没跑。

这条要写进工具描述，不能只靠文档。

### 行为矩阵

| 情形 | 动作 | 回执 |
|---|---|---|
| leader 发起的轮次在跑 | cancel | `stopping` |
| 空闲但有 pending | cancel（清 inbox） | `idle`，`droppedPending: true` |
| 空闲无 pending | cancel（no-op） | `idle` |
| 本进程没有该 agent（没在跑，或被另一个 dsh 进程驱动） | 不动作 | `not-attached` |
| 人的轮次在跑（见「待拍板」） | 拒绝 | 抛错说明 |
| 工具不响应 signal | cancel 被接受，轮次仍挂着 | `stopping`；没有后续通知 |
| worker 甩出的 background job | 不受影响 | — |

`not-attached` 不能写成「没在跑」：另一个 dsh 进程正在驱动它时本进程就没有 agent，跨进程停止不在本方案里（与 `message_worker` 的 `SessionAlreadyOwnedError` 是同一个边界）。

### 不做的事

- 不拆会话、不删会话日志（`dispose()` 的职责，且宿主没有删除已存在会话的公开 API）。
- 不释放卡槽位，不改卡状态。
- 不跨进程、不处理别的 dsh 实例里的 worker。
- 不硬杀不响应 signal 的进程内代码；也不承诺停掉 worker 甩出的后台 job。
- 不等待 `turn/end`：等就可能被那个不响应 signal 的工具拖住整个工具调用。
- 不冒充 `user` / `parent` cause。

## 待拍板

1. **人正在跟 worker 对话的那一轮，leader 能不能停？** 建议拒绝：只停「本轮是 leader 发起（`inflight` 有记录）」或空闲的会话，人开的轮次让那个会话里停。理由是 worker 会话人也能打开，leader 误杀人正在进行的对话代价大；代价是人不在场时那种轮次停不了，而它本来也不是 leader 的活。
2. **停止后是否保留完成通知？** 建议保留：它同时承担清理 `inflight`、更新 `lastReportAt` 的职责，抑制要额外开分支。代价是 leader 先拿工具回执、再收到一条 `stopped` 通知。
3. **终态词用 `stopped` 还是 `aborted`？** 建议 `stopped`（面向 leader 与通知的词汇），`aborted` 留给宿主日志语义。

## 实施拆分

1. **宿主侧**：新增 `src/host/tools/stop-worker.js`，`dispatcher` 加 `stopWorker()`（复用 `message` 的授权与归属查询），`worker-sessions.js` 加 `cancel()`，`src/host/index.js` 注册工具并加进 leader 工具面。
2. **结算**：按「结算与通知」一节改 `describeTurnFailure` / `settleTurn` / `buildNotificationText` / `buildWorkerReport`。
3. **文档**：`limitations.md` 的 worker 控制面、`capability-gaps` 第 13 条、`usage.md`、`leader-mode` 的 SKILL 与 playbook、`worker-stall.js` 的提醒文案一起改。协议层（`.agents/skills/`）里反引号写的工具名受门禁比对，漏改 `npm run check` 会红；`docs/` 下的说明不受这道门禁管，但同样要改。
4. **测试**：见下。

## 测试计划

单测（`node:test`，假 agent 只给 rc.2 就有的面）：

- 授权：非 leader、退役 leader、跨会话、目标不是 worker 都拒绝。
- running：`cancel` 收到 `{ kind: 'hook', reason: 'dsh-leader-agent/stop_worker: …' }`，回执 `stopping`。
- idle + pending：`cancel` 仍被调用，`droppedPending: true`。
- idle 无 pending：回执 `idle`，不产生通知。
- `not-attached`：不 `resume`、不建会话。
- 结算：hook 前缀 → `stopped` 且 reason 进通知；其他 hook 不被误判；气泡文案是「已中止」。
- 停止后 `message_worker`：验证 `steer` 在 abort 窗口被 latch 到下一轮（断言调用顺序，不依赖真实时序）。

人工/真机（mock provider，无付费 API）：

- 长 bash 的 worker：`stop_worker` 后进程被 kill，`turn/end` 是 `aborted` + hook，leader 收到 `stopped` 通知。
- 不响应 signal 的假工具：回执 `stopping` 但轮次仍挂着——用来钉住「请求中止 ≠ 已停止」的说法。

双向验证：去掉 hook 前缀识别 → `stopped` 用例变红；去掉授权 → 越权用例变红；还原后全绿。

## 验收标准

- 行为矩阵每一行都有对应断言或人工读数。
- stop 到 `turn/end` 的耗时在正常工具与 bash 两种场景下有真机读数；不响应 signal 的反例如实记录。
- `npm run check` 全绿。
- 文档同步完成，协议层不再出现「本流程没有中止手段」。
