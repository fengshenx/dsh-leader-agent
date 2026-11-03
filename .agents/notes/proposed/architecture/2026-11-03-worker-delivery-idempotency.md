# worker 回报的投递语义：at-least-once 与在飞覆盖

**范围**：`src/host/dispatch.js`、`src/host/worker-sessions.js`、`src/host/message.js`、`docs/limitations.md`

## 背景

被问到「leader 与 worker 的回报有没有持久化和幂等、会不会重复投递、会不会丢消息」时，逐条核过实现并跑了两条探针（复用 `tests/dispatch.test.js` 的夹具，非真机）。现状是分层的：

- **会话本体**由宿主 JSONL 持有，进程重启后 `agents.resume()` 冷恢复；**worker 登记表**与**完成通知队列**各自落盘在 `$DSH_HOME/dsh-leader-kit/`，都是原子写加串行读改写（`worker-registry.js:78-99`、`notification-store.js:72-89`）。
- **通知入队按 id 幂等**（`note-<childId>-<startedAt>`），落盘失败重试与重结算不会多出一条；**投递**有进程内 `delivering` 闸、`flushWaiting` 的先摘后投、投前核对落盘队列，挡得住轮询重入与补投并发（`dispatch.js:228-235`、`dispatch.js:379-428`）。
- **卡片写入**走 `expectedRevision` 乐观并发，**worker 登记**按 childId 更新而非追加。

三个缺口不在这一层：

1. **在飞记录以会话 id 为键且无条件覆盖**（`dispatch.js:629`）。worker 正在跑时 leader 再 `message_worker` 一次，第二条记录覆盖第一条；第一轮 `turn/end` 用第二条的 parent/name/startedAt 结算并删记录，第二轮 `turn/end` 时表已空、直接不结算。探针读数：`inflight after 2nd message: 1`、`worker 收到消息数: 2`、`第一轮结算: true delivered: 1`、`第二轮结算: false delivered: 1`——leader 刚投的那条任务的产出永远送不到。工具描述还明确鼓励「追问结果」，这条路径很容易走到。
2. **投递与「已投递」标记不是原子的**：`followup` 先发、`markDelivered` 后写（`dispatch.js:266-277`）。中间崩溃或写盘失败，通知仍在队列，父会话重开时 `redeliverPending` 会再投一次。探针读数：让 `markDelivered` 失败一次后调补投，`首投 delivered: 1, pending: 1` → `补投成功 1 条, delivered: 2`。通知消息 id 是随机 UUID（`message.js:32-39`），宿主侧不会去重，leader 看到的是两条一模一样的「任务已结束」。
3. **任务投递没有幂等键**：每次 `message_worker` 生成随机消息 id，模型重试同一次工具调用就会让 worker 收到两遍任务。

审查复核时又实测出两处**只在队列化之后才成为缺陷**的问题，一并写进本提案：

4. **结算重试会吃掉下一轮的 `turn/end`**（`dispatch.js:857-880`）。`emitNotification` 失败时记录不删，等这个 worker 下一轮结束时重试——单条记录时这已经是「用下一轮的轮次还上一轮的债」。队列化后更糟：队首 A 落盘失败留在队首，下一轮 `turn/end` 本属于 B，`settleTurn` 取到的仍是 A，重试成功后删掉队首——A 送出去了，B 那一轮被消耗、再无对应轮次。构造「在飞两条 + 首次 `enqueue` 失败」实测：leader 少一条回报；worker 不再跑则那条永久滞留在队列里。
5. **`interrupt` / 归档后在飞记录不清**。`dispatch.js` 全文除 `settleTurn` 外没有别的 `inflight` 清理点：worker 被中断且没走到 `turn/end` 时记录留在表里，`describeRoster` 的 `inflight.has(item.childId)`（`dispatch.js:479`）让这个 worker 永久被判「在跑」——既不能接新活，也不进空闲与挂卡列表；`reassignParent`（`dispatch.js:1007-1042`）还会把这些记录当成可迁移的活记录。

在飞记录仅内存、进程在 worker 跑完前被杀则那一轮不结算，已在 `docs/limitations.md` 的「报告结算依赖轮次正常结束」记明，本提案不改这一条——要改得先把在飞记录落盘，代价是每轮多两次写盘。

两条**方案成立与否取决于它**的宿主契约（rc.2 复核）：

