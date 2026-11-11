# 撤销 leader 会话改走创建时的 AgentHandle

## 背景

`src/host/projects/service.js` 的 `abandonLeaderSession()` 原先用 `ctx.get('agents').get(sessionId)` 拿 agent，再 `agent?.dispose?.()`。rc.2 的 `agents.get()` 返回**裸 `Agent`**（`packages/core/agent/src/index.ts:568-569`），运行时面里没有 `dispose`（`runtime-types.ts:164-231`），于是这句是可选链 no-op：不停止会话、不报错、也不记日志。函数注释却写着「撤销失败必须记日志，不能静默吞掉」——正好相反。

发现于 PR #128 的审查（非该 PR 引入）。

## 决策

### 句柄是唯一的停机能力

rc.2 没有「按 id 停掉已存在会话/agent」的公开入口：

- `ctx.agents.get(id)` 返回裸 `Agent`（`packages/core/agent/src/index.ts:568-569`）；
- `ctx.sessions` 只有 `create` / `get` / `list` 等，没有按 id 移除的入口（`packages/core/session/src/index.ts:1111`、`:1352`）；
- `sessionController.create()` 只回 `SessionCreateValue { sessionId, agentPreset? }`，handle 留在宿主手里（`packages/api/session-controller/src/types.ts:299-305`）。

唯一能停掉 agent 的是 `agents.create()` / `agents.resume()` 返回的 `AgentHandle.dispose()`（`packages/core/agent/src/index.ts:147-163`；实现 `packages/core/agent-loop/src/index.ts:594-600`）：停 loop、等退场、摘注册表、把会话从 store 移除。句柄是 capability，只交给创建方。

**不用 `agents.resume()` 去补拿句柄**：对已经存在的会话它会抢写句柄（#126 / PR #128 修的正是这类冲突）。

### leader 会话改由本 bundle 用 `agents.create` 建

`sessionController.create` 的返回值里没有句柄，走后它就永远撤销不了。leader 会话于是和 worker 一样走 `agents.create`：

- `createLeaderSessionWithCtx` 返回 `{ sessionId, handle }`；
- `openRegisteredLeaderSession` 把创建结果原样交给 `create()` / `replaceLeader()`；
- `abandonLeaderSession(created)` 只做一件事：拿到 `handle.dispose` 就调，拿不到就大声记日志。

代价是 `sessionController` 在创建时做的组合要自己补：`agents.create` 不解析也不挂 preset、默认模型要自己给。这两件事 `agentPresetOptions` 与 `agentDefaultModel` 已经在 worker 路径上做过了，leader 复用同一套。行为差异只有错误映射（官方路径会把 cwd / preset 冲突翻成 `RemoteError`）：leader 用预生成的随机 id、目录在创建前已校验，这两类冲突不会发生。

## 边界

- **只撤销本 bundle 创建的会话**：撤销依赖创建时拿到的 `AgentHandle`；宿主自己没有按 id 停 agent 的公开能力。建会话的实现没交回句柄时（契约破口）只记日志，会话留在左栏「未分组」里，不假装成功。
- **`deleteProject` 不变**：`remove()` 只删项目记录，不碰会话与目录；leader 会话是用户的会话历史，删项目时保留。撤销只发生在 `create()` / `replaceLeader()` 的落盘失败路径，以及建会话 id 与预定 id 不一致的契约错误路径。
- **退役 leader 不撤销**：`replaceLeader` 成功后旧 leader 降级为项目里的普通会话，句柄不消费；只有新会话写盘失败时才撤销新会话。
- **不保留旧的双路径**：`sessionController.create` 不再用于 leader。它原本是「官方完整路径」，但返回值不暴露句柄；在项目落盘失败需要回滚的场景里，这条路径不可能完成撤销。
- 真实宿主上 `agents.create` 建根会话是 worker 的生产路径；leader 复用它，不新增宿主 API 依赖。本次没跑 e2e：没有客户端改动，且现有 e2e 场景都靠预置 `projects.json` 起项目，不覆盖「新建项目」这条 UI 路径。

## 验证

- 更新 5 条、新增 1 条用例（`tests/projects-service.test.js`）：
  - 建 leader 会话挂 preset，并断言 `createLeaderSessionWithCtx` 把 `AgentHandle` 交回；
  - 建项目落盘失败时调用 `handle.dispose()`；
  - 句柄 dispose 抛错时只记日志、不掩盖原始错误；
  - 建会话路径没交出 `AgentHandle` 时大声记日志（不再静默）——新增；
  - 建会话 id 与预定 id 不一致时撤销建成的那条；
  - 走 `agents.create`、不碰 `sessionController` 与工作区。
- 夹具按宿主真实 API 面构造：`agents.create` 返回 `{ agent, dispose }`，`agents.get()` 不再被调用（旧夹具给了宿主没有的 `get().dispose`，正是静默 bug 的来源）。
- 双向验证（`tests/projects-service.test.js`，53 例）：
  - 撤掉 `abandonLeaderSession` 里的 `handle.dispose()` → **53 / 50 pass / 3 fail**：「建项目落盘失败时撤销…」「撤销失败只记日志」「id 不一致…」三条红；还原 → 53 / 53，全绿。
  - 把无句柄分支改回静默 `return` → **53 / 52 pass / 1 fail**：「没交出 AgentHandle 时大声记日志」红；还原 → 53 / 53，全绿。
- `npm test`：1122 tests / 1105 pass / 17 skip / 0 fail。
- `npm run check`：全绿（Note 格式、文档工具名、文档预算、语法 108 文件、覆盖率 1105 用例；`src/host/projects/service.js` 行覆盖 97.85%，门槛 97%）。
- 未跑 `npm run e2e`：没改客户端，现有场景也不覆盖「新建项目」；leader 创建改道只由单测守。
