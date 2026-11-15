# Agent Note: 续聊消息改走 next-step 边界

Status: implemented

## Problem

leader 用 `message_worker` 给正在跑的 worker 发消息，要等下一个 turn 才注入。原因是投递边界选错：`send()` 用的是 next-turn 边界，而回执文案声明的是「并入当前轮次」。后果是纠偏/返工指令白等一整轮，而且 leader 投递时登记的记录会在当前轮结算成「完成通知」——真正执行新消息的那一轮反而不登记，leader 收到的是旧产物的回报。

## Decision

**`send()` 改调 `agent.steer()`，不再用 `followup()`。** worker 正在跑时消息插进当前轮次的 next-step，模型下一步就看到，本轮只结算一条覆盖了这条消息的完成通知；worker 空闲（含刚 `spawn`、冷恢复）时 `steer` 的唤醒直接开一轮，这条成为首步输入，等效于原来的 `followup`，所以不需要按状态分支。回执码不变（活着 `merged`、冷恢复 `sent`），只把文案改成「投进当前轮次，下一步生效」，让界面与投递边界一致。

**完成通知的边界不动。** 它仍走 next-turn、且只在父会话空闲时投递——那是「另一个 turn 的输入」，与续聊方向相反（见 [投递边界](../architecture/2026-10-27-worker-report-delivery-boundary.md)）。

**结算与轮次文本都按在飞记录归属。** next-step 把竞态窗口从一整轮缩到一次落盘，但没消掉：结算落盘期间投来的新消息，会被旧轮的无条件删除一起删掉，执行新消息的那一轮就漏结算——所以只在记录仍是当前那条时才删。轮次文本也记在各自的在飞记录上，否则新轮只落空 assistant 消息时会拿到旧轮文本、把旧产物标成新轮产物；覆盖记录时只在旧记录尚未冻结（摘要为空）时承接文本——合并轮保留消息前已产出的内容，窗口里的新轮从空白开始。

## Alternatives considered

- **继续用 `followup`（next-turn）**：纠偏指令白等一整轮，leader 还会先收到旧产物的完成通知；改走 `steer` 的 next-step。
- **按 worker 状态在 `steer` / `followup` 间分支**：空闲时 `steer` 会直接开一轮、等效于 `followup`，分支没有收益。
- **结算后无条件删在飞记录**：落盘期间投来的新消息会被一起删掉，新轮漏结算；只在记录仍是当前那条时删。
- **新轮承接旧轮文本**：新轮只落空 assistant 消息时会拿到旧产物；只在旧记录未冻结时承接。

## Consequences

- **只在 step 边界生效**：worker 卡在长工具调用里时不会立刻看到消息；本 bundle 也没有中止 worker 的手段，这是宿主的 step 语义，不是投递失败。
- **一条完成通知覆盖合并后的轮次**：纠偏消息与当前任务同轮结束，产物摘要按整轮折叠，不分别回报两次。
- **被拒绝的 step 会让 steer 留在 inbox 是宿主文档口径**，下限版本的实现与文档不一致（领取之后 reject、整轮直接 blocked），待上游确认；取消或销毁可能丢弃未消费的 steer，`followup` 在同一路径上也会被清空，没有新增可观测面。
- **不改变 headless 的结论**：父会话被销毁后仍没有投递载体，续聊与回报都落在落盘/重开路径上。

收益：leader 的纠偏消息在 worker 下一步就生效，不再白等一轮，也不再拿旧产物当新轮回报。

## Testing

`tests/worker-sessions.test.js`：让 `send()` 同时调 `steer` 与 `followup` 时「投递走 steer」在调用序列上变红（读到 `['steer', 'followup']`），去掉结算的身份比对时竞态用例变红（旧轮结算后仍在飞记录为 0，期望 1）；还原后全绿。
