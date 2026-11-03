# worker 必须自己挂 agent preset，否则没有 bash / read

## 背景

合并 #17 / #19 之后，在 dsh-leader-kit 项目里派出的 worker 打开后没有任何内建工具：没有 `bash`，没有 `read`，任务里的 `pwd` 都跑不了。协调者会话正常。

### 根因

宿主的工具面分两层：全局注册的工具 + **agent preset 组合**里的工具。内建件属于后者（`packages/bundle/web-app/presets/standard.patch.yml` 逐条挂插件行 `tool-bash` / `tool-pwsh` / `tool-fs` / `tool-fs-search`；`read` / `write` 是 `tool-fs` 提供的工具名），而挂 preset 只由 `sessionController` 的 `composeAgent()` 做——创建与 resume 两条路径都走它。

本 bundle 的 worker 为了常驻、可下钻、冷恢复，直接走 `agents.create({ sessionId })`——它接受 `setup`，但不会自己解析或挂 preset。于是 worker 的作用域里只有全局工具，内建工具全缺。

#17 把**协调者**建会话改走 `sessionController.create`（预生成 id 先登记身份），协调者因此拿到了 preset；worker 与「没有 `sessionController` 时建协调者」的回退路径没跟着改，问题就露在 worker 上。

## 决策

新增 `src/host/agent-preset.js`，两个出口：

- `agentPresetOptions(ctx, logger)`：`presets.resolve()` 拿默认 preset，返回 `{ agentPreset, setup }`。`setup` 挂组合，`agentPreset` 写进 `meta`——宿主的 `meta.agentPreset` 是公开字段，`sessionController` 建会话时就写它，resume 与 UI 都从这个投影读回；只挂不写，投影永远是空的。
- `agentPresetResumeSetup(ctx, logger)`：冷恢复按**会话投影里记的 preset** 挂，旧会话没记录时省略 id 用默认。读投影走 `ctx.get('sessionProjections').stateOf(session, 'agentPreset')`——rc.2 的 registry **没有** `presetForSession()`（那是 sessionController 的方法，registry 到 0.2.2-alpha.2 才有），按 `engines.dsh` 下限只能读投影服务。

三处调用点都摊上：

- `worker-sessions.spawn()`：建 worker 时传 `setup` 与 `meta.agentPreset`；
- `worker-sessions.send()` 的冷恢复分支：`agents.resume()` 建的是新作用域，preset 不会自己回来；
- `projects/service.js` 的 `createCoordinatorSessionWithCtx()` 回退路径（没有 `sessionController` 的 profile）。

**Fail Loud**：`agentPresets` 服务不存在时退化并记一行日志（headless / sdk 本就没有 preset 层）；服务在却缺 `mount()` / `resolve()` 属于宿主契约变化，直接抛错——静默退化会让 worker 再次没有 bash / read，正是这次要修的故障形态。

### 顺带修的邻近缺陷

`applyToolGate` 原先用 `agent.ctx.tools.get(name)` 探测那三件宿主 subagent 工具是否存在。`get(name)` 省略 scope 等于**全局视图**，而 web-app 把这三件在宿主平面 `disabled: true`、改由 preset 子树注册——全局视图里没有它们，探测把三件全判成「不存在」，限制根本没生效（协调者仍能看到 `interrupt_agent`，对 worker 返回假成功回执）。

改成直接 `restrict({ deny })`，整批失败时逐件重试、跳过缺件；只吞宿主那句 `names unknown global tool`，其它错误照常抛出。

## 边界

- worker 现在拿到的是**整个标准组合**，不只是 bash / read：persona、`agent-instructions`（会读项目 AGENTS.md）、`time-context`、`subagent` / `workflow`、`ask_user_question`、`todo`、`web` 等都在。常驻后台会话因此也能向用户提问——这是「变成官方标准会话」的预期结果，用之前要知道。
- 摘掉 `list_agents` / `send_message` / `interrupt_agent` 后，preset 提供的 `subagent` / `subagent_fork` 仍在，协调者「能派不能跟」。这两个是通用能力，暂留；协议层立场是协调者不拿它们当 worker 用。
- `agentPresetOptions()` 建会话时先 `resolve()`（一次 `diagnostic()`）再 `mount()`（`retain()` 里又一次），都在缓存后；只是建 worker 的路径上多一次审计。真机读数时顺带看建会话延迟。
- 会话投影里记的 preset 若已被删除，冷恢复会在 `mount` 抛 `agent-preset/not-found`，冒到协调者的 `message_worker` 回执上。与官方 `sessionController.composeAgent` 的行为一致，Fail Loud 合理；错误文案带宿主内部口吻，要不要包装以后再说。
- 这类「绕开官方建会话路径就要自己补组合」的缺口与 `get()` 探测面的坑都记在 `docs/capability-gaps.md` 第 38 条。

## 验证

- 单测 439 → 448：worker 建会话挂 preset 且写 `meta.agentPreset`、冷恢复按投影挂、缺 `mount()` 当场报错、缺服务记日志、协调者回退路径同样写投影、preset 子树注册的三件工具仍被 deny、非「未知工具名」错误照常抛出。
- 夹具只给 rc.2 真实有的方法：preset 假件只有 `resolve` / `mount`，投影走 `sessionProjections.stateOf`；投影值故意取 `custom`（与默认 `standard` 不同），否则「读了投影」和「用了默认」区分不出来。上一版夹具多给了一个 `presetForSession`，让用例在下限版本上其实不成立。
- 双向验证：撤掉对应调用点 / 把 gate 改回 `get` 探测 / 把契约错误改成静默退化，各使对应用例变红，还原后全绿。
- 未做真机复验：需要 web profile 实例派一次工，读 worker 首轮的工具 schema。
