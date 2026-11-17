# Agent Note: worker 超时无回报的巡查

Status: implemented

## Problem

leader 看不到 worker「已经连续跑了多久」：完成通知只在 `turn/end` 之后来，在飞记录只说「这一轮还没结束」。worker 卡在一个轮次里反复打转时，leader 收不到任何信号，而默认协议要求它不轮询——死循环是静默的。派工登记表记了 `registeredAt`，但那是「什么时候派出去」，不是「什么时候还活着」。

## Decision

**回报时间落登记表。** `settleTurn` 在每轮结算（`turn/end` 的任一种终态）后把时刻写进 `workers.json` 的 `lastReportAt`（`markReported`）。只写这一个字段，不动 `registeredAt`（登记顺序不是活跃度）与父会话归属，也不写 session meta（理由见备选）；写失败只记日志——通知已经落盘，不能因为活性事实没写进去就把一次成功的结算回滚成失败。只认 leader 发起、在飞表里有记录的轮次；人下钻跟 worker 聊的轮次不结算，也不写回报时间。

**单节拍巡查。** 进程内一个 60s interval 扫 `inflight` 里尚未结算的轮次，基线取 `max(本轮起点, 最后回报, 上次提醒)` 与 15 分钟比较。run 起点防上一轮的旧回报把新一轮一开跑就判超时；`lastAlertAt` 实现「注入即重置计时」，同一段停滞每 15 分钟至多一条；结算即移出在飞表，自动退出巡查。

**提醒复用完成通知通道。** 提醒走同一个落盘队列与 `deliver`：父会话空闲才投、忙则等、换 leader 一并改投、共享自动续行护栏。入队前先看盘上有没有该 worker 未消费的 `stalled` 提醒——leader 长期缺位时每个 worker 只留一条，不会每 15 分钟堆一条。扫描到入队跨了 `listPending` / `workers.get` / `activeCardsOf` 三个 await，入队前再**同步**核一次在飞轮次的 `summary` / `startedAt`（不跨 await），堵住「扫描期间正好结算、随后补发旧轮次提醒」的窗口。提醒正文带挂着的未完成卡、已连续时长、最后回报、一条可照抄的 `read_worker_session({ sessionId, turns: 3 })`，并写明本流程没有中止手段（否则 leader 会去找一个不存在的停止工具）。

**提醒是独立来源，但不再自绘。** `dsh-leader-agent/worker-stall` source kind 与 `source.stall`（`name` / `childSessionId` / `runStartedAt` / `lastReportAt`）保留：落盘队列去重、`stalledNoticeIsLive` 与换 leader 改投都靠它。呈现回到带 `【后台巡查】` 前缀的普通文本：正文自包含 worker 名字、可照抄的 sessionId、挂着的卡、已连续时长、最后回报与回看调用，并写明「这是提醒，不是中止」。客户端没有加载这个插件时，宿主按官方上下文行降级（裸 kind 标签 + 完整 summary + 正文），内容不丢。放弃自绘行的收益是删掉 223 行 client 代码、自维护 CSS 与零覆盖的 view；代价是失去点击名字下钻。

**工具面同步活性事实。** `workerFacts()` 一次读盘取全量登记表、叠上本进程在飞起点；`list_cards` 的槽位行据此附上「最后回报 X 前 · 已连续 Y」。running 且从未回报写「最后回报 无记录」，idle 且从未回报整段省略——非运行态没有回报过的历史会话，这个附注没有决策价值。协议层只在 `leader-mode` 的编排 playbook 加一条「收到巡查先回看再决定」的规则。

## Alternatives considered

