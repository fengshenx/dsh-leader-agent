# worker 回报的投递边界与时机

**状态**：implemented（2026-10-27）
**范围**：`src/host/dispatch.js`、`src/host/index.js`、`src/shared/worker-report.js`、`tests/dispatch.test.js`

## 背景

用户要求 worker 回报**走下一个 turn**，并且**不要显示在宿主输入框上方的「消息队列」里**。

查证宿主机制（`packages/core/agent-loop/src/agent.ts` 与 `packages/core/agent-loop/src/inbox.ts`）：

- 宿主 agent 的所有投递都经 `inbox.splice(target, …)`，inbox 只有两个边界：`next-turn` 与 `next-step`。
- `followup` = `send(input, 'next-turn', true)`；`steer` = `send(input, 'next-step', true)`；`inject` = `send(input, 'next-step', false)`。
- 输入框上方的「消息队列」面板（`ui-conversation` 的 `QueueDock`）读 `useProjection('inbox')` 的 **`next-turn` 队列**——`next-turn` 队列里未被消费的消息会显示在那里。
- `inbox.claim(target, turn)` 在**每个 step 开始时**都会取走整个 `next-step` 队列；`next-turn` 只在 turn 边界取一条。
- inbox 投影由 `api-session-controller` 的客户端从事件流重建，第三方没有插过滤位——想让消息不进面板，只能让它不进 `next-turn` 队列，**或者在它被消费前根本别投**。

## 决策

**完成通知走 `next-turn` 边界（`followup`），且只在父会话空闲时投递。**

两条要求各自对应一处事实：

- **走下一个 turn**：通知是「下一个 turn 的一次输入」，语义上就该排进下一轮，而不是插进协调者当前这一步里（`steer` 的 `next-step` 语义是打断）。
- **不在消息队列显示**：协调者正忙时把通知投进 `next-turn`，它会以「一条待发消息」的形态挂在宿主的面板上——那是用户的输入队列，不是后台通知该待的地方。改为忙时**不投**：通知留在落盘队列（`notifications.json`），进程内的等待表记着它，每 500ms 轮询父会话状态；检测到 `agent.status === 'idle'` 才投。投递即被消费，队列面板不会看到它。唤醒时机与排进 `next-turn` 几乎一样（两者都要等当前 turn 结束）。

## 失败路径

审查（bot）逐条核实后补的兜底，均有回归用例：

- **并发重入重复投递**：轮询用 `void` 起，上一轮没跑完下一轮又来，两轮会看到同一条待投通知并各投一次。修法三层：轮询回调加 in-flight 闸门；`flushWaiting` 先摘后投（投递期间等待表里没有这些条目）；`deliverNow` 加幂等闸（同一通知 id 只投一次）。
- **定时器内的异常逃逸**：`flushWaiting` 里有裸 `await`（读盘、写盘），抛错会变成未处理拒绝——宿主对未处理拒绝是致命退出（`proc.exit(1)`），一次磁盘抖动会带走整个 dsh 进程。修法：定时器回调补 `.catch()`，把异常记进 logger。
- **改造前落盘的旧通知补投失败**：PR #6 时代的记录没有 `summary` 字段，`boundSummary` 直接 `.length` → 抛错 → 那条通知永远投不出去。修法：`boundSummary` 兜住非字符串、`workerReportSource` 的 `summary` 给默认值、`deliverNow` 的摘要退回正文首行（与当时的算法一致，旧记录的气泡内容才对得上）。
- **插件卸载后定时器复活**：`dispose()` 只清了定时器，之后再有 worker 收工会重新拉起一个没人再管它的定时器。修法：`closed` 标志，`dispose()` 置位，`deliver` 与 `ensureIdleTimer` 早退。
- **卡片排序的 flaky**：卡片排序按更新时间戳，两次写入落在同一毫秒会退回插入序。修法：卡片存储支持注入时钟，测试注入可控时钟（这条来自 PR #5，会污染 CI 结果，顺手修掉）。
- **撞续行上限后的重试循环**：护栏上限（`autoResumeLimit`）挡住一次投递后，若把该通知放回等待表，轮询每 500ms 会再撞一次同样的上限——每轮一次读盘、一次写盘、一条日志，`attempts` 持续增长，直到用户回来说话。PR 之前撞上限的通知只失败一次就静静躺在盘上，是三层修复叠加时漏掉的分支。修法：投递结果改成三态（`delivered` / `retryable` / `exhausted`），撞上限属不可重试，不再回填等待表；写盘与日志只做一次，原因里带上当前积压条数。

**但条目不能就此丢掉**：被挡下的通知仍留在等待表里并打上 `exhausted` 标记，轮询遇到它就跳过（不投、不写盘、不记日志）；用户开口时计数复位，标记一并清掉，定时器重新跑起来，被挡下的通知才重新投得出去。直接丢弃条目会连「人工介入后可恢复」这个性质一起切掉——护栏本来就是让人能接手，不该让人接手之后也没东西可接。

## 实现要点

