# Agent Note: 宿主阻断轮次的失败回报

Status: implemented

## Problem

leader 把消息投给一个在宿主归档视图里归档、但派工登记还在的 worker 时，`message_worker` 会返回成功：`agent.steer` 只是把消息塞进收件箱（next-step 语义见[续聊消息改走 next-step 边界](2026-11-06-worker-message-next-step-injection.md)）。worker 的 `agent/pre-step` 随后被宿主的归档闸门 reject，轮次以 `blocked` 结束，消息被 claim 后丢弃。原来的结算只把未归属的 `error` 当失败，`blocked` 被直接忽略，在飞记录留到 15 分钟巡查才提醒一次。表现是「投递成功、worker 一动不动」。

## Decision

- 未归属轮次里，只要 leader 消息已被 claim、终态是 `blocked`，就按失败结算并回报 leader，说明消息已被取走、没有落成 `user/message`。
- 结算时若会话仍在归档集合里，失败原因追加「该 worker 会话已归档；先反归档再续聊，或重新派工。反归档不会补跑这条消息，需重新 message_worker 投递」；注册表读不到时退回通用 blocked 文案，不猜。
- 用户自己开启的轮次仍不结算，保持原口径；`blocked` 却没有 claim 记录的轮次也不报，避免误归属。
- 不给 `message_worker` 加归档预检：拦截发生在异步轮次里，发送时拿不到结果；预检只会把同一次查归档再复制一遍，也覆盖不了别的 pre-step 拒绝。

## Alternatives considered

- **在 `message_worker` 里查 `archivedSessionIds` 并拒绝**：能在发送时立刻报错，但每次投递都要扫归档集合，而且只覆盖归档一种拒绝；宿主的 `blocked` 仍会出现在别的闸门上。
- **要求宿主返回错误码**：`agent/pre-step` 的拒绝是 `{ kind: 'reject' }`，`turn/end` 只有 `blocked`，没有 archived 专属错误；这条路要改宿主，不在本仓权限内。
- **所有 blocked 都回报**：会把用户自己开启、没有 claim leader 消息的轮次也报成派工失败，误导 leader。
- **只等 15 分钟巡查**：巡查只说「长时间没回报」，无法区分「慢」和「消息被丢」，leader 会多等一轮才重投。

## Consequences

- leader 在轮次结束时就收到失败回报，不必等巡查；回报里写明消息已被取走，重投或反归档是明确动作。
- 消息本身仍被宿主丢弃，反归档不会补跑；这是宿主归档语义，本仓只负责如实回报。
- 归档集合只在 `blocked` 结算时读一次，不在投递热路径上。
- 未覆盖：`aborted` 或没有 claim 的阻断仍保持原静默口径；宿主将来若给 `blocked` 带原因，这段文案可以收窄。

收益：归档 worker 的续聊不再「假成功 + 15 分钟静默」，leader 能立即知道消息没送到。

## Testing

`tests/dispatch.test.js` 新增两条：归档集合命中时收到带「已归档」与「反归档不会补跑」的失败回报；`archivedSessionIds: () => []` 的已知空集合 blocked 也回报但不冒充归档（不再只覆盖注册表缺失 `undefined` 分支）。双向：撤掉 `blocked && claimed` 分支后两条用例都红（`turn/end` 返回 `false`、没有通知），还原后全绿；全量 dispatch 测试通过。
