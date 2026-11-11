# leader 任务在 worker 会话里渲染成用户气泡

## 背景

leader 用 `message_worker` 投给 worker 的消息，在 worker 会话里显示成一条「收到执行请求」的紧凑上下文行，点开才看到任务正文。

根因在宿主的 `input-message` 定义：它按 `source.kind === 'user'` 区分真人输入与其他上下文，非 `user` 的一律按「触发行」渲染；本仓的 `dsh-leader-agent/worker-task` 是自定义 kind，落进 `turn-trigger` 的 `default` 分支，取 `message.trigger.request` 文案。worker 回报（`dsh-leader-agent/worker-report`）此前已经用独立 Chat node kind + exclusive claim 解决过同一类问题，任务消息只是没跟上。

## 决策

### 任务消息用独立的 Chat node kind 认领

新增 `dsh-leader-agent-worker-task` 节点定义，`match` 只认 `user/message` + `surfaceOp === 'append'` + `source.kind === 'dsh-leader-agent/worker-task'`，用 `exclusive: true` 让官方定义不再处理它。`start` 把正文、时间与 `messageId` 装进状态（`parentSessionId` 只在 `match` 里做认领凭证），`buildViewNode` 的分组位置与官方同类节点一致：回合首步给 `exchange`（开启新 exchange），其余给 `input`。省掉 `groupTree` 会让节点落进回合的过程折叠区被默认隐藏——worker 收到任务却看不见。

认领失败（宿主版本漂移、注册没生效）时退回官方上下文行，内容不丢；旧记录只要 `source.kind` 仍是 `dsh-leader-agent/worker-task` 且带 `parentSessionId` 也按气泡渲染，不另做迁移。#112（`478232a`）把包名从 `dsh-leader-kit` 改成 `dsh-leader-agent` 时 kind 一起换了，改名前的 `dsh-leader-kit/worker-task` 记录不被认领，退回官方上下文行。

### 渲染成用户气泡，而不是 agent 气泡

在 worker 的会话里，leader 就是那个「user」：消息要驱动 worker 的回合，形态上也该和用户自己的消息一致。`WorkerTaskView` 因此右对齐、无头像与名字、不折叠，只保留用户气泡的底色、圆角、内边距与最大宽度；气泡下方是时间与复制按钮。宿主的 `UserMessageBubble` 是 rc.2 之后才加进基线 `ui-primitives` 的导出，`engines.dsh` 下限仍是 rc.2，静态 import 在旧宿主上会拿到 `undefined`，所以按 `UserMessageBubble.module.css` 与 `MessageItem.module.css` 的数值用 `--dsw-*` 令牌复刻，不引宿主内部包。worker 回报继续用左侧 agent 气泡（`agent-bubble-view.js`），两套形态分开，不再共享布局。

### 任务正文与 assistant 内容同套 Markdown

任务气泡外壳仍按用户消息的形态（右侧、无身份头），但正文走 `src/client/markdown.js` 的 `Markdown` 包装，内部是基线 `MarkdownText`，`variant: 'compact'`——与 conversation 里的 assistant 内容同一套渲染器。宿主的 `MarkdownText` 没有 `breaks` / 软换行开关，因此不再做行级预处理：原文直接交给渲染器，单换行按 Markdown 规则合并，空行、标题、列表、围栏决定块结构；需要断行时用空行或 Markdown 语法。任务正文不再是逐行协议字段，而是可读的 Markdown 文档。

这是有意取舍。宿主自己的用户消息不是 Markdown：`UserMessageBubble` + `conversation.user.text` → `UserText` / `UserTextRun`，气泡 CSS `_bubble_1sgyj_1` 用 `white-space: pre-wrap` 保留单换行（`EMPTY_TEXT_FACTS = {}`，不会触发 collapse / trim 规则）。任务气泡特意不跟随这一点，选择 assistant 内容的 Markdown 语义，接受单换行合并；也不维护 `hardBreakMarkdown` / 围栏容器栈这类“半个 CommonMark”的预处理。worker 回报仍按 `bubbleFormat` 判据走 Markdown / 纯文本，两套气泡共用 `MarkdownText` 但不共享正文策略。

### 文本与格式判据收进 shared

host 的 `blocksToText` 与 shared 的 `workerReportText` 是同一份实现的两份拷贝；client 又不能 import `src/host/message.js`（带 `node:crypto`）。两者合并到 `src/shared/message-text.js`（`messageText`、`bubbleFormat`），host 的通知正文、转录折叠与两个气泡共用 `messageText`；时钟抽到 `src/client/bubble-clock.js`。`workerReportFormat` 保持原签名，内部改调 `bubbleFormat`。

## 边界

