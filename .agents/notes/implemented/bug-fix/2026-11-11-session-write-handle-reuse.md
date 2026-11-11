# message_worker 先复用宿主活 agent，再谈冷恢复

## 背景

`message_worker` 对某些旧 worker 稳定报宿主的英文错误：

```
Error: session "worker-…" is already owned by an active write handle
```

宿主的写句柄绑在 **agent 生命周期**上，不随 `turn/end` 释放：GUI 打开过的会话、以及宿主启动时恢复过的会话，在进程里是一个活 agent 并持有写句柄。本模块的 `send()` 只查自己的 `live` 表，未命中就 `agents.resume()` → 宿主 `open(id, 'write')`，撞上活 agent 的句柄被判重。完整调查见 #126。

## 决策

### 先复用宿主活 agent

`send()` 的查找顺序改成三层：

1. `live` 命中：行为不变，直接投给 `AgentHandle.agent`，回执 `live`；
2. 宿主里有活 agent（`ctx.agents.get(sessionId)`）：直接投给这个裸 `Agent`，回执也按 `live`；
3. 都没有：走原有 `resumeOnce()` 冷恢复，回执 `resumed`。

第二层是这次修的核心。`agents.get()` 返回的是裸 `Agent`，不是 `AgentHandle`——宿主把 dispose 能力只交给创建它的持有者。所以复用路径**不写进 `live`**：插件卸载、归档、`disposeAll()` 都不能替宿主收掉一个被人打开着的会话。代价是这类会话的 `get()` 仍报告「不在内存」，每条消息重新查一次宿主表；这正好把生命周期留在它该在的地方。

`renameTitle()` 跟着从收 `AgentHandle` 改成收 `Agent`，因为复用路径手上没有句柄。

### 错误翻译

冷恢复仍可能撞上写句柄被占（典型是**另一个 dsh 进程**持锁）。`SessionAlreadyOwnedError` 只按 `name` 判定，不匹配文案——rc.2 的宿主只设 `name`、没有 `code`，文案会随版本调整，夹具照这个真实面构造。翻成：

> message_worker: 会话 `<id>` 正被另一个会话窗口占用（宿主还在使用它），暂时不能把消息投进去；请先关闭打开它的窗口再试，或直接在那个窗口里继续对话。

原始错误放进 `cause`，宿主的类型、`sessionId` 与原文都保留给排障。文案相同但类型不对的错误原样抛出，不误伤。

## 边界

- **只解决同进程**：宿主活 agent 能被 `agents.get()` 拿到时才可复用。跨进程持锁（另一个 dsh 进程开着同一会话）仍然不能冷恢复，只能给出上面的提示。这条限制记在 `docs/limitations.md`。
- **teardown 窗口内有一个窄竞争，本 PR 不加防护**。宿主销毁会话的顺序是 cancel → whenIdle → `scope.dispose` → close → **最后**才从注册表摘除（rc.2 `agent-loop`），`agents.get()` 在这段窗口里仍能命中。用户关标签/归档与 leader 投递同时发生时，复用路径会拿到一个正在 dispose 的 agent 并 `steer`；宿主把「disposal 之后的 send」定为调用方 bug，后果可能是 `steer` 抛错，也可能消息静默丢失。不防护的理由：宿主没有暴露「正在 dispose」的可观测判据，事后重查一次 `agents.get()` 也只能缩小窗口、不能消除，还把一次投递变成两次判断；窗口窄且未实测，出现时按「重发」处理。
- 复用的会话不进 `live`，插件卸载后它仍在宿主里活着；这是有意的所有权边界，不是遗漏。
- 回执格式不变：`send()` 仍返回 `live` / `resumed`，`message_worker` 仍映射成 `merged` / `sent`。复用路径归 `live` → `merged`，因为宿主的空闲活 agent 收到 `steer` 会立刻开一轮，与插件自己的活 worker 同义。
- 宿主活 agent 若正在跑人自己发起的一轮，投递仍走 next-step 边界，与该轮的 `turn/end` 结算规则不变。

## 验证

- 单测 1121 → 1125，新增 4 个（`tests/worker-sessions.test.js` 34 → 38）：
  - `live` 未命中但 `agents.get()` 有活 agent → 直接投递、`resume` 未被调用、不登记进 `live`；
  - `get()` 返回 undefined → 仍走冷恢复；
  - `resume()` 抛 `SessionAlreadyOwnedError` → 人话错误，`cause` 是原错误；
  - 文案相同但 `name` 不对的错误不翻译。
- 夹具按宿主 rc.2 的真实形状补 `get()`：返回裸 `Agent`，`create` / `resume` 进活表、`dispose` 移除；`dispatch-continuation` 的「插件重启」场景同时重启宿主，`get()` 返回 undefined。
- 双向验证：撤掉「复用活 agent」分支 → 用例①红；撤掉错误翻译 → 用例③红；还原后全绿。读数记在 PR。
- `npm run check` 全绿（1108 通过 / 17 跳过；`worker-sessions.js` 行覆盖 100%）。
