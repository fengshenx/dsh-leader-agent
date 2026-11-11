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

### 任务正文始终走 Markdown，逐行结构补硬换行

leader 写任务时常把「做什么 / 边界 / 验收」各占一行，直接交给 Markdown 会被软换行折成一段；退回纯文本又会让 `**粗体**`、行内代码显示成字面量。`hardBreakMarkdown`（`src/shared/message-text.js`）给非空、非代码、非段落边界的行补两个尾随空格，GFM 渲染成 `<br>`，行内语法照常生效。围栏代码块按字符与长度配对，缩进代码块与已有硬换行不碰；关闭行按开栏时的容器缩进与块引用层数识别——嵌套列表里缩进 4 空格的关闭行照样关得掉，围栏里以 `> ``` ` / `- ``` ` 开头的代码行也不会被误当成关闭行。worker 回报仍用 `bubbleFormat` 的判据：失败原因与旧回报的协议行保持纯文本。

### 文本与格式判据收进 shared

host 的 `blocksToText` 与 shared 的 `workerReportText` 是同一份实现的两份拷贝；client 又不能 import `src/host/message.js`（带 `node:crypto`）。两者合并到 `src/shared/message-text.js`（`messageText`、`bubbleFormat`、`hardBreakMarkdown`），host 的通知正文、转录折叠与两个气泡共用 `messageText`；时钟抽到 `src/client/bubble-clock.js`。`workerReportFormat` 保持原签名，内部改调 `bubbleFormat`。

## 边界

- 任务气泡没有身份头：不显示 leader 名字与头像，也不能点名字跳回 leader 会话。`source.parentSessionId` 仍随消息落盘并作为认领凭证（没有它退回官方上下文行），但不再驱动界面。任务气泡也没有独立的可见标识，只能靠内容与 Markdown 渲染与用户自己的消息区分；气泡带 `title` / `aria-label`「Leader 派发的任务」做悬停与读屏提示，这条边界写在 `docs/usage.md`。
- 只认追加事件（`surfaceOp === 'append'`）：替换副本只应留在模型侧，不进人类转录，官方同类定义也是这条口径。
- 用户气泡不折叠：长任务全文展示。worker 回报气泡仍默认两行、超出给「展示更多」。
- 气泡布局没有单测（React 组件 + 宿主模块表），仓库仍不引 jsdom；`tests/markdown.test.js` 的源码断言覆盖右对齐、无身份头、Markdown 接线、宽度上限（70.2% / 82%）、`10px 16px` 内边距、时间与复制按钮、令牌色值，实际观感靠真机探针。
- 本 PR 没有派工场景的 e2e：mock 的脚本游标是全局单值，且 `message_worker` 需要上一步 `spawn_worker` 结果里的动态会话 id，现有 mock 无法表达。真机探针用「把一份真实 worker 会话日志复制进临时数据根、从侧栏打开」取证，它验证渲染，不验证派工链路，也不入库。要覆盖派工得先给 mock 按 session 分游标、并支持从工具结果取参，那是独立的一步。

## 验证

- 更新单测：`tests/worker-task.test.js` 覆盖 source 判型、`match`、`start`/`buildViewNode`、硬换行（含嵌套列表关闭围栏、围栏内 `> ``` ` / `- ``` ` 代码行、表格行与关闭围栏后的状态恢复）与客户端入口接线；`tests/bubble-clock.test.js` 覆盖三种时间形态；`tests/client-styles.test.js` 覆盖新样式表的幂等注入；`tests/markdown.test.js` 覆盖右侧用户气泡的形态（宽度上限、内边距、时间、复制、title / aria-label）与 Markdown 接线。
- `npm test`：1120 条，1103 通过 / 17 skip。
- `npm run check`：全绿（笔记 90 篇、文档预算、108 文件语法、覆盖率 1103 用例 / 79 源文件 / 61 加载 / 53 个 100% / 18 未测量）。
- `npm run build:client`：通过（客户端产物重建，含 `dsh-leader-agent-worker-task`、`hardBreakMarkdown` 与「Leader 派发的任务」提示）。
- `npm run e2e`：8/8 场景通过（`env -u DSH_PROFILE`）。
- 双向验证：删掉 `src/client/index.js` 里的任务气泡注册 → `客户端入口把任务节点定义与渲染器都挂上` 变红；还原 → 全绿。把 `hardBreakMarkdown(body)` 改回 `body` → `气泡渲染 Markdown 组件，旧消息回退纯文本` 变红；还原 → 全绿。把 `align-items: flex-end` 改成 `flex-start` → `leader 任务用右侧用户气泡：无身份头、不折叠、正文只给 Markdown` 变红；还原 → 全绿。
- 双向验证（围栏启发式）：去掉 `closesFence` 里按容器缩进的退让 → `任务正文始终按 Markdown 渲染，逐行结构补成硬换行` 变红（嵌套列表关闭行后丢硬换行）；还原 → 全绿。把围栏内的关闭判断改回「先 `stripContainers` 再比对」→ 同用例变红（`code` 被补两个尾随空格）；还原 → 全绿。测试钉住的视觉细节也逐个撤过：`* 0.702` 改回 `* 1`、`padding: 10px 16px` 改成 `8px 16px`、`formatBubbleClock(data.time)` 改成 `0`、`writeText(body)` 改成 `writeText('')`，四种改法都让最后一个用例变红；还原 → 全绿。
- 真机读数（`DSH_PROFILE=web`，真实宿主 rc.5 + 从 `~/.dsh` 复制的 worker 会话，chromium 1440×900）：侧栏打开 worker 会话后，两条任务消息都渲染成 `data-chat-flow-kind="dsh-leader-agent-worker-task"` 的气泡；内层气泡宽 521px（内容栏 742px 的 70.2% 上限）、右对齐、`rgb(237, 243, 254)` 底色、20px 圆角、`10px 16px` 内边距，`data-markdown-variant="compact"`，`strong` 5 处、行内 `code` 28 处；同一会话里自己发的用户气泡右边缘与任务气泡对齐，但那段 `**加粗**` 显示为字面量——这正是「用户气泡 + Markdown」的刻意差异。截图 `.dev` 下临时取证，不入库。
