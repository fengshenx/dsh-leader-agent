# worker 的完成回报由机制侧从会话事件结算

**状态**：implemented（2026-10-29）
**范围**：`src/host/dispatch.js`、`src/host/notification-store.js`、`src/host/tools/gate.js`、`src/host/tools/worker-done.js`（删除）、`src/host/index.js`、`skills/leader-mode/`、`README.md`、`docs/capability-gaps.md`、测试

## 背景

派工上线时的做法是给 worker 一个 `worker_done` 工具，让它收尾时自己交 `{ summary, outcome }`。当时的理由是「根会话没有 `activation.result` 那样的终态 promise，宿主也没留读最后一轮产出的稳定 API」。

这条理由不成立。`session/event` 是公开 emit 事件（回调收到完整 `SessionEvent`），`turn/end` 是真正的 session event 且带终态 `reason.kind`，`sessionQuery.readSession()` 也返回完整事件数组。宿主自己的 subagent 就是这么取产出的（`captureLocalResult()` 用 `finalAssistantOutput(events)` + `epochStopReason(events)`）。

更要紧的是代价：工具式回报把「协调者能不能收到汇报」押在模型记得调工具上，而在飞记录没有任何超时——worker 漏调一次，协调者就干等。

## 决策

**`dispatch.js` 订阅 `ctx.on('session/event', …)`，在 `turn/end` 那一刻结算这一轮。**

- `turn` 是 `agent.run()` 的一次调用，内部含多个 step，所以「一次派工 = 一个 `turn/end`」；轮次内的 `assistant/message` 事件携带 `data.message.content` 块数组，同一 turn 取最后一条非空文本当摘要。
- 终态用 `reason.kind`：`completed` 判成功；`aborted` / `blocked` / `error` / `max-tokens` / `interrupted` 判失败，摘要改写成对应原因而不是半截产物——失败轮次的 assistant 文本往往只写到一半，拿它当摘要会让协调者高估这一轮。
- 归属判据不变：只有 `inflight` 里有记录的会话才结算，人直接跟 worker 聊的轮次根本进不了这张表。
- 投递层完全复用：`emitNotification` → 落盘队列 → 父会话空闲时 `agent.followup()`。

`worker_done` 工具、`WORKER_ONLY_TOOLS`、协议层「每轮必须调一次」的指令一并删掉。`restrict()` 对未注册的工具名直接抛错，所以 `gate.js` 的三处 deny 列表必须同步改。

## 边界

- **订阅是版本契约，不是装配期能力探测**：cordis 的 `Context` 永远有 `on`（返回 disposer），所以探测 `typeof ctx.on` 在哪个宿主上都不会触发；`engines.dsh` 下限 rc.2 已提供 `session/event` 与 `turn/end`，低于下限的宿主只会静默订阅一个没人 emit 的名字。这是版本契约问题，写在 `engines.dsh` 里，不在装配期判定。
- **结算绑在 `turn/end`**：进程在轮次结束前被杀，那一轮就不结算（在飞表在内存里，重启即空）。这是用机制换来的确定性代价——相比「模型漏调」，它只在进程崩溃时发生，而且重启后人能看到 worker 会话还在。
- **落盘即结算成功，摘要冻结进记录**：第一次结算就把摘要与终态写进在飞记录；`enqueue` 成功后才删记录。落盘失败时记录与冻结的摘要都还在，该 worker 下一轮结束时重试**这一轮**的内容——下一轮的 `assistant/message` 只会覆盖新轮次的文本，不会改写已冻结的摘要。投递（`followup` / `markDelivered`）失败不撤销结算：通知已经落盘，重复结算会再唤醒父会话一次，第二条还可能是新一轮产物被误标成这一轮。
- **通知按 id 幂等**：`note-<child>-<startedAt>` 在同一次结算里稳定，`enqueue` 按 id 去重，重试不会多出一条。
- **同一轮只结算一次**：结算即从 `inflight` 删除，后续 `turn/end` 可得 `false`（inbox 还有消息时会连着跑多个 turn，每个都会触发一次 `turn/end`）。
- **同一 worker 的上一轮没结束时再派工，两轮只结算一次**：在飞记录按会话 id 存在，新一轮的 `message_worker` 会覆盖它——第一轮的 `turn/end` 结算的是第二条记录（正文是第一轮产物），第二轮的 `turn/end` 找不到记录。`worker_done` 时代行为相同，不是本机制引入的；要修得把在飞记录改成按会话排队。
- **只给在飞会话攒文本**：`assistant/message` 的采集判据是「`inflight` 有记录」。它守的是两件事：不给全进程每个会话攒文本（内存收敛），以及不把人在 worker 会话里自己聊的内容当成派工产物——人那一轮的文本若被攒下来，紧跟着的派工轮在没产出文本时就会误用它当摘要。
- **不能依赖宿主的 `finalAssistantOutput`**：那是内部包导出，本仓对 dsh 没有依赖（peer 依赖禁令）。折叠逻辑自己写，量只有「拼 text 块 + 映射 `reason.kind`」。
- **摘要取不到时的兜底**：这一轮只调了工具没说话时文本为空，通知正文如实写「（worker 未产出文本）」，不编造。

宿主侧的能力事实见 [能力第 39 条](../../../../docs/capability-gaps.md)。
