# worker 回报的投递语义：at-least-once 与在飞覆盖

**状态**：proposal（2026-11-03）
**范围**：`src/host/dispatch.js`、`src/host/worker-sessions.js`、`src/host/message.js`、`docs/limitations.md`

## 背景

被问到「leader 与 worker 的回报有没有持久化和幂等、会不会重复投递、会不会丢消息」时，逐条核过实现并跑了两条探针（复用 `tests/dispatch.test.js` 的夹具，非真机）。现状是分层的：

- **会话本体**由宿主 JSONL 持有，进程重启后 `agents.resume()` 冷恢复；**worker 登记表**与**完成通知队列**各自落盘在 `$DSH_HOME/dsh-leader-kit/`，都是原子写加串行读改写（`worker-registry.js:78-99`、`notification-store.js:72-89`）。
- **通知入队按 id 幂等**（`note-<childId>-<startedAt>`），落盘失败重试与重结算不会多出一条；**投递**有进程内 `delivering` 闸、`flushWaiting` 的先摘后投、投前核对落盘队列，挡得住轮询重入与补投并发（`dispatch.js:228-235`、`dispatch.js:379-428`）。
- **卡片写入**走 `expectedRevision` 乐观并发，**worker 登记**按 childId 更新而非追加。

三个缺口不在这一层：

1. **在飞记录以会话 id 为键且无条件覆盖**（`dispatch.js:631`）。worker 正在跑时 leader 再 `message_worker` 一次，第二条记录覆盖第一条；第一轮 `turn/end` 用第二条的 parent/name/startedAt 结算并删记录，第二轮 `turn/end` 时表已空、直接不结算。探针读数：`inflight after 2nd message: 1`、`worker 收到消息数: 2`、`第一轮结算: true delivered: 1`、`第二轮结算: false delivered: 1`——leader 刚投的那条任务的产出永远送不到。工具描述还明确鼓励「追问结果」，这条路径很容易走到。
2. **投递与「已投递」标记不是原子的**：`followup` 先发、`markDelivered` 后写（`dispatch.js:266-277`）。中间崩溃或写盘失败，通知仍在队列，父会话重开时 `redeliverPending` 会再投一次。探针读数：让 `markDelivered` 失败一次后调补投，`首投 delivered: 1, pending: 1` → `补投成功 1 条, delivered: 2`。通知消息 id 是随机 UUID（`message.js:32-39`），宿主侧不会去重，leader 看到的是两条一模一样的「任务已结束」。
3. **任务投递没有幂等键**：每次 `message_worker` 生成随机消息 id，模型重试同一次工具调用就会让 worker 收到两遍任务。

在飞记录仅内存、进程在 worker 跑完前被杀则那一轮不结算，已在 `docs/limitations.md` 的「报告结算依赖轮次正常结束」记明，本提案不改这一条——要改得先把在飞记录落盘，代价是每轮多两次写盘。

## 决策

### 在飞记录改成按会话排队，不覆盖

`inflight` 从 `Map<sessionId, record>` 改成 `Map<sessionId, record[]>`：`message()` 追加，`settleTurn()` 取队首结算、空则删键。依据是宿主 inbox 的 `next-turn` 边界本来就是「每个 turn 取一条」（见 [worker 回报的投递边界](2026-10-27-worker-report-delivery-boundary.md)），一条 `followup` 对应一个 `turn/end`，队列与轮次一一对应。`describeRoster` 的「在跑」判定保持 `inflight.has`，`inflightCount()` 改为求和。

放弃的替代方案：在 `message()` 里 `inflight.has` 就拒绝投递。它保不住「worker 忙时 leader 追问」这个正常用法——那正是 `merged` 回执存在的意义；拒绝只是把丢失换成让 leader 重试，而重试本身会重复投递。

### 回报接受 at-least-once，重复要可识别

`followup` 与 `markDelivered` 之间的窗口无法在应用层消除（要么先标记后投、崩溃时丢通知，要么先投后标记、崩溃时重复一次）。选择**不丢**：接受 at-least-once，把「同一回报可能到达两次」写进限制文档。

配套把通知的稳定 id 放进消息 `source`（`workerReportSource` 已带 `childId`、`name` 等字段），这样重复投递在会话日志与客户端里是同一个 id，可识别、可去重；不假设宿主按 message id 去重——那不在本仓可验证的契约里。

放弃的替代方案：先写「投递中」状态再投、投完删。多一次写盘只把窗口从「投→标记」挪到「标记→投」，没消除窗口，还多了一条中间态要清理。

### 任务投递不加幂等键，改为把回执语义说清

`message_worker` 不做去重：插件分不清「模型重试」与「leader 真的要再投一次」，加一个模型必须正确填写的 messageId 字段，填错就是静默重复，比现在更糟。改为在工具描述与回执文案里说明「消息并入当前或下一轮，不保证只投一次」，让 leader 按这个语义组织动作。

### 并发补投的窄窗口一并收口

`flushWaiting` 在循环前读一次 `pending` 快照，`redeliverPending` 若在快照之后完成投递并 `markDelivered`，`flushWaiting` 会按过期快照再投一次。改为每条投递前重新核对 `pending`——`delivering` 闸只在投递进行中有效，投完之后它就放行了。

## 边界

- **在飞队列仍是内存态**：进程崩溃窗口不变，重启后那一轮不结算，leader 只能自己 `read_worker_session` 回看。落盘在飞记录不在本提案范围。
- **续行上限更容易撞**：队列化后 leader 一次投多条会积累多条回报，`autoResumeLimit`（默认 8）按父会话计，撞上限的通知停在盘上等人工开口，界面无提示。这是既有取舍，队列化只是让它更常出现。
- **通知队列损坏即整队丢弃**：`notification-store.js:59-64` 备份后返回空队列，只留一行日志。不在本提案范围。
- **队列化的前提是「一条 followup 一个 turn」**：若宿主改成一次 turn 消费多条 `next-turn`，队列与轮次会错位。这条依赖记在这里，宿主升级时按 `inbox.claim` 的实现核对。
- **只影响 leader 投递的轮次**：人下钻跟 worker 直接对话的轮次不进在飞表，行为不变。

## 验证

现状证据（2026-11-03，复用 `tests/dispatch.test.js` 夹具的两条探针）：

- 在飞覆盖：`inflight after 2nd message: 1`、`worker 收到消息数: 2`、`第一轮结算: true delivered: 1`、`第二轮结算: false delivered: 1`、`pending in queue: 0`——第二轮的回报既没送达也没留在队列里。
- 补投重复：`markDelivered` 失败一次 → `首投 delivered: 1, pending: 1`；调 `redeliverPending` → `补投成功条数: 1, delivered: 2`。

实现落地时按仓库惯例补永久回归用例：在飞续投两轮各自结算一条、`flushWaiting` 对已投出的通知不重复投、补投后 leader 只被唤醒一次；每条都做「撤销修复 → 用例变红 → 还原 → 全绿」的双向验证。现有 `tests/dispatch.test.js` 的「一轮只结算一次回报，重复上报不重复唤醒」与「通知落盘失败时保留在飞记录」两条断言不能改弱——它们钉的是同一批不变量。
