# Agent Note: worker 模型选择

Status: implemented

## Problem

worker 建会话时只能拿 `agentDefaultModel` 的部署默认值，leader 无法按任务要求换模型；`SLOTS.md` 的角色只贡献提示词，同一角色的默认模型无处声明。派工参数里也没有 effort，模型选择完全脱离 leader 的编排判断。派工还要求 leader 知道合法 route，而宿主没有面向模型的通用模型目录工具。模型 route 在 `preStep`/`prepareRequest` 就失败时，这一轮还没落 `user/message`，按消息 id 归属会漏报，leader 只能等超时巡查。

## Decision

- **派工参数优先**：`spawn_worker` 新增可选 `model` 与 `effort`。`model` 写 `provider/model`；只写模型 id 时沿用 leader 的 provider（模型 id 自身含斜杠时必须写全 route）。只给 `effort` 时套在最终模型上；若最终没有任何可用 route，直接报错而不是静默丢掉 effort。
- **槽位默认其次**：`SLOTS.md` frontmatter 的 `slots.<名字>` 可写 `model` / `effort`。派工绑到该槽位且未显式指定模型时使用它；槽位没写 model 时才回落到 leader 当前模型。
- **effort 跟随模型来源**：显式换模型但没给 effort 时用新模型的默认 effort，不把槽位 effort 跨模型套用；模型回落到 leader 时槽位 effort 仍可覆盖 leader 的 effort。
- **建会话前预检**：需要换 route 或 effort 时调宿主 `llm.resolveCallConfig()`；不可用就拒绝派工，不在磁盘上留下等消息的空会话。纯回落 leader 当前 route 不重复预检。
- **模型是建会话时的 route**：选择随派工登记表落盘；冷恢复按 `agentOptions` 还原。rc.2 的 `agents.resume()` 只从 `agentOptions` 取 route，不从会话日志推导，不落盘会让自定义模型的 worker 重启后首轮失败。
- **回执可审计**：`spawn_worker` 返回并渲染 `model`、`effort` 与 `modelSource`（派工参数 / 槽位默认 / leader 当前模型），leader 不必猜 worker 实际跑在什么模型上。
- **模型目录**：新增 leader-only `list_worker_models`，读宿主 live LLM registry：不传参列 provider，给 provider 列模型，再给 model 列 reasoning effort。它不替 leader 选模型，只把 `spawn_worker` 需要的 route 变成可查的。
- **失败回报按 claim 归属**：订阅 rc.2 的 `agent/inbox/claimed`，按 `agent.id` + turn 记录取走的消息来源。用户 claim 的轮次失败不回报，派工记录留在在飞表等任务真正执行；leader claim 的轮次在任务消息落成前失败仍按派工失败回报，并明写「任务消息已被取走但还没落成 user/message」；没有 claim 的裸 error 才标「无法确认是否消费」。`user/message` 仍是「已消费」的唯一真源，claim 不直接算消费。通知带 `model`/`effort`/来源与换 route 或重试的下一步；续聊记录从登记表读回模型。

## Alternatives considered

- **照宿主 subagent 拆 `provider` + `model` + `reasoning_effort` 三个字段**：最无歧义，但 leader 每次派工要多填一段已知前缀；`provider/model` 单字段已能表达，裸 id 再用 leader provider 兜底。
- **只做 `SLOTS.md` 默认，不给派工参数**：跨角色的临时任务（同一 dev 槽位这次要快模型）只能改项目文件，违背「模型是单次派工决策」。
- **只做派工参数，不做槽位默认**：角色默认要由 leader 每次记得，且项目配置无法表达「review 固定用强模型」。
- **模型为空时回落到部署默认而非 leader**：用户要求按 leader 当前模型回落；部署默认在 leader 手动换过模型后与它不一致。
- **冷恢复从会话日志 `model/selection` 反推 route**：新宿主可行，但 rc.2 是 `engines.dsh` 下限，且 `model/selection` 只记录选择、不保证在首轮请求前存在；登记表是同一份派工事实的持久化落点。
- **复用宿主 `list_subagent_models`**：它服务子代理的 `allowedModels`，默认关闭时只列 leader 当前 route，且受子代理设置约束；worker 不是 subagent，不能把它当目录。
- **只靠 `user/message` 归属**：`preStep`/`prepareRequest` 失败时这条消息还没落盘，用户自己开的轮次会被误报成派工失败；rc.2 的 `agent/inbox/claimed` 正好补这个窗口。

## Consequences

- **改 `SLOTS.md` 不切换已在跑的 worker**：模型只在建会话时定下，角色正文仍每轮更新。要换模型只能新派 worker 或原会话里手工换。
- **模型目录读 live registry**：`list_worker_models` 列的是宿主当前注册的 provider/model；provider 的发现失败会在目录末尾点名，不挡其他 provider。列表可见不等于一定可调用——凭据或模型下架仍由 `spawn_worker` 预检拦下。
- **登记表是冷恢复的模型真源**：登记失败（已记日志）或旧记录没有 `agentOptions` 时，恢复行为退回旧路径；新宿主仍可从 `modelSelection` 投影取回。
- **槽位模型值非法只影响该槽位派工**：解析期忽略并告警，绑到该槽位派工时直接拒绝，不影响其他槽位与注入。
- **失败归属分三类**：用户 claim 的轮次失败不回报，派工记录保留到任务消息真正进入下一轮；leader claim 的轮次失败按派工失败通知并说明消息已被取走；没有 claim 的裸 error 才走「无法确认是否消费」。通知要求 leader 先 `read_worker_session` 再决定重投或换模型。用户 claim 失败留下的记录不会自动过期，提醒可能重复，进程重启才清（见 limitations）。
- **effort 不能脱离 route 单独存在**：只给 `effort` 而 leader / 槽位都没有模型时，`chooseWorkerModel` 抛错并提示补 `model` 或配槽位模型，不返回 `undefined` 静默吃掉配置。

收益：leader 能在派工那一刻按任务难度与角色分配模型，同时保留项目级角色默认与 leader 兜底。

## Testing

`tests/worker-model.test.js` 钉住来源优先级、route 解析与预检，以及只给 effort 但无可用 route 时报错；`tests/list-worker-models.test.js` 钉住目录逐层下钻、失败降级与参数错误；`tests/slots.test.js` 钉住 frontmatter 读取与非法值；`tests/worker-sessions.test.js` 钉住创建与冷恢复传 `agentOptions`；`tests/dispatch.test.js` 钉住派工参数、槽位默认、失败不建会话、回执与失败回报：没有 claim 的裸 error 仍回报、leader claim 的 preStep 失败按派工失败回报、用户 claim 的 preStep 失败不回报且记录留到任务真正执行。`tests/tool-gate.test.js` 钉住 `list_worker_models` 只给 leader。双向：把 `spawn_worker` 的模型参数从 dispatcher 调用里删掉 → 显式模型用例红；把预检跳过 → 预检失败用例红；删掉 claim 的 user 分支 → 用户 claim 用例红（106 / 105 pass / 1 fail），还原后 106 / 106 全绿；删掉 effort-only 的抛错分支 → worker-model 用例红（20 / 19 pass / 1 fail），还原后 20 / 20 全绿。全量 `npm test`：1431 tests / 1414 pass / 17 skip / 0 fail；`npm run check` 全绿。