- **`inbox.claim(target, turn)` 在每个 step 开始时取走整个 `next-step` 队列，`next-turn` 只在 turn 边界取一条**（[投递边界](../../implemented/architecture/2026-10-27-worker-report-delivery-boundary.md)）。所以「一条 `followup` 对一个 `turn/end`」成立，队列与轮次能一一对应。
- **通知 id 必须放进消息 `source`**，不是为了好看：宿主的 inbox 拒收同 id 并存——同一条消息再投一次会被挡在门外，连「重复」都不会出现，等于直接丢。要让重复投递可识别，只能让 id 随消息体进会话日志（`workerReportSource` 已带 `childId`、`name`），不能指望宿主按 message id 去重。

## 提案

### 在飞记录改成按会话排队，不覆盖

`inflight` 从 `Map<sessionId, record>` 改成 `Map<sessionId, record[]>`：`message()` 追加，`settleTurn()` 取队首结算、空则删键。依据是上面复核过的 `next-turn` 边界（每个 turn 一条），一条 `followup` 对应一个 `turn/end`，队列与轮次一一对应。

配套改动，漏一条队列就会错位：

- **`turnText` 也要按记录绑定**。现在是 `Map<sessionId, string>`（`dispatch.js:906-910`）：队列化后同一会话的两条在飞记录共用一个 key，队首结算时读到的可能是后一轮 `assistant/message` 的文本，摘要会串轮。改为按记录标识（如 `note-<childId>-<startedAt>`）存，或让 `assistant/message` 只写队尾那条。
- `inflightCount()` 改为求和；`reassignParent` 的 `for (const record of inflight.values())`（`dispatch.js:1035`）要展平成队列内的每条记录再改 `parentSessionId`，否则 `moved` 恒为 0、接管的父会话拿不到在飞记录。
- `describeRoster` 的「在跑」判定仍是 `inflight.has`（队空时删键），语义不变。

放弃的替代方案：在 `message()` 里 `inflight.has` 就拒绝投递。它保不住「worker 忙时 leader 追问」这个正常用法——那正是 `merged` 回执存在的意义；拒绝只是把丢失换成让 leader 重试，而重试本身会重复投递。

### 结算与通知落盘解耦，重试不占后续轮次

**先从队列摘下队首、放进「待落盘」槽，再 `emitNotification`**：

- 摘下的记录连同冻结的 `summary` / `outcome` 一起进 `settling`，队列里就没有它了——这一轮的 `turn/end` 到此消费完毕。
- `emitNotification` 失败时只重试落盘（`enqueue` 按 id 幂等，重试不会多出一条）；重试挂在既有的空闲轮询与 `redeliverPending` 之前，**不再借用后续 `turn/end`**。
- 后续每轮的 `turn/end` 依次结算它自己那一轮，不会因为前一条落盘失败而错位。

不做这一步，缺口 4 就是队列化的必然后果：重试吃掉的是别人的轮次，队列越长错位越多。

### interrupt 与归档要清掉在飞记录

三处入口各清一次，收口缺口 5：

- worker 会话被中断或销毁时（`worker-sessions.js` 的重建与销毁路径），删掉该会话的整个队列，并按需落一条「被中断」的通知，让 leader 知道这一轮没有产出。
- `archivedSessionIds()` 里出现的会话从 `inflight` 摘掉——`describeRoster` 已经按它过滤 worker 列表，在飞表要跟同一口径。
- 兜底：结算前丢弃 `startedAt` 超过阈值的记录（长时间收不到 `turn/end`），并记一行日志。兜底不代替前两条。

### 回报接受 at-least-once，重复要可识别

`followup` 与 `markDelivered` 之间的窗口无法在应用层消除（要么先标记后投、崩溃时丢通知，要么先投后标记、崩溃时重复一次）。选择**不丢**：接受 at-least-once，把「同一回报可能到达两次」写进限制文档。

配套把通知的稳定 id 放进消息 `source`（`workerReportSource` 已带 `childId`、`name` 等字段），这样重复投递在会话日志与客户端里是同一个 id，可识别、可去重；不假设宿主按 message id 去重——那不在本仓可验证的契约里，而且 inbox 拒收同 id 并存，按 id 去重的方向根本走不通。

放弃的替代方案：先写「投递中」状态再投、投完删。多一次写盘只把窗口从「投→标记」挪到「标记→投」，没消除窗口，还多了一条中间态要清理。

### 任务投递不加幂等键，改为把回执语义说清

