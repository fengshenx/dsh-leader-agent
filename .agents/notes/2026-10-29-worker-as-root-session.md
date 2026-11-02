# worker 改成常驻根会话

**状态**：implemented（2026-10-29）
**范围**：`src/host/worker-sessions.js`（新）、`src/host/tools/worker-done.js`（新）、`src/host/dispatch.js`、`src/host/tools/gate.js`、`src/host/index.js`、`src/host/projects/session-index.js`、`src/host/projects/service.js`、`src/host/projects/remote.js`、`src/client/project-panel.js`、`src/client/project-panel-logic.js`、`README.md`、`skills/leader-mode/`、测试

## 背景

用户提出两条产品需求：worker 要能**常驻**（不是用完即销毁），而且人要能**下钻到 worker 的会话继续对话**。

原实现把 worker 建在宿主的 subagent 机制上（`subagents.startActivation`）。实测下钻到 worker 会话时输入框根本不存在，正文显示「此子智能体暂时只读 / 父会话当前不在线，重新打开父会话后即可继续发送消息」。源码里的判据是 `ui-subagent/src/client/index.ts` 的 `selectReadOnlySubagent()`：`address.mode === 'one-shot'` 直接判只读，父会话不可用且会话没在跑也判只读。也就是说 subagent 的输入能力由宿主按 catalog mode 与父会话可用性决定，第三方改不了。

常驻同样做不到：`subagent/src/manager.ts` 的 `watchLocalSettlement()` 循环到 `settlementState()` 返回 `ready` 就 `close()` + `finishDisposal()`，没有 keepAlive 开关。

## 决策

**worker 改用 `agents.create()` 建普通根会话**（`src/host/worker-sessions.js`）。三条依据：

1. 生命周期由本模块持有的 `AgentHandle` 决定，不 `dispose` 就一直活着；
2. 会话是普通会话，侧栏可打开、可直接输入，人下钻对话不需要宿主配合；
3. 根会话有独立 JSONL，进程重启后 `agents.resume()` 能接着跑，续聊的语义不变。

会话 id 用 `worker-${randomUUID()}`：根会话没有 `origin` 标记，前缀让排障时一眼看出这是谁建的。

> **2026-10-29 修订：完成信号不再由 worker 自报，改为机制侧从会话事件结算。**
> 原文的「宿主没给第三方留读最后一轮产出的稳定 API」不成立：`session/event` 是公开
> 事件，`turn/end` 是真正的 session event 且带终态 `reason.kind`，`sessionQuery.readSession()`
> 也返回完整 `SessionEvent[]`。宿主自己的 subagent 就是这么做的（`captureLocalResult()`
> 从会话事件折叠产出与 stopReason）。改法：订阅 `session/event`，`turn/end` 到期时
> 折叠这一轮的 `assistant/message` 文本与 `reason.kind`，再走原有的落盘与唤醒。
> `worker_done` 工具删除，`WORKER_ONLY_TOOLS` 随之消失，协议层「每轮必须调一次」的
> 要求一并撤掉——回报不再占工具面，也不再依赖模型自律。下两段的「依赖 worker 真的
> 去调」这条代价随之消失，其余判断（人直聊不结算、登记集合、归档连带销毁、官方树
> 排除）仍然有效。细节见 [能力第 39 条](../../docs/capability-gaps.md)。

**完成信号改由 worker 自报（`worker_done` 工具）**。根会话没有 `activation.result` 那样的终态 promise；宿主也没给第三方留「读最后一轮产出」的稳定 API（`Session.snapshotEvents` 已标废弃，`sessionQuery.observeSession()` 只返回会话头）。让 worker 收尾时自己调 `worker_done({ summary, outcome })`，派工器据此结算并唤醒协调者——与宿主完成回调等价，而且谁调的、报了什么都在会话历史里可查。

代价是**依赖 worker 真的去调**。这靠两处兜住：工具描述里写明「派工与续聊的每一轮都要调一次，否则协调者收不到回报」，`worker_done` 也只出现在 worker 的工具面上。

**人自己下钻聊的轮次不打扰协调者**。只有协调者 `dispatch` / `message` 时登记进 `inflight` 的轮次才可能被结算；人直聊不经过本模块，没有在飞记录就不会产生通知。

**工具面判定改用登记集合**。`applyToolGate` 同步执行，而登记表是异步的，所以 `worker-sessions.js` 另存一份内存 `workerIds`：spawn / resume 前加入，启动时按落盘登记表 `adopt()` 灌入。判据替换了原来的 `agent.session.header.origin === 'subagent'`。

**项目树的分组判据也换**：`groupSessionsByProject` 的 `isWorkerSession` 从可选改名成必需参数（原来的 `origin === 'subagent'` 退回分支删除——worker 已经没有这个标记，留着只会让漏传参数的调用方静默丢掉整棵项目树）。`createProjectService` 同样断言必需。

