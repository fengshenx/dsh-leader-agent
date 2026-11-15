# worker 改成常驻根会话

## 背景

worker 要能**常驻**，人要能**下钻到 worker 的会话继续对话**。原来建在宿主 subagent 机制上：下钻时输入框不存在，正文显示「此子智能体暂时只读 / 父会话当前不在线」——subagent 的输入能力由宿主按 `address.mode` 与父会话可用性决定，第三方改不了；常驻同样做不到，宿主结算后即 `close()` + `finishDisposal()`，没有 keepAlive 开关。

> **2026-11-13 补记**：后续宿主用 continuable subagent 补上了可对话、冷恢复与 completion notice 唤醒，「只读 / 无法常驻」只对 one-shot 地址成立，不再是 subagent 的通用结论。选根会话的理由改为形态与归属，见 [subagent 能力的重新校准](2026-11-13-subagent-capabilities-rationale-calibration.md)。

## 决策

- **worker 用 `agents.create()` 建普通根会话**：生命周期由本模块持有的 `AgentHandle` 决定（不 `dispose` 就一直活着）；侧栏可打开、可直接输入，人下钻不需要宿主配合；独立 JSONL，进程重启后 `agents.resume()` 能接着跑。id 用 `worker-${randomUUID()}`，让排障时一眼看出这是谁建的。
- **完成信号由机制侧从 `session/event` 的 `turn/end` 结算**，worker 不再调工具上报，`worker_done` 工具与协议层「每轮必须调一次」一并删除（见 [worker 的完成回报由机制侧从会话事件结算](2026-10-29-worker-report-by-session-events.md)）。
- **人自己下钻聊的轮次不打扰协调者**：只有 `dispatch` / `message` 时登记进在飞表的轮次才可能被结算。
- **工具面判定改用登记集合**：`applyToolGate` 同步执行、登记表是异步的，所以另存一份内存 `workerIds`——spawn / resume 前加入，启动时按落盘登记表 `adopt()` 灌入。先 `add` 再 `create` 是有意为之：`agent/created` 在 create 内部就发出来。
- **项目树分组判据跟着换**：`isWorkerSession` 从可选改成必需参数（`createProjectService` 同样断言必需），`origin === 'subagent'` 的退回分支删除——worker 已无这个标记，留着只会让漏传参数的调用方静默丢掉整棵项目树。
- **归档要连带销毁会话**：常驻会话不会被宿主回收，`detachSession` 里补一次 `workerSessions.dispose(sessionId)`，否则用户以为归档了、它还在内存里跑。
- **官方工作区树的排除集必须显式包含 worker 会话**（此前靠宿主自动滤掉 subagent 行），计算抽成纯函数 `collectExcludedSessionIds` 以便单测。
- **不做空闲回收**：做了就回到「用完销毁」；常驻到归档或应用退出，未归档 worker 上限 50（`force` 逃逸）因此成为必要护栏。
- **宿主 API 面按 `engines.dsh` 下限挑**：探测「某工具是否已注册」用 `ctx.tools.get(name)` 而非 `definitions()`（后者 0.2.2-alpha.2 才加，而这个调用落在 `agent/created` 上，用错就是每个会话创建都 `TypeError`）；测试夹具也只给下限版本就有的方法，多给一个就会掩盖版本缺口。
- **deny 之前先确认工具真的注册了**：`restrict()` 对未注册的全局工具名直接抛错，而 deny 名单来自可被部署禁用的宿主组合；只 deny 当前存在的。本 bundle 自己注册的工具不做这层过滤——那些缺失是装配错误，应该大声报出来。

## 边界

- **「人下钻后输入框存在」只有真机取证，没有自动化用例**：判据在宿主 UI 里，本仓不引 jsdom。
- **进程重启后的真实冷恢复没有在真机上跑过**：单测用假 `agents.resume` 覆盖了调用与投递，宿主从 JSONL 恢复会话的行为未取证。
- **`agent/created` 与 `workerIds.add` 的时序没有用例可观察**，只有调用顺序作证。
- **失败路径必须清理**：spawn 失败撤掉刚登记的 `workerIds`（否则该 id 永远被判成 worker）；建会话后绑卡失败 `dispose` 刚建的会话，且改名推迟到绑定成功之后——零 turn 会话没 materialize，磁盘上不留半成品；冷恢复失败只回滚本次新登记的身份，不抹掉已收编的 worker。

## 验证

`tests/worker-sessions.test.js` 与 `tests/tool-gate.test.js` 钉住会话形态、登记集合、归档销毁与工具面。真机读数要证明新行为出现了（普通会话的请求头里少了哪几项工具），不是「日志没有红色输出」——上一轮「验证」时一个 agent 都没创建，日志干净恰好说明什么都没发生。
