# worker 回报气泡的呈现

**范围**：`src/shared/worker-report.js`、`src/host/message.js`、`src/host/dispatch.js`、`src/client/worker-report-*.js`、`src/client/index.js`、`tests/worker-report.test.js`

## 背景

worker 完成的完成通知此前是一条普通用户消息，正文带「【worker 回报】」前缀，在会话里渲染成右对齐的用户气泡。它读起来像用户自己在说话，而且气泡里混着一段协议口吻的前缀。

worker 回报改用**助手侧的形态**渲染：身份头（头像 + 名字）在气泡上方单独一行，气泡左对齐、带 1px 边框、中性底；正文里没有前缀。

## 决策

**说话人标记放在 `source`，不放正文**。通知消息的 `source` 用自定义 kind `dsh-leader-agent/worker-report`，带 `worker: { label, childSessionId }` 与通用契约的 `form: 'notice'` + `summary`。

- 正文是模型读的事实，前缀会同时污染模型上下文与用户界面；`source` 是宿主的归属字段，链路上原样透传。
- 宿主对 `source` 的唯一硬约束是「kind 是非空字符串」，自定义 kind 原样落进 `session.v4.jsonl`、重启后原样读回；宿主自己就有十几个这样的 kind（`agent-message`、`subagent-settled`、`webhook`、`goal`、`team-message` …），这是它预留的扩展位而不是越界。
- `form: 'notice'` + `summary` 是宿主给所有生产者的通用契约：万一本仓的渲染接管失败、降级成官方上下文行时，折叠行显示的是「任务「X」已结束。」而不是一个原始 kind 字符串。

**前缀在生成侧去掉，不靠「注入前缀再视图层剥离」**。本仓的通知正文是自己拼的，直接不写前缀更省一层，也不会有解析失败时的兜底分支。

**新增独立 Chat node kind，用 exclusive claim 接管这类消息**（`src/client/worker-report-definition.js`）。

- 路径 A（抢占 `conversation.chat.node` 的 `user` key）会接管**所有**会话的所有用户消息，要完整复刻官方用户渲染器（右对齐布局、正文渲染、actions 行、pending/echo 态）——风险过大，否决。
- 路径 B（DOM 后处理）不可行：DOM 上没有 source / messageId / role，识别不出插件注入的消息，且 React 会覆盖外部 DOM 修改，否决。
- 路径 C：注册独立 kind 的 `ConversationNodeDefinition`，`match` 只认带本仓 source 标记的 `user/message`，返回 `exclusive: true`；再按 kind 注册 keyed renderer。影响面只有 worker 回报这一类消息，普通用户气泡零影响。宿主提供的官方样板是 `packages/client/ui-user-questions/src/client/question-reply.ts`（它同样接管一条官方也会匹配的 `user/message`）。

**`groupTree` 必须给，且按官方口径条件式**。这是本轮踩到的真问题：节点建好后渲染出来却**看不见**——宿主把「回合内、答案之前」的节点归进回合的**过程折叠区**并默认隐藏（`data-turn-process-hidden="true"` + `hidden="until-found"`）。判定看 `isAtOrOutside(node, 'turn')`，没有 `groupTree` 的节点一律落入过程区。

取值与官方一致：回合首步（`location.kind === 'step' && location.step.step === 1`）开启新 exchange，其余留在 `'input'`。写死 `'input'` 也能显示，但连续多次 worker 回报会全落进上一个 exchange——它是被 `followup` 唤醒的新 turn 的第一条输入，语义上该开启新 exchange。

**界面渲染与模型读的事实分开**：消息正文保留完整协议字段（任务、子会话 id、状态、产物摘要、下一步）给模型读；界面只渲染 worker **最后一次回报的内容**——成功是产物摘要，失败是失败原因。内容单独放在 `source.worker.report` 里（`outcome` 记终态），界面与模型各取所需，用户不必读协议口吻。

**气泡底用前景色混出的极淡一层**：`color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)`。浅色主题下是几乎看不出的灰，深色主题下是微亮——比 `--dsw-alias-bg-layer-1`（浅色主题下是纯白，与页面同色）更有层次，又不至于抢正文。

**名字是按钮，点击下钻到 worker 的子会话**。`uiWorkspace.openSession(childSessionId)`：宿主 `SessionTarget = SessionId | SubagentAddress`，传子会话 id 即可。`uiWorkspace` 只挂在 web-app bundle 上，必须惰性获取（`ctx.get('uiWorkspace')`），不能写进 `inject`（缺服务会让整个插件挂起）。

