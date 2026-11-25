# Agent Note: worker 续聊、工具面分配与会话折叠

Status: implemented

## Problem

三条需求：worker 派出去只能跑一轮、不能接着聊；leader、普通会话与 worker 的工具面没有区别；项目下的会话列表没有官方工作区树那套折叠。

## Decision

### 续聊走冷恢复，不复用宿主的 `send_message`

- `send_message` 是 dsh 自己的子会话协议，对根会话无效。另开 `message_worker(sessionId, message)`：worker 不在内存时用 `agents.resume()` 冷恢复根会话，再走 `agent.followup()` 投递；首条消息也由它投递（派工两段化的理由见 [spawn 之后由 message 开工](2026-11-02-spawn-then-message-and-card-context.md)）。
- **`delivery` 不进工具参数**：它是宿主侧的交付语义，让模型传等于把实现细节暴露到调用面；worker 的投递与唤醒由本 bundle 的 `followup` 与通知队列负责。
- **续聊必须能跨进程找回**：`agents.resume()` 只认 session id，所以派工时就把 `sessionId → { parentSessionId, task }` 落盘（`workers.json`，原子写 + 串行链 + 损坏备份）。不落盘，进程重启后这个 worker 就再也接不上话。
- **派工前置 Fail Loud 检查持久化后端**：缺 `sessionPersistence` 或 `sessionQuery` 时拒绝派工，不悄悄降级成「只能跑一轮」的 worker——用户以为能续聊、实际不能，比直接报错更糟。
- **在飞与已结算分开**：worker 还在跑时发消息，宿主会把消息并入当前轮；已结算才冷恢复并登记续聊。
- **续聊轮也用 `turn/end` 结算**：与首轮同一条 `session/event` 结算路径，不依赖 `activation.result` 或 subagent 事件。

### 工具面按角色裁剪，落在会话作用域上

- **用 `tools.restrict()`，不用 `register(def, { when })`**：已发布的最新 dsh 里 `register()` 仍只收一个参数，按步求值的 `when` 只在源码 HEAD 上，装不进去。`restrict` 要求 scoped context，所以在 `agent/created` 上对每个 agent 调一次；会话每次创建（含冷恢复）都重算，不会带着上一次的限制。
- **分配**：leader 全有；普通会话没有 `spawn_worker` / `message_worker` / `list_cards`；worker 再少掉项目注册表的五个工具。`create_card` / `update_card` 起初对所有会话开放，2026-11-02 改为只给 leader 与 worker 并加执行时身份闸，见 [卡片写工具的作用域](../simplification/2026-11-02-card-write-tools-scope.md)。
- **leader 身份在建项目时定下**：`leaderSessionId` 是唯一真源，建项目时自动建的会话直接写进去，不从会话内容推断。
- **索引重建完成前不裁**：这时注册表还没读回内存，返回「不是 leader」会让 leader 首轮看不到编排工具，活直接干不成。多给的危害是零——每个工具执行时都按调用方会话再校验一次归属。

### 会话折叠沿用官方分页口径

- 默认露出 5 条、每次加 5 条、剩余不足 5 条一次放完、只把当前会话抬到它所在位置（前 50 条内）、水位只升不降、收起回落到基线、每个项目各自计数、状态留在组件本地不持久化。宿主的折叠函数是模块私有、不导出，只能照同一套口径自己算。
- **已知差异**：宿主还会为运行中、「有子代理在跑」「等你输入」「未读完成」抬水位；项目树只认当前会话（[项目树折叠只认当前会话](2026-11-25-project-fold-ignores-unread.md)）。收起只在全部放完时出现（与宿主同一判法），所以会话很多时要连点几次「展开其余 N 个会话」。

## Alternatives considered

- **复用宿主的 `send_message`**：它只对子会话有效，worker 是根会话；另开 `message_worker` + 冷恢复。
- **把 `delivery` 暴露成工具参数**：宿主交付语义不该进模型调用面；投递与唤醒由本 bundle 负责。
- **用 `register(def, { when })` 按步裁剪**：已发布版本只收一个参数；改用 `agent/created` 上的 `restrict`。
- **索引未就绪就先裁**：leader 首轮看不到编排工具；读类宽松放行，派工等索引就绪。

## Consequences

- 宿主的 `delivery` 语义不暴露给模型，投递与唤醒由本 bundle 负责。
- 索引未就绪时工具面宽松放行，安全边界靠执行时的归属校验兜住。
- 折叠只认当前会话（前 50 条内），运行中与未读不抬水位。

收益：worker 能跨进程续聊、三种角色的工具面被正确裁剪，项目会话列表沿用官方分页口径，但只把当前会话抬进可见范围（运行中 / 完成未读不抬）。

## Testing

`tests/dispatch-continuation.test.js`、`tests/tool-gate.test.js`、`tests/worker-registry.test.js` 钉住续聊路径与三种角色的工具面；真机读数：三种角色各落一份工具面快照，折叠实测 5 → 10 条。