**归档要连带销毁会话**。常驻会话不会被宿主回收，`detachSession` 里补一次 `workerSessions.dispose(sessionId)`，否则用户以为归档了，实际它还在内存里跑、还在写会话日志。

**官方工作区树的排除集加上 worker 会话**。原先靠宿主 `sessionVisible()` 自动滤掉 subagent 行；worker 现在是普通会话，不排除就会同时出现在官方树与项目树里。排除集的计算抽成纯函数 `collectExcludedSessionIds(projects, sessionsByProject)` 以便单测。

**不做空闲回收**。做了就回到「用完销毁」。常驻到归档或应用退出，未归档 worker 上限 50（`force` 逃逸）因此成为必要护栏。

**宿主 API 面按 `engines.dsh` 下限挑，不按本机最新版**。工具面裁剪里要探测「某工具是否已注册」，用的是 `ctx.tools.get(name)` 而不是 `definitions()`——后者是 `0.2.2-alpha.2` 才加的，`engines` 下限 `0.2.1-rc.2` 上没有它，而这个调用落在 `agent/created` 上，用错就是每个会话创建都 `TypeError`。`tests/tool-gate.test.js` 的夹具照 rc.2 的方法面构造（只有 `restrict` / `get` / `schemas`）：夹具多给一个宿主方法就会掩盖版本缺口。

**deny 之前先确认工具真的注册了**。`restrict()` 遇到未注册的全局工具名直接抛错，而 `COORDINATOR_UNUSABLE_TOOLS` 来自可被部署禁用的宿主组合（`agent-team-profile` 就把它 `disabled: true`）。所以只 deny 当前存在的；本 bundle 自己注册的工具不做这层过滤——那些缺失是装配错误，应该大声报出来。

## 验证

- `npm run check`：405 例全绿（新增 `worker-sessions.test.js` 18 例、`worker-done-tool.test.js` 7 例，重写 `dispatch-continuation.test.js` 与 `tool-gate.test.js`）。
- 回归有效性双向验证（九组，精确撤销后对应用例变红，还原后全绿）：
  - 撤 `workerSessions.spawn` 里的 `followup(taskMessage(...))` → 「建会话时用带前缀的会话 id，并把任务简报即刻投进去」红。
  - 撤 `reportDone` 里的 `inflight.delete` → 「一轮只结算一次回报，重复上报不重复唤醒」红。
  - 把分组判据换回 `session.origin === 'subagent'` → 6 条分组用例红。
  - 撤 `detachSession` 里的 `workerSessions.dispose` → 「归档 worker 会话时顺带销毁常驻 agent」红。
  - 撤 spawn 失败分支里的 `workerIds.delete` → 「建会话失败时不留 worker 身份」红。
  - 撤 followup 失败分支里的 `disposeOne` → 「任务投递失败时销毁刚建好的会话，不留孤儿」红。
  - 撤协调者 deny 里的 `COORDINATOR_UNUSABLE_TOOLS` → 「协调者拿不到收作业的工具，也拿不到对 worker 无效的三件宿主工具」与 `applyToolGate` 用例红。
  - 撤掉「按当前已注册工具过滤」那层 → 「宿主没装 subagent 控制工具时跳过那三件」红。
  - 把工具探测换回 `definitions()`（0.2.2-alpha.2 才有，engines 下限 0.2.1-rc.2 没有） → 「只依赖 engines 下限的 tools 方法面」与另外两条红（`TypeError: definitions is not a function`）。
- `npm run build:client` 通过。
- 真机（`dsh 0.2.1-rc.2` + mock provider）：普通会话的 `request/header.tools` 共 39 个，`spawn_worker` / `message_worker` / `list_cards` / `worker_done` 全被裁掉，三件宿主工具保留。

**真机验证要证明代码路径被执行过，不能只证明没有报错。** 上一轮的真机「验证」是打开会话看日志没报错——可那次一个 agent 都没创建，`agent/created` 的处理器一次都没跑，日志干净恰好说明什么都没发生。可观测的判据是「预期的新行为出现了」（工具面少了哪几项），不是「没有红色输出」。

## 未覆盖

- **「人下钻后输入框存在」只有真机取证，没有自动化用例**。判据在宿主 UI 里，本仓不引 jsdom，无法单测。
- **进程重启后的真实冷恢复**没有在真机上跑过：单测用假 `agents.resume` 覆盖了调用与投递，宿主侧从 JSONL 恢复会话的行为未取证。
- **`agent/created` 与 `workerIds.add` 的时序**：先 `add` 再 `create` 是有意为之（`agent/created` 在 create 内部就发出来），但没有用例能观察到宿主内部的这个顺序，只有注释与调用顺序作证。