**气泡下方一行是时间与复制按钮**，与官方消息的底部 chrome 同形：时间按宿主 `formatMessageClock` 的口径（今天 `HH:MM`；同年往日 `M月D日 HH:MM`；跨年再加年份——宿主走 i18n 模板，英文环境是 `M/D`，本仓不做多语言，固定中文形态）；复制按钮自己实现——宿主 `useClipboardCopy` 在 UI 包里，不可 import。

**头像用 `minidenticons`，种子取 worker 的身份名**。FNV-1a 哈希取模落到 63 个内置 seed，同名恒同图；底色与图案同色相、底色明度压到 36% 以过非文本 3:1 基线。种子必须用身份名（派工 label）而不是显示文案：显示文案由任务描述派生、随任务变，用它做种子同一 worker 会跨任务换脸。

**只认领追加到转录尾部的事件**（`surfaceOp === 'append'`）。替换副本只应留在模型侧，不该出现在人类转录里——宿主的 `isAppendSurfaceEvent` 判的就是这个，官方两个同类定义都带这一条。本仓的消息由 `followup` 注入，落盘实测带 `surfaceOp: 'append'`。

**`notice` 摘要压到 120 字符**。宿主把这条约束写在生产者身上（`CONTEXT_SUMMARY_MAX_CHARS`，摘要的输入是调用方文本、没有长度上限），并要求生产者自己调 `boundContextSummary`。本仓刻意不 peer 依赖 dsh 内部包，在 `shared/worker-report.js` 里等价实现。

## 边界

- **回报不进会话标题、turn 摘要与 markdown 转录导出**：宿主只把 `source.kind === 'user'` 的消息算作真人输入。这是自定义 kind 的代价，换来的是它不会被误当成用户说的话。
- **历史消息不追溯**：改造前发出的通知在 session log 里就是普通用户消息，重放时仍是老形态（右对齐、无头像）。改造后但带 `report` 之前落盘的消息没有回报正文，气泡退回显示整条正文。
- **降级形态**：本仓的定义没注册上（或宿主改了 claim 语义）时，这条消息退化成官方渲染——因为 source 不是 `'user'`，它会渲染成上下文注入行，而不是右对齐的用户气泡；内容不会丢。
- **深色主题下头像轮廓弱**（既定取舍）：气泡底是前景色混出的 4% 一层（深色主题下即微亮的中性深色），36% 的蓝紫色相落上去只有 1.35:1（hue 240），块的外轮廓看不出边界；头像本身仍可辨（图案对底色 3.4846:1）。不描边、不加容器环、不提亮底色——补救层在 20px 尺寸下显得又脏又重。
- **头像会撞图**：池子只有 63 个 seed，3 个 worker 至少一次撞图约 4.7%，5 个约 15%（生日悖论）；200 个名字命中 61 个 seed，分布够开。撞图不影响身份识别——名字就在头像旁边。属既定取舍。
- **渲染器组件本身没有单测**：本仓不引 React 依赖与 jsdom，组件进不了单测；可判定的逻辑（source 判型、正文取文本、头像种子、定义的 match/start/buildViewNode）已全部抽成纯模块并覆盖。与看板浮层同一处境。
- 客户端 bundle 多了唯一运行时依赖 `minidenticons`（纯 JS、无传递依赖），打进产物约 30 KB。

## 证据

- 单测 279 例全绿（`tests/worker-report.test.js` 覆盖 source 构造与逐层判型、正文取文本、通知正文无前缀、头像种子确定性与分布、节点定义只认带标记的消息、不认领替换副本、视图节点字段含 `groupTree`、按官方口径条件式给分组位置、notice 摘要压到 120 字符，以及本轮新增的 source 带回报内容与终态、界面正文取回报内容（没有就退回正文）、节点状态带回报内容与终态）。
- 真实实例（隔离 mock profile + mock LLM）：协调者真实派工，worker 收工后通知注入父会话；session log 里该条 `user/message` 的 `source.kind` 为 `dsh-leader-agent/worker-report`、正文无前缀；界面上出现带头像与「mock worker」名字的左侧气泡，用户自己的输入仍是右侧气泡，console 无报错。
- 气泡形态复查（同一实例）：气泡正文只有「mock worker 收工。」，没有协议字段；底色计算值 `color(srgb 0.058 0.066 0.082 / 0.04)`；名字是 `BUTTON`；下方有时间「19:38」与复制按钮；点复制后剪贴板内容为「mock worker 收工。」、按钮文案变「已复制」；点名字跳到 worker 子会话（面包屑「跑一下 mock worker / mock worker」）。
