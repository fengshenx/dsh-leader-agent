# worker 必须自己挂 agent preset，否则没有 bash / read

## 背景

协调者建会话改走官方路径后，派出的 worker 打开后没有任何内建工具——没有 `bash`，任务里的 `pwd` 都跑不了。内建工具挂在 agent preset 的组合里，而挂 preset 只由官方建会话路径做；worker 为常驻、可下钻、冷恢复直接走 `agents.create`，它接受 `setup` 却不解析也不挂 preset，于是只有 worker 缺。

## 决策

**建 worker 与协调者降级路径时自己挂 preset，并把 preset 写进会话投影。** 建会话时用 `presets.resolve()` 拿默认 preset，`setup` 负责挂组合，`meta.agentPreset` 同时写上——宿主 resume 与 UI 都从投影读回，只挂不写投影永远是空的。

**冷恢复按投影里记的 preset 重挂。** resume 建的是新作用域，preset 不会自己回来；读投影走 `ctx.get('sessionProjections').stateOf(session, 'agentPreset')`，旧会话没记录时省略 id 用默认。宿主 registry 在 `engines.dsh` 下限没有按会话查 preset 的方法，只能读投影。

**三处调用点都摊上**：worker 建会话、worker 续聊的冷恢复分支、没有 `sessionController` 的 profile 里的协调者回退路径。

**Fail Loud。** preset 服务不存在时退化并记一行日志（headless / sdk 本就没有 preset 层）；服务在却缺 `mount()` / `resolve()` 属于宿主契约变化，直接抛错——静默退化会让 worker 再次没有 bash / read，正是这次要修的故障形态。

**工具面裁剪直接 `restrict({ deny })`，不用 `tools.get(name)` 探测存在性。** `get()` 省略 scope 是全局视图，而这些宿主 subagent 工具在宿主平面被禁用、改由 preset 子树注册，全局视图里查不到，探测会把它们全判成「不存在」而让限制失效。整批 deny 失败时逐件重试、跳过缺件；只吞宿主那句「未知全局工具名」，其它错误照常抛出。

## 边界

- worker 现在拿到的是**整个标准组合**：persona、项目指令、时间上下文、`subagent` / `workflow`、`ask_user_question`、`todo`、`web` 都在。常驻后台会话因此也能向用户提问，用之前要知道。
- 摘掉 `list_agents` / `send_message` / `interrupt_agent` 后，preset 提供的 `subagent` / `subagent_fork` 仍在，协调者「能派不能跟」；协议层立场是协调者不拿它们当 worker 用。
- 建会话路径上多一次 preset 审计；投影里记的 preset 若已被删除，冷恢复会抛 `agent-preset/not-found` 并冒到 `message_worker` 回执上，与官方建会话路径一致。
- 「绕开官方建会话路径就要自己补组合」与 `get()` 探测面的坑见 [capability-gaps 第 38 条](../../../../docs/capability-gaps.md)。

## 验证

`tests/worker-sessions.test.js` 与 `tests/projects-service.test.js`：撤掉任一调用点、把 gate 改回 `get` 探测、或把契约错误改成静默退化，各使对应用例变红；还原后全绿。夹具只给下限版本真实有的 `resolve` / `mount` 与投影读取，投影值取非默认值以区分「读了投影」与「用了默认」。
