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

`user/message` 有三种生产者，只靠 `source.kind` 区分：真人输入（`user`）、本仓协调者投递的任务（`dsh-leader-kit/worker-task`，见 `host/message.js` 的 `WORKER_TASK_SOURCE_KIND`）、宿主注入的上下文（换目录、plan 模式、hooks 的 `additionalContexts` 等）。三类分开记：任务与人类输入进正文，注入只记条数、正文省略——否则注入会占掉任务正文的 2000 字符预算，协调者看到「用户」说过自己没说过的话，甚至把真正的任务挤出去。

### 上限：三层，缺一层就能撑爆协调者上下文

- 单条消息 2000 字符、单条失败原因 200 字符；
- 整段 12000 字符：**按最新优先累加**，装不下的更早回合丢弃并标注条数；最新一回合自身超限时硬截断，否则整次读取拿不到内容；
- `turns` 默认 2、上限 20，越界（含非整数、字符串）直接报错——运行时 schema 不生效，靠工具层判。

截断按 UTF-16 码元数计，但切点回退到码点边界：切在代理对中间会留下孤立代理、渲染成 U+FFFD。三层上限共用 `clip()`，所以三处都覆盖。只保证码点完整、不切字素簇——丢掉组合标记只影响重音，不是乱码。

丢弃标注分开说两种成因：`turns` 窗口外（调大 `turns` 可以多看）与窗口内被体积挤掉。后者的上限是固定的——调小只是少几个候选，调大仍超限，任何 `turns` 值都装不回被挤掉的回合，所以如实说「这些回合在本次读取里取不到」，需要更早内容只能用 `message_worker` 让 worker 复述。别暗示调参可达：实测 `turns=4` 建议调小、调到 3 后仍只显示同样的最近几轮。

回合数与单条上限都挡不住体积：20 回合 × 每轮两条消息 × 2000 字符仍有八万，所以总量上限必须单独存在。

### 工具面

`COORDINATOR_ONLY_TOOLS` 加入 `read_worker_session`：worker 与普通会话都禁掉。它和 `spawn_worker` / `message_worker` 不同——读自己的会话没有意义，读别人的会话属于越界。

## 边界

- **不是会话导出**。正文有总量上限、工具参数不返回；要完整日志用宿主的会话导出，要任意会话的读取口装 `tool-session-query`（experimental）。
- **12000 是正文切片的上限**：截断标注与头部行不计入，硬截断的实际输出略超 12000（约 +50）。
- **只读有回归护栏**：夹具的 `send` / `spawn` / `present` / `dispose` / `sessionPersistence.append` 都记调用，读取用例断言为空。没有这条，「读路径别调 `send`」只是一句注释——`send` 会真的让 worker 再跑一轮。
- **与 worker 是否在跑无关**：live 会话读内存快照，所以能看到进行中的轮次，也意味着同一轮两次读取结果会变。
- **读取有回放校验成本**：`readSession` 内部用 `Session.create` 重放日志，长会话有 CPU 开销。这是宿主实现，本仓不重复解析 JSONL。
- **不检查归档状态**：归档只摘活跃列表，日志仍在；读归档会话的内容是安全的只读行为，不拦。
- **日志形状不符按契约错误报**：`readSession` 返回的 `events` 不是数组时直接报错，不静默当空日志——空会话是 `events: []`，缺字段说明后端契约变了，静默降级会让协调者误以为 worker 什么都没做。
- **没有真机取证**：工具行为全部落在纯函数与夹具层（真实 `createDispatcher` + 假 `sessionQuery`），真机需要能按标记驱动工具调用的 mock provider，本仓没有这个夹具。宿主侧 `readSession` 的回放校验与 live 快照语义由 capability 第 16 条记录。
- 完成通知与回看视图**不合并**：通知是每轮的推力（不读也有），回看是按需的拉取。合并会让每轮自动消耗更多上下文。

## 验证

- `npm run check`：841 例，832 pass，0 fail（9 skipped）。
- 新增用例分两层：
  - `tests/worker-transcript.test.js`（21 例）：回合切分、工具失败原因与兜底、未配对结果、进行中标记、`turn/end` 后的独立消息段、turns 裁剪、总上限、空日志、无关事件过滤；注入上下文与任务正文分开（不冒充用户、不占任务预算）；三层上限各自的代理对截断（单条正文 / 失败原因 / 总上限硬截断）；CJK 与组合字符截断；体积溢出时的提示不承诺调 `turns` 可达（`turns=2/3/4` 三种取值都断言）。
  - `tests/read-worker-tool.test.js`（17 例）：正常读取、turns 只影响渲染、非协调者/索引未就绪被拒、未登记与跨会话归属被拒、缺 `sessionQuery` / 缺 `readSession`、读失败转述、日志形状不符、`turns` 与 `sessionId` 校验、`owners` 兜底、schema 子集；**读路径与读失败/授权拒绝路径的写调用记录为空**。
- `tests/tool-gate.test.js` 的 agent 假件补上 `read_worker_session`：缺它时 `restrict()` 会抛「unknown global tool」，逐件重试会把一次 deny 拆成三次——夹具比宿主真实面更窄会掩盖裁剪逻辑。
- 双向验证（精确撤销对应代码 → 对应用例红 → 还原 → 全绿），四条都实测：
  - `clip()` 改回按码元切：三条截断用例红（17 pass / 3 fail），还原后 20 绿；
  - 丢弃标注改回单一成因 + 「调大 turns」：`worker-transcript` + `read-worker-tool` 4 红（33 pass / 4 fail），还原后 37 绿；
  - `user/message` 不看 `source.kind`（全部记用户）：4 红（33 pass / 4 fail），还原后 37 绿；
  - 体积溢出的提示改回「调小 turns 可以装进上限」：2 红（19 pass / 2 fail），还原后 21 绿；
  - `transcript()` 读路径插入 `workerSessions.send()` + `sessionPersistence.append()`：只读护栏用例红（16 pass / 1 fail），还原后 17 绿。
- 另有三条既有双向验证保留：放大 `TOTAL_LIMIT`、去掉 `assertCoordinator`、去掉 `turns` 校验，各自都能让对应用例变红。
- `docs/capability-gaps.md` 第 16 条的工具名按 rc.2 源码改正（`session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read`），其余 `docs/` 工具名逐个核过无漂移。
