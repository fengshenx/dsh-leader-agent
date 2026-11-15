# Agent Note: 派工与唤醒机制

Status: implemented

## Problem

dsh 原生的 subagent 工具是阻塞式：父 agent 调工具 → 子 agent 跑完 → 工具返回，父 turn 卡在调用处，与「派完活继续思考、worker 结束后协调者被自动唤醒」的协调者模型相反；宿主没有等价的「完成唤醒」机制，这个缺口必须自建。

## Decision

**派工原走 `ctx.subagents.startActivation({ delivery: 'caller' })`**，不自己造子会话：它让结果由调用方处理，工具立即返回子会话 id，`activation.result` 是终态 promise，是当时唯一可用的非阻塞入口。

> **2026-10-29 修订**：这条已被推翻。subagent 结算即销毁、界面上只读，worker 既不能常驻也不能由人下钻对话。派工改走 `ctx.agents.create()` 建普通根会话。理由与新机制见 [worker 常驻化与交作业](2026-10-29-worker-as-root-session.md)；本文件其余决策（唤醒走 `followup`、通知先落盘、队列串行化、服务惰性获取）仍然有效。
>
> **同日再修订**：完成信号最终不是由 worker 调工具上报，而是 `dispatch.js` 订阅 `session/event`、在 `turn/end` 时折叠产出。原计划的机制方向（结算由机制侧做）复活了，只是入口从 `activation.result` 换成了会话事件（见能力第 39 条）。

**唤醒走 `agent.followup()`**（当时判断它是唯一能开新 turn 的入口）：它向 `next-turn` 边界投消息并开新 turn。唤醒失败的真因不是 inbox 投影未注册，而是**父会话已被销毁**（headless 一次性 CLI 在 turn 结束后 dispose 会话）；只要父会话存活，对空闲 agent 调 `followup()` 就能可靠唤醒。

> **2026-11-06 修订**：「唯一能开新 turn 的入口」不再成立——`agent.steer()` 在会话空闲时同样直接开轮（next-step 边界），worker 续聊已改走 `steer`；完成通知（worker → leader）仍走 `followup` 的 next-turn。见 [续聊消息改走 next-step 边界](../bug-fix/2026-11-06-worker-message-next-step-injection.md)。

**完成通知先落盘再唤醒**：唤醒是「投消息 + 开新 turn」，进程在唤醒前崩溃会导致通知丢失，落盘队列是崩溃窗口的唯一防线。

**落盘队列的所有读-改-写走同一条 promise 链串行化**：多个 worker 同时完成时，交错读写会互相覆盖并争抢同一临时文件。

**`sessionController` 用 `ctx.get()` 惰性获取，不声明为必需 inject**：它只挂在 web-app bundle 上，声明成必需依赖会让不含该服务的 profile 整个插件挂起；缺失时回退到派工时持有的父 agent 活对象。

**`agents` 注册表在插件根作用域不可见**（agent-scoped 服务），因此唤醒与补投只能依赖「派工时持有的 agent 活对象」加 `agent/created` / `agent/disposed` 事件，无法反查任意会话。

## Alternatives considered

- **继续用阻塞式 subagent 工具**：父 turn 卡在调用处，与「派完继续思考」相反；后来改用根会话，见 [worker 常驻化](2026-10-29-worker-as-root-session.md)。
- **自建 HTTP / 轮询唤醒**：宿主没有等价的完成唤醒入口，`followup` 是当时唯一能开新 turn 的 API；落盘队列补崩溃窗口。
- **把 `sessionController` 声明为必需 inject**：它只在 web-app bundle 上，声明必需会让 headless 等 profile 整个插件挂起。
- **新增 session event 类型送通知**：宿主要求仓外事件带 `ignorable` 且不进读路径，不能作为读侧真源。

## Consequences

- **后台编排只适用于长驻组合**（web / desktop / sdk）。headless 是一次性 CLI，父会话在 turn 结束后即销毁，没有载体接收通知——这是宿主语义，不是本 bundle 的缺陷。
- **不新增 session event 类型**：dsh 要求仓外事件带 `ignorable` 标记且不进读路径，完成通知因此走自有落盘队列。
- **bundle 零 dsh 内部依赖**：`engines.dsh` 的严格版本校验意味着任何依赖内部包的 bundle 都会周期性失效（`agent-team` 是活例）。

收益：派工不阻塞 leader，worker 结束后 leader 能被自动唤醒，通知跨崩溃不丢。

## Testing

`tests/dispatch.test.js` 与 `tests/notification-store.test.js` 钉住护栏、补投与并发写队列。双向读数：撤掉落盘队列的串行链，并发完成用例读到临时文件争抢或通知互相覆盖而变红。