- 等待表 `waiting` 按父会话分组，存 `{ notification, agent }`——**必须记住 agent 活对象**：空闲检测没有第二个入口能拿到它（`ctx.get('sessionController')` 在部分组合下拿不到），只存通知会让通知永远投不出去。
- 投递前先查通知还在不在落盘队列里：父会话重新打开时补投通道（`redeliverPending`）可能已经投过同一条，重复投会让协调者收到两遍。
- 连续自动续行上限只在**真正投递时**计数：等待期间不消耗额度。
- 空闲检测的定时器 `unref()`，不拖住进程退出；通知仍在落盘队列里，重启后补投。插件卸载时（`ctx.on('dispose')`）停掉定时器。

## 边界

- **Trajectory 里 worker 回报归类为 `CONTEXT` 行**（宿主按 `source.kind` 分类，与投递边界无关）。改投递边界不动这个归类。
- 等待中的通知在崩溃后由落盘队列兜住：重启、父会话重新打开时补投。
- **等待表没有上限**：父会话长期忙时按 worker 数累积，每 500ms 全量 `listPending`。实测 30 条积压时单次读盘毫秒级、累计每秒个位数毫秒，成本可忽略；只是没有淘汰与告警机制。
- **积压在界面上不可见**：20 个 worker 的回报在父会话忙时收工，转空闲后只投出护栏允许的 8 条，剩下的要等用户开口才放行（用户发言触发 `agent/inbox/inserted` → 计数复位 → 被挡下的条目重新投出）。用户和协调者都看不到还有多少条在等——界面没有任何提示，落盘队列里的记录是唯一的端倪（撞上限时写下的原因里带积压条数）。
- **空闲判定与用户输入之间没有互斥**：`agent.status` 从 `idle` 转 `running` 是用户发消息后由 `wakeDriver` 触发的。若轮询恰好落在这个转换之前，worker 回报仍会进 `next-turn`，与用户那条短暂地排在同一个队列条里（随后被消费）。窗口只有「用户回车 → driver 起跑」这一段，实际很难撞上；要彻底收口得在投递前顺带查一次 `inbox['next-turn']` 是否为空。
- **投递与落盘的顺序**：消息先到父会话，队列文件的「已投递」标记随后才清。界面无感（气泡先出现），但断言要等两件事都成立。
- 若宿主未来给 agent 换掉 `followup`，`agent.followup` 这一次调用抛错会被 `deliverOnce` 的 catch 兜住：通知留在落盘队列等待补投（不会丢）。注意这个 catch 只包 `followup` 这一次调用——`workerReportSource` 与 `markDelivered` 在它外面，各自的失败路径见「失败路径」一节。

## 证据

- 单测 285 例全绿，新增六条回归用例：轮询重入不重复投递、空闲检测读盘失败不产生未处理拒绝、改造前落盘的旧通知补投成功、插件卸载后不再起定时器、撞续行上限后不再每轮重试、上限复位后被挡下的通知能重新投出。每条都做过「回退修复 → 用例失败 → 还原修复 → 用例通过」的双向验证，确保它们真能抓住对应缺陷。
- 测试临时目录改用仓库既有的统一登记（`tests/helpers/temp-dir.js` + `after` 钩子）：用例各自 `rm` 会在在途写盘与删除之间撞出 ENOENT / ENOTEMPTY。
- 卡片排序的 flaky 用可控时钟消掉：连跑 8 次全过（修前 5 次里有 1 次失败）。
- 真实实例（隔离 mock profile + mock LLM，协调者 turn 里故意 sleep 8 秒造出 busy 窗口）：通知在第 1 秒到达并留在落盘队列（`lastError: 父会话正忙，等待空闲后投递`）；第 8.8 秒父会话转空闲后自动投递，气泡出现、落盘队列清空。console 无报错。

## 队列面板：先前「复现不出来」是方法错误

用户指出「消息队列」是真实存在的界面：人（或插件注入的消息）在 agent 忙时排进 inbox 的 `next-turn`，就会出现在输入框上方的队列条里。此前记的「web 端没能复现出队列显示」是**假阴性**，错在两点：

1. **队列为空时宿主整个不渲染**：`QueueDock` 在 `rowCount === 0` 时 `return null`。此前一直盯着一个空队列找面板，自然找不到。
2. **那条实验里 worker 回报没处在「未消费的 next-turn」状态**：要让面板出现，队列里必须真有未消费项。

宿主 `QueueDock.tsx` 的面板元素带 `data-queue-dock` 属性，选择器本身是对的。复现方式：**协调者忙的时候，人再发一条消息**——那条消息进入 `next-turn` 未消费队列，面板随即出现。

## 对照实验（同一实例，两次运行）

场景：协调者 turn 里 sleep 8 秒造 busy 窗口；busy 期间人发一条消息。

| 实现 | busy 期间队列面板的内容 | turn 结束后 |
|---|---|---|
| busy 时直接 `followup`（对照，临时关掉空闲才投的开关） | **「2 queued messages」**——人的消息 + worker 回报一起排着 | 一起被消费，worker 回报渲染成气泡 |
| 空闲才投（当前实现） | **只有人的那 1 条** | 人的消息被消费；worker 回报从落盘队列单独投出，渲染成气泡 |

结论：worker 回报**照样会触发**（turn 一结束就送到，唤醒时机与排进 `next-turn` 几乎一样），变的只是等待期间不占队列面板。
