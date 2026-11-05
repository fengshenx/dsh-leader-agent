# leader 任务在 worker 会话里渲染成气泡

## 背景

leader 用 `message_worker` 投给 worker 的消息，在 worker 会话里显示成一条「收到执行请求」的紧凑上下文行，点开才看到任务正文。

根因在宿主的 `input-message` 定义：它按 `source.kind === 'user'` 区分真人输入与其他上下文，非 `user` 的一律按「触发行」渲染；本仓的 `dsh-leader-agent/worker-task` 是自定义 kind，落进 `turn-trigger` 的 `default` 分支，取 `message.trigger.request` 文案。worker 回报（`dsh-leader-agent/worker-report`）此前已经用独立 Chat node kind + exclusive claim 解决过同一类问题，任务消息只是没跟上。

## 决策

### 任务消息用独立的 Chat node kind 认领

新增 `dsh-leader-agent-worker-task` 节点定义，`match` 只认 `user/message` + `surfaceOp === 'append'` + `source.kind === 'dsh-leader-agent/worker-task'`，用 `exclusive: true` 让官方定义不再处理它。`start` 把正文、时间与 `parentSessionId` 装进状态，`buildViewNode` 的分组位置与官方同类节点一致：回合首步给 `exchange`（开启新 exchange），其余给 `input`。省掉 `groupTree` 会让节点落进回合的过程折叠区被默认隐藏——worker 收到任务却看不见。

认领失败（宿主版本漂移、注册没生效）时退回官方上下文行，内容不丢；旧记录只要 `source` 里有 `parentSessionId` 也按气泡渲染，不另做迁移。

### 与 worker 回报共用一套气泡组件

布局、折叠、复制、时间与 `MarkdownText` 的接线从 `worker-report-view.js` 抽到 `agent-bubble-view.js`，样式类名从 `dsh-leader-agent-worker-report__*` 改成中性的 `dsh-leader-agent-agent-bubble__*`；两个 view 只负责把节点状态翻成属性。任务气泡的身份是角色名「Leader」，头像种子取 `parentSessionId`（多个 leader 各是各的脸），点名字打开发起任务的会话。

正文格式沿用回报气泡的判据：单行、含空行或行首块级标记走 Markdown，逐行协议字段走纯文本——leader 写任务时常把「做什么 / 边界 / 验收」各占一行，交给 Markdown 会被软换行折成一段。

### 文本与格式判据收进 shared

host 的 `blocksToText` 与 shared 的 `workerReportText` 是同一份实现的两份拷贝；client 又不能 import `src/host/message.js`（带 `node:crypto`）。两者合并到 `src/shared/message-text.js`（`messageText` 与 `bubbleFormat`），host 的通知正文、转录折叠与两个气泡共用。`workerReportFormat` 保持原签名，内部改调 `bubbleFormat`。

## 边界

- 气泡上的名字固定是「Leader」，不是 leader 的会话标题：`message_worker` 落盘的 `source` 只有 `parentSessionId`，没有显示名。名字可点击跳回那个会话。
- 不认领没有 `parentSessionId` 的历史消息：身份按钮没有落点，退回官方上下文行比硬造一个不能点的气泡好。
- 只认追加事件（`surfaceOp === 'append'`）：替换副本只应留在模型侧，不进人类转录，官方同类定义也是这条口径。
- 气泡布局没有单测（React 组件 + 宿主模块表），仓库仍不引 jsdom；`tests/markdown.test.js` 的源码断言覆盖「折叠不用 line-clamp、行高取 compact 值」与类名接线，实际观感要靠真机。
- 本 PR 没有派工场景的 e2e：mock 的脚本游标是全局单值，且 `message_worker` 需要上一步 `spawn_worker` 结果里的动态会话 id，现有 mock 无法表达。要覆盖得先给 mock 按 session 分游标、并支持从工具结果取参，那是独立的一步。

## 验证

- 新增 7 条单测（`tests/worker-task.test.js`）：source 逐层判型、`match` 只认追加的任务消息、`start`/`buildViewNode` 的状态与分组、正文格式、文本提取、客户端入口接线。
- `npm test`：1107 条，1090 通过 / 17 skip；`npm run build:client` 通过（客户端产物重建）。
- 双向验证：删掉 `src/client/index.js` 里的任务气泡注册 → `客户端入口把任务节点定义与渲染器都挂上` 变红（fail 1）；还原 → 全绿。这条断言守住「定义、kind 与渲染器三者一起挂上」，只挂 view 或只挂定义都会红。
- 真机读数：未取证（原因见上一条边界）；本地已用真实宿主 + 从 `~/.dsh` 复制的 worker 会话尝试，但重启后 worker 会话不在 `ctx.sessions.list` 里（已知限制），项目树不亮行，无法在不派工的情况下打开目标会话。
