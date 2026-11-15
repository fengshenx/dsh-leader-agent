# Agent Note: 撤销 leader 会话改走创建时的 AgentHandle

Status: implemented

## Problem

`abandonLeaderSession()` 原先用 `agents.get(sessionId)` 拿 agent 再 `agent?.dispose?.()`。宿主返回的是裸 `Agent`，运行时面里没有 `dispose`，于是这句是可选链 no-op：不停止会话、不报错、也不记日志——而函数注释写着「撤销失败必须记日志」，正好相反。

## Decision

**句柄是唯一的拆除能力，只交给创建方。** 宿主没有「按 id 停掉已存在会话/agent」的公开入口：`agents.get()` 返回裸 `Agent`，`sessions` 只能建/查/列，`sessionController.create()` 只回会话 id、句柄留在宿主手里。唯一能彻底拆除的是 `agents.create()` / `agents.resume()` 返回的 `AgentHandle.dispose()`——停 loop、等退场、摘注册表、从活的 store 移除，但不删已落盘的日志。`Agent.cancel()` 只停当前 turn，归档只停工作并写归档集合，都不摘注册表。

**不用 `agents.resume()` 去补拿句柄。** 对已经存在的会话它会抢写句柄，正是 [先复用宿主活 agent](2026-11-11-session-write-handle-reuse.md) 那条修的冲突。

**leader 会话改由本 bundle 用 `agents.create` 建。** 走官方建会话路径就永远撤销不了，所以 leader 与 worker 同路：建会话的实现把 `{ sessionId, handle }` 交回，撤销时拿到 `handle.dispose` 就调，拿不到就大声记日志。代价是官方路径在创建时做的组合要自己补——preset 与默认模型复用 worker 路径已有的那套。行为差异只剩错误映射：leader 用预生成的随机 id、目录在创建前已校验，官方路径那两类冲突不会发生。

**不保留旧的双路径。** `sessionController.create` 不再用于 leader：它的「完整路径」在项目落盘失败需要回滚的场景里不可能完成撤销。

## Alternatives considered

- **继续用 `agents.get()` 后可选链 `dispose()`**：宿主返回裸 `Agent`，没有 `dispose`，整句是静默 no-op。
- **用 `agents.resume()` 补拿句柄**：会抢已有会话的写句柄，正是另一篇笔记修掉的冲突。
- **leader 继续走官方 `sessionController.create`**：它只回会话 id，句柄留在宿主手里，落盘失败时无法撤销。
- **用 `Agent.cancel()` 或归档代替撤销**：只停当前 turn / 工作，不摘注册表，活会话仍在。

## Consequences

- **只撤销本 bundle 创建的会话**：建会话的实现没交回句柄时（契约破口）只记日志，活会话留在左栏「未分组」里，不假装成功。
- **撤销不等于删除**：`dispose()` 只摘活会话，已落盘的日志仍在，进程重启后可能作为空会话重新出现（按宿主源码推断，未端到端复现）；宿主没有删除会话的公开 API。
- **`deleteProject` 不变**：删项目只删项目记录，不碰会话与目录——leader 会话是用户的会话历史。撤销只发生在建项目 / 换 leader 的落盘失败路径，以及建会话 id 与预定 id 不一致的契约错误路径。
- **退役 leader 不撤销**：换 leader 成功后旧 leader 降级为项目里的普通会话，句柄不消费；只有新会话写盘失败时才撤销新会话。
- 本次没跑 e2e：没有客户端改动，且现有场景都靠预置项目文件起项目，不覆盖「新建项目」这条 UI 路径。

收益：leader 会话在落盘失败或 id 不一致时能被真正撤销，不再留下无法关闭的活会话。

## Testing

`tests/projects-service.test.js`：撤掉 `handle.dispose()` 时撤销相关用例变红，把无句柄分支改回静默返回时「没交出句柄要大声记日志」变红；还原后全绿。
