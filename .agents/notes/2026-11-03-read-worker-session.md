# 协调者回看 worker 会话：read_worker_session

**状态**：implemented（2026-11-03）
**范围**：`src/host/tools/read-worker.js`、`src/host/worker-transcript.js`、`src/host/dispatch.js`、`src/host/index.js`、`src/host/tools/gate.js`、`tests/read-worker-tool.test.js`、`tests/worker-transcript.test.js`、`tests/tool-gate.test.js`、`README.md`、`docs/`

## 背景

协调者此前只能拿到 worker 每轮结束时的一条完成通知（`turn/end` 折叠出的产物摘要或失败原因）。要看过程只能 `message_worker` 追问，那会真的唤醒 worker 开新回合，消耗模型调用换取一段它自己的复述。

`docs/capability-gaps.md` 第 16 条当时的结论是「读子会话原始回合没有直接对应物，授权校验在 dsh 内部无法零依赖复刻」。核对宿主源码后这条理由对纯读场景不成立：

- `ctx.sessionQuery.readSession(sessionId)` 是公开服务方法，rc.2 就有（`packages/session-query/session-query/src/index.ts:184`），返回完整 `SessionEvent[]`，实现内没有身份校验，只做 live-preferred 读取与回放校验。
- 实验包 `@deepseek-ai/dsh-tool-session-query` 在工具层加的授权判据只有「调用方 `header.cwd` 存在且目标会话 `cwd` 相同」（`workspace-access.ts` 的 `authorizeTarget` / `headerAuthorized`）。
- 本 bundle 的 worker 目录取自项目（`resolveWorkerCwd`），与协调者必然同 cwd——即使照抄官方判据也能过。

第 39 条（事件结算）自己也已经记了 `readSession()` 可用。缺的不是能力，是有人做。

## 决策

**新增协调者专用工具 `read_worker_session`，直读会话日志折叠成回合视图。**

### 读取路径

`dispatcher.transcript()` 复用现有的身份与归属判据，再走 `ctx.get('sessionQuery').readSession()`：

- 调用方必须是当前项目协调者（`assertCoordinator`，与 `message_worker` 同档，退役协调者在调用时被判掉）；
- 目标必须在本 bundle 的派工登记里（登记表 + 本进程 `owners` 兜底），且归属就是该协调者——比官方的「同 cwd」更严，不看别的会话；
- 缺 `sessionQuery` 或没有 `readSession` 时报清缺口，不静默返回空；
- 读失败（worker 还没投过第一条消息、日志损坏）转述原因，因为「还没跑过回合」是预期状态。

### 折叠与渲染

`src/host/worker-transcript.js` 是纯函数层：`foldTurns()` 按 `turn/start` / `turn/end` 切回合，收集用户消息、assistant 文本、`tool/call` 与 `tool/result` 的配对（失败取 `error.reason`，没有就退回结果正文），`renderTranscript()` 输出「一回合一段」。

只保留排障需要的形状：

- 工具**只列名字与失败原因**，不返回参数与成功结果——那是完整转录的事，不是回看视图；
- 没有 `turn/end` 的最后一轮标「进行中」，半截输出不当结论；
- 未配对的 `tool/result`（宿主在工具恢复路径上会补写）不丢，名字记 `unknown`；
- 无关事件（step、请求头、压缩、系统/开发者消息）不进视图。

### 上限：三层，缺一层就能撑爆协调者上下文

- 单条消息 2000 字符、单条失败原因 200 字符；
- 整段 12000 字符：**按最新优先累加**，装不下的更早回合丢弃并标注条数；最新一回合自身超限时硬截断，否则整次读取拿不到内容；
- `turns` 默认 2、上限 20，越界（含非整数、字符串）直接报错——运行时 schema 不生效，靠工具层判。

回合数与单条上限都挡不住体积：20 回合 × 每轮两条消息 × 2000 字符仍有八万，所以总量上限必须单独存在。

### 工具面

`COORDINATOR_ONLY_TOOLS` 加入 `read_worker_session`：worker 与普通会话都禁掉。它和 `spawn_worker` / `message_worker` 不同——读自己的会话没有意义，读别人的会话属于越界。

## 边界

- **不是会话导出**。正文有总量上限、工具参数不返回；要完整日志用宿主的会话导出，要任意会话的读取口装 `tool-session-query`（experimental）。
- **与 worker 是否在跑无关**：live 会话读内存快照，所以能看到进行中的轮次，也意味着同一轮两次读取结果会变。
- **读取有回放校验成本**：`readSession` 内部用 `Session.create` 重放日志，长会话有 CPU 开销。这是宿主实现，本仓不重复解析 JSONL。
- **不检查归档状态**：归档只摘活跃列表，日志仍在；读归档会话的内容是安全的只读行为，不拦。
- **日志形状不符按契约错误报**：`readSession` 返回的 `events` 不是数组时直接报错，不静默当空日志——空会话是 `events: []`，缺字段说明后端契约变了，静默降级会让协调者误以为 worker 什么都没做。
- **没有真机取证**：工具行为全部落在纯函数与夹具层（真实 `createDispatcher` + 假 `sessionQuery`），真机需要能按标记驱动工具调用的 mock provider，本仓没有这个夹具。宿主侧 `readSession` 的回放校验与 live 快照语义由 capability 第 16 条记录。
- 完成通知与回看视图**不合并**：通知是每轮的推力（不读也有），回看是按需的拉取。合并会让每轮自动消耗更多上下文。

## 验证

- `npm run check`：829 例全绿（803 + 26 新增）。
- 新增用例分两层：
  - `tests/worker-transcript.test.js`（12 例）：回合切分、工具失败原因与兜底、未配对结果、进行中标记、`turn/end` 后的独立消息段、turns 裁剪、总上限（20 轮 × 2000 字符正文仍 < 13000 且保留最新）、空日志、无关事件过滤；
  - `tests/read-worker-tool.test.js`（14 例）：正常读取、turns 只影响渲染、非协调者/索引未就绪被拒、未登记与跨会话归属被拒、缺 `sessionQuery` / 缺 `readSession`、读失败转述、日志形状不符（缺 `events`）按契约错误报而不是当空日志、`turns` 与 `sessionId` 校验、派工落盘失败时 `owners` 兜底仍可读、工具 schema 落在宿主执行子集内。
- `tests/tool-gate.test.js` 的 agent 假件补上 `read_worker_session`：缺它时 `restrict()` 会抛「unknown global tool」，逐件重试会把一次 deny 拆成三次——夹具比宿主真实面更窄会掩盖裁剪逻辑。
- 双向验证（撤修复 → 用例红 → 还原 → 全绿），三条都实测：
  - 把 `TOTAL_LIMIT` 放大到 1e9：`整段正文有总上限` 用例红，读数「正文长度 80372 超出总上限」；还原后 12 例绿。
  - 去掉 `transcript` 里的 `assertCoordinator`：`退役或非项目协调者不能读` 与 `项目索引未就绪时拒绝` 两条红；还原后 12 例绿。
  - 去掉工具层的 `turns` 校验：`turns 只接受 1 到 20 的整数` 红；还原后两个文件 24 例绿。