- **每个 worker 一个定时器**：正确性依赖每条 run 起点与终态路径都建/清句柄，漏建则永久静默、漏清则句柄泄漏，而这恰好都发生在异常与取消路径。单节拍是无状态对账，漏了任一事件下一拍自动纠正。
- **节拍也取 15 分钟**：节拍与阈值同值时首报最坏接近 30 分钟；60s 节拍把精度收在阈值后一分钟内。
- **把回报时间写卡片**：一张卡可挂多个槽位，「连续多久没动静」是执行者属性，不是卡片属性；同一 worker 没有卡时也要能判。
- **用 `session.updatedAt` 当活性**：它在 running 时是本轮开跑时刻、idle 时是上轮结束时刻，同一个值两种语义，判不出「这一轮跑了多久」。
- **把活性写 session meta**：session event 类型不能由仓外插件新增，meta 属于宿主域；`workers.json` 已经是派工归属与 `list_cards` 的跨进程真源，再写一份 session meta 只会多一个要同步的读面。
- **人下钻的轮次也算活性**：那会把「有人在跟它聊天」当成「leader 派的工作还活着」，超时提醒反而在真正需要时被压掉；代价是正聊天时也可能收到提醒，已写进限制。
- **保留自绘呈现层（额外注册会话节点 + 自维护 CSS）**：换来的是可点名字，代价是 223 行 client 代码、一套跟宿主令牌漂移的 CSS 和一个没有渲染覆盖的 view；用户实际看到的是灰底 + 左竖线 + 徽标的整行，判定为过度设计。纯文本 + `【后台巡查】` 前缀同样能区分「沉寂」与「交付」，客户端没加载时还和降级路径同形。
- **把 Running/Blocked 状态也纳入扫描**：本仓的宿主侧只能看到 agent 的 `idle` 与否，看不到「在等用户答复」；`ask_user_question` 挡住的 worker 与卡死的 worker 在机制上同形，都按「没有回报」提醒，正文要求先回看会话区分。

## Consequences

- 客户端不再为巡查注册会话节点：会话里是普通文本，点击 worker 名字下钻的入口没了，改用正文里的 sessionId 与 `read_worker_session`。
- 提醒落在阈值后一分钟内（节拍粒度），不是精确的第 15 分钟；进程重启不重新生成提醒，盘上已入队的巡查提醒在补投时也会被丢弃——重启后没有正在跑的轮次可对应，补一条「15 分钟没回报」只会误导。`runStartedAt` 是本 PR 首次引入的字段，没有已发布的存量；升级时盘上缺这个字段的旧 `stalled` 记录会被一律按过期丢弃，影响可接受。
- 与完成通知共用自动续行上限：leader 长期无人开口时，连续自动唤醒到上限后提醒停在落盘队列里，日志会写明原因。
- 巡查只看 leader 发起的轮次：正跟 worker 对话时也可能收到超时提醒，这是知道「谁在跟它说话」的代价。
- 每轮多一次 `workers.json` 读改写；`list_cards` 多一次登记表读盘，输出只给本次返回的卡上那些会话算附注。
- `ask_user_question` 挡住后台 worker 时同样会提醒，正文与协议要求先回看，不把「在等答复」误判成「卡死」。
- 收益：worker 沉默超过 15 分钟不再无声，leader 有一个带卡号、带时长、带回看入口的信号可以照着处理；槽位行也能直接读出「最后回报在多久前」。

## Testing

- `tests/worker-stall.test.js`：时长分档、基线三支取最大、15 分钟边界（差一毫秒不推 / 到点推）、提醒后从提醒时刻重新起算、单 worker 失败不拖垮整拍、定时器与 dispose、装配缺参报错；提醒正文钉住 `【后台巡查】` 前缀、sessionId、卡号、可照抄调用、「提醒不是中止」与「没有中止手段」。
- `tests/worker-stall-source.test.js`：source 形状与四个机器事实、缺 `runStartedAt` / `lastReportAt` 时不带键、摘要带前缀且能独立成句并压到上限。
- `tests/dispatch.test.js`：结算写回报时间（人直聊的轮次不写）；未到阈值零动作；到点注入并投给空闲父会话；父会话忙时入队去重、空闲后照常投递；销毁与卸载后不再巡查；登记表读失败时退化为按本轮起点判定并记日志；用可控 promise 把扫描停在 `activeCardsOf`、期间结算，断言只收到完成回报；新 dispatcher 补投盘上的过期 stalled 时丢弃且不投递。
- `tests/worker-registry.test.js`、`tests/card-list-view.test.js`、`tests/cards-tools.test.js`：`markReported` 只动回报时刻、跨实例可读；槽位附注的 running/never/idle 三支；`list_cards` 只给本次卡上会话算附注；没接活性提供方时，渲染文本与 7cd537b 生成的 golden fixture 按 UTF-8 字节逐一比对。
- 双向验证：从基线里去掉 `lastAlertAt` 后「提醒后重新起算」用例变红（证明基线参与判定），还原后全绿；把 `notice` 分支的条件改成永假、提醒退回 worker 回报 source，`source.kind` 断言变红，还原后全绿。
- `npm run check`（覆盖率 per-file 门禁）与 `npm run build:client` 通过。
