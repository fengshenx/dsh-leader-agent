# 续聊消息改走 next-step 边界

**范围**：`src/host/worker-sessions.js`（投递边界）、`src/host/tools/message-worker.js`（回执文案）、`src/host/dispatch.js`（结算记录按身份删除的竞态修复）、`tests/worker-sessions.test.js`、`tests/dispatch.test.js`

## 背景

用户反馈：leader 用 `message_worker` 给正在跑的 worker 发消息，要等下一个 turn 才注入，需要下一步就生效。查证属实，根因是投递边界选错：

- `worker-sessions.send()` 用的是 `agent.followup()`，即 `inbox` 的 **next-turn** 边界——消息排进「下一轮」，与 worker 当前这一轮无关。
- 但 `message_worker` 的回执文案写的是「消息已并入当前任务，随本轮执行一并回报」（`merged`），语义上声明的是并入当前轮次。
- 两者不一致带来两个实际后果：纠偏/返工指令在 worker 忙时白等一整轮；而且 leader 投递时登记的 `inflight` 记录会在**当前轮**的 `turn/end` 上结算成一条「完成通知」，真正执行新消息的那一轮反而不登记——leader 收到的是旧产物的回报。

宿主 agent 的两条边界由 `Agent` 接口写死（rc.2 下限已提供，见宿主的 `packages/core/agent/src/runtime-types.ts`）：

- `followup` = `send(message, 'next-turn', true)`；`steer` = `send(message, 'next-step', true)`；`inject` = 同边界但不唤醒。
- `inbox.claim()` 在**每个 step 开始**取走整个 `next-step` 队列；`next-turn` 只在 turn 边界取一条。
- `steer` 对空闲 driver 会直接开一个 turn（`wakeDriver`），所以冷恢复与首条消息不需要另走 `followup`。

## 决策

**`worker-sessions.send()` 改调 `agent.steer()`，不再用 `followup()`。**

- worker 正在跑：消息插进当前轮次的 `next-step`，模型下一步就看到；本轮结束时只结算一条覆盖了这条消息的完成通知。
- worker 空闲（含刚 `spawn`、冷恢复）：`steer` 的唤醒直接开一轮，这一条成为首步输入，等效于原来的 `followup`，不需要按 `status` 分支。
- 回执码保持不变（会话活着 `merged`、冷恢复 `sent`），只把文案改成「投进当前轮次，下一步生效」，让模型和用户看到的事实与投递边界一致。
- 完成通知（worker → leader）的边界不动：它仍走 `followup` 的 next-turn，且只在父会话空闲时投。那一条是「另一个 turn 的输入」，与续聊的方向相反（[投递边界笔记](../architecture/2026-10-27-worker-report-delivery-boundary.md)）。

### 结算记录按身份删除

next-step 把竞态窗口从「一整轮」缩到「一次落盘」，但没有消掉：`settleTurn` 原先在 `await emitNotification()` 之后无条件 `inflight.delete(sessionId)`。新消息若正好落在 worker 某轮 `turn/end` 之后、结算落盘之前，新登记的在飞记录（以及新轮先产出的文本）会被旧轮一起删掉，执行新消息的那一轮就漏结算。改为只在 `inflight.get(sessionId) === record` 时删除；窗口在 followup 时代就存在，不是本 PR 引入的。

## 边界

- **只在 step 边界生效**：worker 卡在长工具调用里时不会立刻看到消息；本 bundle 也没有中止 worker 的手段，这是宿主的 step 语义，不是投递失败。
- **一条完成通知覆盖合并后的轮次**：纠偏消息与当前任务同轮结束，产物摘要按整轮折叠，不再分别回报两次。
- **被拒绝的 step 会让 steer 留在 inbox**：这是**宿主文档口径**；rc.2 实现待确认——源码是 `inbox.claim()` 之后 reject、整轮直接 `blocked`（`packages/core/agent-loop/src/agent.ts:271,286,319-322`），被领取的 steering 不回到队列。取消或销毁可能丢弃未消费的 steering（宿主文档写明的语义），followup 在同样的取消路径上也会被清空，这里没有新增可观测面。
- **不改变 headless 的结论**：父会话被销毁后仍没有投递载体，续聊与回报都落在落盘/重开路径上。

## 验证

- 回归用例：`tests/worker-sessions.test.js` 的「投递走 steer（next-step 边界），不排 next-turn」——夹具同时记录 `followup` 调用，断言恰好 `['steer']`，live 与冷恢复两条路径都覆盖。
- 新增「续聊并入当前轮：整轮只结算一次，不早报、不重复、不遗漏」：`turn/end` 之前不报，整轮只结算一条，重复 `turn/end` 不再结算。
- 新增「旧轮结算落盘期间投来的新消息，不会被旧轮误删」：卡住落盘、在窗口内投递并让新轮先产出文本，断言旧轮结算后新记录仍在、新轮按自己的文本结算。
- 双向验证：
  - `send()` 改成同时调 `steer` 与 `followup` → 「投递走 steer」在 `methods` 上变红（读到 `['steer', 'followup']`）；还原 → 绿。
  - 去掉 `settleTurn` 的身份比对（无条件删）→ 竞态用例红（旧轮结算后在飞记录为 0，期望 1）；还原 → 绿。
  - 去掉 `inflight.delete`（等价于重复 `turn/end` 会再结算）→ 合并轮用例红（第一次结算后在飞记录仍为 1）；还原 → 绿。
- 全量单测 1103 例（1086 通过 / 17 跳过）通过；`npm run check` 通过文档预算、覆盖率与 Agent Note 格式门禁。