- 任务气泡没有身份头：不显示 leader 名字与头像，也不能点名字跳回 leader 会话。`source.parentSessionId` 仍随消息落盘并作为认领凭证（没有它退回官方上下文行），但不再驱动界面。任务气泡也没有独立的可见标识，只能靠内容与右侧用户气泡的形态与用户自己的消息区分；气泡带 `title` / `aria-label`「Leader 派发的任务」做悬停与读屏提示，这条边界写在 `docs/usage.md`。
- 只认追加事件（`surfaceOp === 'append'`）：替换副本只应留在模型侧，不进人类转录，官方同类定义也是这条口径。
- 用户气泡不折叠：长任务全文展示。worker 回报气泡仍默认两行、超出给「展示更多」。
- 任务正文与 assistant 内容同套 Markdown，**不与宿主用户消息的纯文本路径一致**：单换行按 Markdown 合并，不复原日志式换行；需要断行时用空行或 Markdown 语法，标题、列表、围栏同样按 Markdown 渲染。宿主用户消息本身是 `UserTextRun` + `pre-wrap`，这里是刻意的产品取舍。
- 气泡布局没有单测（React 组件 + 宿主模块表），仓库仍不引 jsdom；`tests/markdown.test.js` 的源码断言覆盖右对齐、无身份头、`Markdown` 接线、`variant: compact`、宽度上限（70.2% / 82%）、`10px 16px` 内边距、时间与复制按钮、令牌色值。
- 本 PR 没有派工场景的 e2e：mock 的脚本游标是全局单值，且 `message_worker` 需要上一步 `spawn_worker` 结果里的动态会话 id，现有 mock 无法表达。任务气泡的渲染另有 `1bec9f3` 的真机探针取证（`strong` 与行内 `code` 各至少 1 处、内层气泡 521px、右对齐、时间与复制位置）；`edfa079` 沿用同一 `Markdown` 组件与 compact 变体，去掉了 `hardBreakMarkdown`；同时移除了 `__content` 包装与气泡行高覆盖（含 `--dsh-leader-agent-worker-task-line`），补了 `title` / `aria-label`。521px（70.2% 上限）、右对齐、时间与复制位置仍由未改的 `max-width`、`align-items` 与 `meta` 支撑，读数可继续引用。要覆盖派工得先给 mock 按 session 分游标、并支持从工具结果取参，那是独立的一步。

## 验证

- 更新单测：`tests/worker-task.test.js` 覆盖 source 判型、`match`、`start`/`buildViewNode`、`任务正文交给 Markdown 渲染，不做行级改写`、`message-text` 导出集合（正文逐字透传、含围栏/引用/列表的文本不被改写、`Markdown` 接线、无 `pre-wrap` / `line-height` 覆盖）与客户端入口接线；`tests/markdown.test.js` 覆盖右侧用户气泡的形态（宽度上限、内边距、时间、复制、title / aria-label）与 `Markdown` 接线；`tests/bubble-clock.test.js` 覆盖三种时间形态；`tests/client-styles.test.js` 覆盖新样式表的幂等注入。
- `npm test`：1121 条，1104 通过 / 17 skip。
- `npm run check`：全绿（笔记 90 篇、文档预算、108 文件语法、覆盖率 1104 用例 / 79 源文件 / 61 加载 / 53 个 100% / 18 未测量）。
- `npm run build:client`：通过（客户端产物重建，含 `dsh-leader-agent-worker-task`、`MarkdownText` 与「Leader 派发的任务」提示）。
- `npm run e2e`：8/8 场景通过（`env -u DSH_PROFILE`）。
- 双向验证：删掉 `src/client/index.js` 里的任务气泡注册 → `客户端入口把任务节点定义与渲染器都挂上` 变红；还原 → 全绿。把正文换回 `UserTextRun`（或去掉 `Markdown` 包装）→ `任务正文交给 Markdown 渲染，不做行级改写` 变红；还原 → 全绿。去掉 `[data-markdown-variant='compact']` 颜色钩子 → `三处容器用 data-markdown-variant 钩子恢复正文与链接色` 变红；还原 → 全绿。
- 双向验证（视觉）：`align-items: flex-end` 改成 `flex-start`、`* 0.702` 改回 `* 1`、`padding: 10px 16px` 改成 `8px 16px`、`formatBubbleClock(data.time)` 改成 `0`、`writeText(body)` 改成 `writeText('')`，五种改法都让最后一个用例变红；还原 → 全绿。
- 宿主源码读数（rc.5 asar）：宿主用户消息是 `UserMessageBubble` + `conversation.user.text` → `UserText` / `UserTextRun` 纯文本，气泡 CSS `_bubble_1sgyj_1` 的 `white-space: pre-wrap` 保留单换行；这是本仓任务气泡**没有**跟随的路径。任务气泡走 `MarkdownText` compact，单换行按 Markdown 合并。`1bec9f3` 已取证 `strong` 与行内 `code` 的实际渲染（见上一条边界）；`edfa079` 复用同一 `Markdown` 组件与 compact 变体，`npm run e2e` 8/8 覆盖插件加载与既有场景，接线由单测钉住。
