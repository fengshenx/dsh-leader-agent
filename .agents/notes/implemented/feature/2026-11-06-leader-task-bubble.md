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

### 任务正文按宿主用户消息的纯文本路径渲染

先查宿主自己的用户消息：`UserMessageBubble`（`ui-primitives`）只是气泡外壳，正文由 `conversation.user.text` factory 渲染；`client-ui-conversation` 的 `UserText` 对普通文本节点用 `UserTextRun`（一个 `<span>`）输出纯文本，不经过 Markdown 解析。`client-ui-chat` 调 factory 时传 `{ text, facts, interactive, ellipsis }`，用户消息的 facts 是 `EMPTY_TEXT_FACTS = {}`，不会触发 `collapseWhitespace` / `trimWhitespace` 规则；这两条只给队列预览用。气泡外壳的 CSS `_bubble_1sgyj_1` 带 `white-space: pre-wrap`，提交与回显也把 `text` 原样放进消息，没有把 `\n` 改成 `\n\n`。因此宿主用户消息的**单换行由 CSS pre-wrap 保留**，原文里的 `**加粗**`、行内代码、围栏都按字面量显示。

任务气泡因此不再自研行级预处理：`WorkerTaskView` 把 `data.text` 原样交给 `UserTextRun`，气泡 CSS 用宿主用户气泡的 `white-space: pre-wrap` 与 `calc(22px + var(--dsh-content-font-delta, 0px))` 行高；不解析 Markdown、不补尾随空格、不碰围栏。`UserMessageBubble` 本身在 `engines.dsh` 下限 rc.2 还没有导出，外壳仍按 `--dsw-*` 令牌复刻；`UserTextRun` 在 rc.2 已导出，正文叶子与宿主同一条。worker 回报仍走 `bubbleFormat` 的 Markdown 判据，两套形态分开。

### 文本与格式判据收进 shared

host 的 `blocksToText` 与 shared 的 `workerReportText` 是同一份实现的两份拷贝；client 又不能 import `src/host/message.js`（带 `node:crypto`）。两者合并到 `src/shared/message-text.js`（`messageText`、`bubbleFormat`），host 的通知正文、转录折叠与两个气泡共用 `messageText`；时钟抽到 `src/client/bubble-clock.js`。`workerReportFormat` 保持原签名，内部改调 `bubbleFormat`。

## 边界

- 任务气泡没有身份头：不显示 leader 名字与头像，也不能点名字跳回 leader 会话。`source.parentSessionId` 仍随消息落盘并作为认领凭证（没有它退回官方上下文行），但不再驱动界面。任务气泡也没有独立的可见标识，只能靠内容与右侧用户气泡的形态与用户自己的消息区分；气泡带 `title` / `aria-label`「Leader 派发的任务」做悬停与读屏提示，这条边界写在 `docs/usage.md`。
- 只认追加事件（`surfaceOp === 'append'`）：替换副本只应留在模型侧，不进人类转录，官方同类定义也是这条口径。
- 用户气泡不折叠：长任务全文展示。worker 回报气泡仍默认两行、超出给「展示更多」。
- 任务正文和宿主用户消息一样按纯文本渲染：`**加粗**`、行内代码、围栏/引用/列表都按字面量显示，单换行由气泡的 `pre-wrap` 保留；要 Markdown 语义得改宿主用户消息路径，本仓不自己补。
- 气泡布局没有单测（React 组件 + 宿主模块表），仓库仍不引 jsdom；`tests/markdown.test.js` 的源码断言覆盖右对齐、无身份头、`UserTextRun` 接线与 `pre-wrap`、宽度上限（70.2% / 82%）、`10px 16px` 内边距、时间与复制按钮、令牌色值，实际观感靠宿主源码与样式断言；任务气泡没有单独真机读数，原因见下一条。
- 本 PR 没有派工场景的 e2e：mock 的脚本游标是全局单值，且 `message_worker` 需要上一步 `spawn_worker` 结果里的动态会话 id，现有 mock 无法表达。任务气泡也没有单独的真机读数：worker 会话默认不在侧栏，复制日志成普通会话会被宿主当成未知会话重建；能证明的是宿主用户消息的源码路径（`UserTextRun` + `pre-wrap`）与本仓同一路径的源码断言。要覆盖派工得先给 mock 按 session 分游标、并支持从工具结果取参，那是独立的一步。

## 验证

- 更新单测：`tests/worker-task.test.js` 覆盖 source 判型、`match`、`start`/`buildViewNode`、`任务正文原样交给宿主用户消息同款纯文本渲染器`（正文逐字透传、含围栏/引用/列表的文本不被改写、`UserTextRun` 接线）与客户端入口接线；`tests/markdown.test.js` 覆盖右侧用户气泡的形态（宽度上限、内边距、`pre-wrap`、时间、复制、title / aria-label）与 `UserTextRun` 接线；`tests/bubble-clock.test.js` 覆盖三种时间形态；`tests/client-styles.test.js` 覆盖新样式表的幂等注入。
- `npm test`：1120 条，1103 通过 / 17 skip。
- `npm run check`：全绿（笔记 90 篇、文档预算、108 文件语法、覆盖率 1103 用例 / 79 源文件 / 61 加载 / 53 个 100% / 18 未测量）。
- `npm run build:client`：通过（客户端产物重建，含 `dsh-leader-agent-worker-task`、`UserTextRun` 与「Leader 派发的任务」提示）。
- `npm run e2e`：8/8 场景通过（`env -u DSH_PROFILE`）。
- 双向验证：删掉 `src/client/index.js` 里的任务气泡注册 → `客户端入口把任务节点定义与渲染器都挂上` 变红；还原 → 全绿。把 `UserTextRun` 换回 `Markdown`（或加回 `hardBreakMarkdown`）→ `任务正文原样交给宿主用户消息同款纯文本渲染器` 变红；还原 → 全绿。去掉气泡 CSS 的 `white-space: pre-wrap` → `leader 任务用右侧用户气泡：无身份头、不折叠、正文与宿主用户消息同路径` 变红；还原 → 全绿。
- 双向验证（视觉）：`align-items: flex-end` 改成 `flex-start`、`* 0.702` 改回 `* 1`、`padding: 10px 16px` 改成 `8px 16px`、`formatBubbleClock(data.time)` 改成 `0`、`writeText(body)` 改成 `writeText('')`，五种改法都让最后一个用例变红；还原 → 全绿。
- 宿主源码读数（rc.5 asar）：用户消息外壳 `UserMessageBubble` 的类 `_bubble_1sgyj_1` 声明 `white-space: pre-wrap`，用户文本节点由 `UserText` → `UserTextRun` 输出纯文本；用户消息 facts 是 `EMPTY_TEXT_FACTS = {}`，不触发 collapse / trim 规则。本仓任务气泡用同一个 `UserTextRun`，CSS 声明同一个 `white-space: pre-wrap` 与同一行高；两边都不产生 `<br>`，单换行靠 CSS 保留。任务气泡的 DOM 行数没有单独真机读数（原因见上一条边界）；`npm run e2e` 8/8 覆盖插件加载与既有场景，任务气泡的文本路径由 `tests/worker-task.test.js` 的源码断言钉住。
