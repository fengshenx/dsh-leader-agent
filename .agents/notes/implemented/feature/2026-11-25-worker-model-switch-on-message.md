# Agent Note: worker 续聊换模型

Status: implemented

## Problem

`spawn_worker` 能在建会话时选模型（见 [worker 模型选择](2026-11-25-worker-model-selection.md)），但 worker 一旦派出，route 就锁死：任务难度变了、原模型不可用或太慢时，leader 只能新派一个 worker 丢掉上下文，或请人打开会话手工换。`message_worker` 是唯一的续聊入口，却没有 `model` / `effort`。

## Decision

- **`message_worker` 新增可选 `model` / `effort`**，与投递同一次完成：不填保持 worker 当前选择；只给 `effort` 套在当前模型上；换模型没给 `effort` 用新模型默认（旧 effort 不跨模型套用）。裸模型 id 沿用 **worker 自己的** provider——续聊不是重新派工，不该被 leader 的 route 带着走。
- **与派工共用解析与预检**：写法、长度上限、`llm.resolveCallConfig()` 校验同一套；校验失败不投递、不改登记表。
- **切换先于投递**：worker 正在跑时，新 route 从当前轮次的下一步生效；空闲或冷恢复时，这一条消息的首步就用新 route。
- **两代宿主各走各的入口**：0.2.2+ 用 `agent.model.select()`（追加 `model/selection`、与模型选择器共用持久投影）；rc.2 没有 per-agent 选择 API，改 live `agent.options` 并手工补 `model/selection` 事件。不调 `sessionController.selectModel()`——它会把 worker 的 route 存成用户的全局默认模型。
- **落盘两条路**：登记表新增 `setModel()` 写 `agentOptions` 与 `modelSource: 'message'`，供 rc.2 冷恢复读回 route；会话日志的 `model/selection` 供新宿主还原。在飞记录与完成通知的模型标签同时改成新 route，失败回报不再报切换前那条。
- **回执可审计**：工具结果与渲染带上新 `model` / `effort`，来源标「续聊指定」。

## Alternatives considered

- **复用 `sessionController.selectModel()`**：公开、跨版本，但它顺带把选择保存成用户默认模型，还会走控制器的 resume 路径；换一个 worker 不该改用户下一条新会话的模型。
- **销毁旧会话、按新模型重新派工**：route 一定生效，但上下文与在跑回合全丢，也不符合「续聊」语义。
- **只写会话日志、不更新登记表**：新宿主能从 `model/selection` 投影还原，rc.2 的 `agents.resume()` 只认 `agentOptions`，冷恢复会静默回到旧 route。
- **沿用 `spawn_worker` 的 leader-provider 兜底**：同一角色换了 provider 后，裸模型 id 会突然解析到另一家供应商；用 worker 当前 provider 才符合「在原会话上原地换」。

## Consequences

- **只换已在跑的 worker**：`SLOTS.md` 槽位默认仍只在派工时用，改文件、换 leader 默认模型都不影响已派出的 worker；要影响就显式带 `model` / `effort` 续聊。
- **rc.2 的 GUI 占用是窄缝**：worker 被打开并下过指令后，session-controller 装的选择引用读请求头而不是 live `options`，退回路径可能不生效；0.2.2+ 的 `agent.model.select()` 没有这个问题。
- **登记表写失败只记日志**：切换已作用于 live agent，投递不因此回滚；重启后 rc.2 可能回到旧 route。
- **模型目录不变**：仍用 `list_worker_models` 查 route；`message_worker` 不替 leader 猜模型。

收益：leader 能在同一会话里按后验信息换模型、重试失败任务，不必为一次模型调整丢掉上下文或另开 worker。

## Testing

`tests/worker-model.test.js` 钉住续聊切换的来源与 effort 回落、裸 id 用 worker provider、缺当前 route / 缺 llm / 预检失败的报错；`tests/worker-sessions.test.js` 钉住 0.2.2+ 的 `agent.model.select()`、rc.2 改 options 并补事件、冷恢复后切换、宿主既无 model 也无 options 时报错；`tests/dispatch.test.js` 钉住切换先于投递、只换 effort / 只换模型、预检失败不投递、登记表与失败回报的新 route；`tests/worker-registry.test.js` 钉住 `setModel()` 落盘与缺记录不补写；`tests/message-worker-tool.test.js` 钉住参数校验、透传与回执渲染。
