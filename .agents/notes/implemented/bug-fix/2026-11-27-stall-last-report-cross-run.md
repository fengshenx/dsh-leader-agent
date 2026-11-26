# Agent Note: 巡查提醒的「最后回报」不再跨轮

Status: implemented

## Problem

复用的 worker 会带着上一轮的 `lastReportAt` 开新轮：提醒第一行说本轮「已连续 15 分钟没有回报」，紧跟的「最后回报：9 小时 6 分钟前」却用 `now - lastReportAt` 算到了上一轮结算。两句话各自为真，拼在一起会被读成本轮已经沉默 9 小时，也容易被当成 UTC 没转成本机时区——本次真实报告就是这么来的。worker 复用是常规做法（同一 session 改名 + 投递），不是边缘情形。

## Decision

提醒正文接收 `runStartedAt`：`lastReportAt` 早于本轮起点时写「最后回报：本轮还没有回报（上一次回报在 X 前）」，把上一轮的事实留在括号里；本轮确有回报时维持「X 前」；从未回报仍是「无记录（这一轮还没有结束过）」。巡查的判定基线、去重与补投都不动——只改这一行的呈现。

边界固定为严格 `<`：`lastReportAt === runStartedAt` 算本轮（上一轮 `turn/end` 与新一轮派工落在同一毫秒时仍显示「X 前」）。若将来要求相等也算 stale，改成 `<=` 并同步 `tests/worker-stall.test.js` 的相等边界用例。

## Alternatives considered

- **显示绝对本机时刻（如「最后回报 15:47」）**：提醒给模型读，进程与用户不一定同时区，绝对时刻还要附带时区说明；相对时长与提醒的其余时长口径一致，也不会和宿主会话时钟打架。
- **隐藏「最后回报」行**：上一轮的活性事实对判断「本来就慢」还有价值，只是不能冒充本轮。
- **stale 时也写「无记录（这一轮还没有结束过）」**：会丢掉「这个 session 上次活着是什么时候」，而且和从未回报的新 worker 同形。
- **`list_cards` 的槽位行同步改口径**：槽位行已经并排给出「最后回报 X 前 · 已连续 Y」，语义足够清楚；本次不扩大面。

## Consequences

- 复用 worker 的提醒不再把上一轮时长算进本轮；本轮真有回报时口径不变。
- `runStartedAt` 由 `alertStalled` 传入；漏传时退回旧的「X 前」口径，不会有断言把它挡在装配期。
- 判定、去重、补投与 `source.stall` 都不受影响。

收益：提醒里的「最后回报」与本轮时长不再互相矛盾，也不会再被读成时区算错。

## Testing

- `tests/worker-stall.test.js`：跨轮 stale 写「本轮还没有回报（上一次回报在 9 小时 6 分钟前）」；本轮有回报仍写「3 分钟前」；相等边界（`lastReportAt === runStartedAt`）写「15 分钟前」而不是跨轮文案；从未回报仍写「无记录」。
- `tests/dispatch.test.js`：真实派工后分别覆盖 never / current / stale 三种正文；stale 在登记表注入上一轮的回报，扫描到点投递的正文同上。
- 双向验证：把 `lastReportAt < runStartedAt` 改成 `<=`，相等边界用例变红（1 fail）；改成恒假，stale 两处变红；还原后全绿。
- `npm run check` 通过。
