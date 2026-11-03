# 派工与唤醒机制

**状态**：implemented（P1，2026-10-23）
**范围**：`src/host/dispatch.js`、`src/host/notification-store.js`、`src/host/tools/spawn-worker.js`

## 背景

dsh 原生的 subagent 工具是阻塞式：父 agent 调工具 → 子 agent 跑完 → 工具返回，父 turn 卡在调用处；这与「派完活继续思考、worker 结束后协调者被自动唤醒」的协调者模型相反。dsh 没有等价的「完成唤醒」机制，这个缺口必须自建。

## 决策

**派工走 `ctx.subagents.startActivation({ delivery: 'caller' })`**，不自己造子会话。`delivery: 'caller'` 让结果由调用方处理：工具立即返回子会话 id，`activation.result` 是终态 promise。dsh 原生 spawn 工具做不到「派完即返回」，这是唯一可用的非阻塞入口。

> **2026-10-29 修订**：这条已被推翻。subagent 结算即销毁、界面上只读，worker 既不能常驻也不能由人下钻对话。派工改走 `ctx.agents.create()` 建普通根会话。理由与新机制见 [worker 常驻化与交作业](2026-10-29-worker-as-root-session.md)；本文件其余决策（唤醒走 `followup`、通知先落盘、队列串行化、服务惰性获取）仍然有效。
>
> **同日再修订**：完成信号最终不是由 worker 调工具上报，而是 `dispatch.js` 订阅 `session/event`、在 `turn/end` 时折叠产出。原计划的机制方向（结算由机制侧做）复活了，只是入口从 `activation.result` 换成了会话事件（见能力第 39 条）。

**唤醒走 `agent.followup()`**——dsh 唯一能开新 turn 的入口。实测推翻了此前的判断：唤醒失败的真因不是 inbox 投影未注册，而是**父会话已被销毁**（headless 一次性 CLI 在 turn 结束后 dispose 会话）。只要父会话存活，对空闲 agent 调 `followup()` 就能可靠唤醒。

**完成通知先落盘再唤醒**。唤醒是「投消息 + 开新 turn」，进程在唤醒前崩溃会导致通知丢失。落盘队列是崩溃窗口的唯一防线。

**落盘队列的所有读-改-写走同一条 promise 链串行化**。多个 worker 同时完成时，交错读写会互相覆盖并争抢同一临时文件（实测踩到过 `ENOENT: rename ... .tmp`）。

**`sessionController` 用 `ctx.get()` 惰性获取，不声明为必需 inject**。它只挂在 web-app bundle 上（`packages/bundle/web-app/cordis.patch.yml:121`），声明成必需依赖会让 headless 等不含该服务的 profile 整个插件挂起。缺失时回退到派工时持有的父 agent 活对象。

**`agents` 注册表在插件根作用域不可见**（agent-scoped 服务）。因此唤醒与补投只能依赖「派工时持有的 agent 活对象」加 `agent/created` / `agent/disposed` 事件，无法反查任意会话。

## 边界

- **后台编排只适用于长驻组合**（web / desktop / sdk）。headless 是一次性 CLI，父会话在 turn 结束后即销毁，没有载体接收通知。这是宿主语义，不是本 bundle 的缺陷。
- **不新增 session event 类型**。dsh 要求仓外事件带 `ignorable` 标记且不进读路径，完成通知因此走自有落盘队列。
- **bundle 零 dsh 内部依赖**。`engines.dsh` 的严格版本校验意味着任何依赖内部包的 bundle 都会周期性失效，`agent-team` 就是活例。

## 证据

sdk profile（dsh 0.2.1-rc.2）+ dsh 自带 mock LLM server，全链路一次通过：父派工 → 子会话建立并执行 → 子终态 → 父 inbox 收到「【worker 回报】…」→ 父状态 `idle → running → idle` → 通知队列 `pending: 0`。

护栏、补投、并发写队列由单测覆盖（`tests/dispatch.test.js`、`tests/notification-store.test.js`，共 32 例）。
