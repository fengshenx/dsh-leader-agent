# Agent Note: worker 的完成回报由机制侧从会话事件结算

Status: implemented

## Problem

派工上线时给 worker 一个 `worker_done` 工具，让它收尾时自己交 `{ summary, outcome }`，理由是「根会话没有终态 promise，宿主也没留读最后一轮产出的稳定 API」。这条理由不成立：`session/event` 是公开事件、`turn/end` 带终态 `reason.kind`，宿主自己的 subagent 也这么取产出。代价还很大——工具式回报把「协调者能不能收到汇报」押在模型记得调工具上，而在飞记录没有超时，漏调一次协调者就干等。

## Decision

- **`dispatch.js` 订阅 `session/event`，在 `turn/end` 那一刻结算这一轮**：`turn` 是 `agent.run()` 的一次调用、内部含多个 step，所以「一次派工 = 一个 `turn/end`」；同一 turn 取最后一条非空 assistant 文本当摘要。
- **终态用 `reason.kind`**：`completed` 判成功；`aborted` / `blocked` / `error` / `max-tokens` / `interrupted` 判失败，摘要改写成对应原因而不是半截产物——失败轮次的文本往往只写到一半，拿它当摘要会让协调者高估这一轮。
- **归属判据不变**：只有 `inflight` 里有记录的会话才结算，人直接跟 worker 聊的轮次根本进不了这张表。
- **投递层完全复用**：`emitNotification` → 落盘队列 → 父会话空闲时 `agent.followup()`。
- **`worker_done`、`WORKER_ONLY_TOOLS`、协议层「每轮必须调一次」一并删除**，`restrict()` 对未注册工具名直接抛错，所以 deny 列表必须同步改。

## Alternatives considered

- **保留 `worker_done` 工具自报**：把「协调者能否收到回报」押在模型记得调工具上，漏调一次就干等；`turn/end` 是宿主公开的轮次终态，机制侧结算更可靠。
- **用 `Session.snapshotEvents` / `sessionQuery.observeSession()` / 宿主 `finalAssistantOutput`**：前者已标废弃、中者只返回会话头、后者是内部包导出；本仓零宿主依赖，自己折叠 `turn/end`。

## Consequences

- **订阅是版本契约，不是装配期能力探测**：cordis 的 `Context` 永远有 `on`，探测在哪个宿主上都不会触发；低于 `engines.dsh` 下限的宿主只会静默订阅一个没人 emit 的名字。
- **结算绑在 `turn/end`**：进程在轮次结束前被杀，那一轮就不结算（在飞表在内存里，重启即空）。这是用机制换来的确定性代价——相比「模型漏调」，它只在进程崩溃时发生，且重启后人能看到 worker 会话还在。
- **落盘即结算成功，摘要冻结进记录**：第一次结算就把摘要与终态写进在飞记录，`enqueue` 成功后才删记录；落盘失败时记录与冻结的摘要都还在，下一轮结束时重试**这一轮**的内容，新轮次的文本不会改写它。投递（`followup` / `markDelivered`）失败不撤销结算：通知已落盘，重复结算会再唤醒父会话一次。
- **通知按 id 幂等**：`note-<child>-<startedAt>` 在同一次结算里稳定，`enqueue` 按 id 去重，重试不会多出一条。
- **同一轮只结算一次**：结算即从在飞表删除，后续 `turn/end` 得 `false`（inbox 还有消息时会连着跑多个 turn）。
- **同一 worker 上一轮未结束时再派工，两轮只结算一次**：在飞记录按会话 id 存在，新一轮的 `message_worker` 会覆盖它；要修得把在飞记录改成按会话排队（见[投递语义提案](../../proposed/architecture/2026-11-03-worker-delivery-idempotency.md)）。
- **只给在飞会话攒文本**：既收敛内存，也不把人在 worker 会话里自己聊的内容当成派工产物。
- **不能依赖宿主的 `finalAssistantOutput`**（内部包导出，本仓对 dsh 零依赖），折叠逻辑自己写，量只有「拼 text 块 + 映射 `reason.kind`」。
- **摘要取不到时如实写「（worker 未产出文本）」**，不编造。

宿主侧的能力事实见[能力第 39 条](../../../../docs/capability-gaps.md)。

收益：完成回报不再依赖模型自律，失败轮次也能带着真实终态回到 leader。

## Testing

`tests/dispatch-continuation.test.js` 与 `tests/dispatch.test.js` 钉住结算、幂等与摘要冻结。双向读数：撤掉在飞归属判据，人直聊的轮次也会被结算而变红；把 `turnText` 的清理挪到 `emitNotification` 之后，落盘失败重试用例读到摘要串轮而变红。