`message_worker` 不做去重：插件分不清「模型重试」与「leader 真的要再投一次」，加一个模型必须正确填写的 messageId 字段，填错就是静默重复，比现在更糟。改为在工具描述与回执文案里说明「消息并入当前或下一轮，不保证只投一次」，让 leader 按这个语义组织动作。

与上一条不矛盾：**回报（worker → leader）** 由插件自己产生，id 可控，所以能给稳定 id；**派工（leader → worker）** 的 id 由模型生成，不可控，所以不给键、只把语义写清。

### 并发补投的窄窗口一并收口

`flushWaiting` 在循环前读一次 `pending` 快照，`redeliverPending` 若在快照之后完成投递并 `markDelivered`，`flushWaiting` 会按过期快照再投一次。改为每条投递前重新核对 `pending`——`delivering` 闸只在投递进行中有效，投完之后它就放行了。

这只会多投一次、不会丢，改它是为了让重复次数可预期，便于按 at-least-once 排障。

## 边界

- **在飞队列仍是内存态**：进程崩溃窗口不变，重启后那一轮不结算，leader 只能自己 `read_worker_session` 回看。落盘在飞记录不在本提案范围。
- **续行上限更容易撞**：队列化后 leader 一次投多条会积累多条回报，`autoResumeLimit`（默认 8）按父会话计，撞上限的通知停在盘上等人工开口，界面无提示。这是既有取舍，队列化只是让它更常出现。
- **通知队列损坏即整队丢弃**：`notification-store.js:59-64` 备份后返回空队列，只留一行日志。不在本提案范围。
- **队列化的前提是「一条 followup 一个 turn」**：若宿主改成一次 turn 消费多条 `next-turn`，队列与轮次会错位。这条依赖记在这里，宿主升级时按 `inbox.claim` 的实现核对。
- **「待落盘」槽是新的一处内存态**：摘下队首后进程被杀，那条通知既不回队列也没落盘——窗口从「结算→落盘」挪到「摘→落盘」，长度是两次内存操作。要彻底消掉得把「已摘」也落盘，代价与整表落盘相同，不在本提案范围。
- **中断清理不能只靠事件**：`interrupt` 之后宿主是否一定发 `turn/end`（`reason` 是什么）本仓没有契约可依，所以清理要同时挂在会话销毁路径与超时兜底上。
- **只影响 leader 投递的轮次**：人下钻跟 worker 直接对话的轮次不进在飞表，行为不变。

## 验收标准

**现状证据**（2026-11-03，复用 `tests/dispatch.test.js` 夹具的探针，非真机）：

- 在飞覆盖：`inflight after 2nd message: 1`、`worker 收到消息数: 2`、`第一轮结算: true delivered: 1`、`第二轮结算: false delivered: 1`、`pending in queue: 0`——第二轮的回报既没送达也没留在队列里。
- 补投重复：`markDelivered` 失败一次 → `首投 delivered: 1, pending: 1`；调 `redeliverPending` → `补投成功条数: 1, delivered: 2`。
- 结算重试吃轮次（审查补测）：在飞两条 + 首次 `enqueue` 失败 → leader 只收到一条回报，另一条滞留。
- 在飞记录残留（审查补测）：`interrupt` 之后不走 `turn/end` 的路径上，`describeRoster` 仍判该 worker 在跑。

**落地时必须有的回归用例，每条都做「撤销修复 → 用例变红 → 还原 → 全绿」**：

1. 在飞续投两轮各自结算一条：第二次 `message_worker` 后两条 `turn/end` 各送出一条回报，`delivered` 累计 2。
2. 队列内摘要不串轮：两轮 assistant 文本不同，两条通知的正文各自对应自己的轮次（钉 `turnText` 按记录绑定）。
3. 落盘失败重试不占后续轮次：队首 `enqueue` 失败 + 其后两轮 `turn/end`，三条通知都在、正文各归其轮。
4. `reassignParent` 迁移队列：在飞两条时接管父会话，`moved` 返回 2，两条通知都投给新父会话。
5. `interrupt` / 归档清队列：清理后 `describeRoster` 不再判该 worker 在跑，`inflightCount()` 归零。
6. `flushWaiting` 对已投出的通知不重复投；补投后 leader 只被唤醒一次。

现有 `tests/dispatch.test.js` 的「一轮只结算一次回报，重复上报不重复唤醒」与「通知落盘失败时保留在飞记录」两条断言不能改弱——它们钉的是同一批不变量。
