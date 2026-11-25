# Agent Note: 项目树的 worker 按最近使用时间排序

Status: implemented

## Problem

项目树里每个项目的会话行沿用会话库顺序——`sessionQuery.listSessions()` 按创建时间倒序（`compareSessions`）。worker 是常驻会话，一个项目里发过十几次任务的老 worker 会一直排在新建的后面，即使它刚刚被投递、刚刚回报；左栏要往下翻才知道哪个 worker 最近有动静。

## Decision

- **排序在宿主侧做**，`sessionsByProject()` 返回前把每个项目的 worker 按 `lastUsedAt` 倒序；退役 leader 没有这个时间，接在 worker 后面。项目树与会话标签栏读同一份结果，顺序天然一致（标签栏的「顺序固定为项目树顺序」不必另开一条排序路径）。
- **时间取 worker 登记表的 `lastUsedAt`**：`markUsed` 在 `message_worker` 投递成功时写，`markReported` 在回合结算时写——它本来就是本仓的「worker 活跃度」口径（LRU 复用与停滞巡查都用它），不是创建顺序。
- **没有时间的会话保持原相对顺序**：JS 排序稳定，登记表读不到或旧记录缺字段时不把列表打乱；`lastUsedAt` 非数字按 0 处理，不让 `NaN` 污染比较。
- 项目服务只新增可选注入 `workerLastUsedAt`，不依赖登记表本体：没注入时行为与以前完全一致，单测可以只在需要时给假件。

## Alternatives considered

- **用客户端 `SessionSummary.updatedAt` 排**：它是宿主侧「最后一次真人输入」时间（`api-session/activity` 只认 `source.kind === 'user'`），leader 投递的 worker 任务走自定义 source kind，不会推进它——刚派工的 worker 排不上去，正是这次要修的症状。而且客户端排序会让标签栏与项目树出现两套顺序。
- **两者取较新**（`updatedAt` 与 `lastUsedAt`）：人下钻聊天也能排上去，但要把登记表时间透传到客户端、再让项目树与标签栏共用一套排序，改动面大；人直接聊 worker 不是主路径，先按派工活跃度收口。
- **按 `lastReportAt` 排**：只覆盖回合结束，投递刚开始的 worker 不会提前；`lastUsedAt` 已经在结算时一起更新，更完整。
- **按运行态优先**：运行中的 worker 在最前，但「刚派工还在跑」与「跑了很久没动」无法区分，且没覆盖投递后空闲的排序需求。

## Consequences

- 人下钻跟 worker 聊天不改变 `lastUsedAt`，不会让它跳位；这类会话仍按上一次派工/结算的时间排。
- 一轮执行中的 worker 只记投递时刻，长回合里不会持续上浮；回合结束结算时才会更新到当前时刻。
- 退役 leader 固定排在 worker 之后，不参与时间排序。
- 项目树在会话事件（status/settle）后防抖重取 `sessionsByProject`：同一批事件合并进一个 1 秒 timer（后到的事件重置它），顺序最多晚约 1 秒，不会因此刷两次；窗口重新聚焦也会重取。

收益：左栏最近被投递或刚回报的 worker 浮到项目最前面，与 `list_cards`/名册 LRU 的「最近使用」口径一致。

## Testing

- `tests/project-session-index.test.js`：纯函数 `orderSessionsByLastUsed` 倒序/稳定/非数字回落，以及相同 `lastUsedAt` 保持原序；服务用例把会话库顺序与 `lastUsedAt` 顺序设成相反，断言输出按时间、退役 leader 接在 worker 后面；不注入 `workerLastUsedAt` 时保持会话库顺序。
- `tests/leader-wiring.test.js`：装配层用真实登记表文件断言 `workerLastUsedAt` 注入确实把 `lastUsedAt` 传给项目服务（覆盖 `src/host/index.js` 的注入行）。
- `tests/e2e/worker-session-order.e2e.js`：真实宿主建 3 个 worker，登记表的 `lastUsedAt` 与创建顺序相反，展开项目后按 DOM 顺序断言 `[w1, w2, w3]`。双向：临时关掉服务里的排序后，同一场景读到会话库顺序 `[w3, w2, w1]` 变红；还原后全绿。
