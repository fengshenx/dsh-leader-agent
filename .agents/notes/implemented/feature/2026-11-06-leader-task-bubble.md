# Agent Note: leader 任务在 worker 会话里渲染成用户气泡

Status: implemented

## Problem

leader 用 `message_worker` 投给 worker 的消息，在 worker 会话里显示成一条「收到执行请求」的紧凑上下文行，点开才看到任务正文——宿主的 `input-message` 按 `source.kind === 'user'` 区分真人输入与其他上下文，而本仓的 `dsh-leader-agent/worker-task` 是自定义 kind，落进了官方的「触发行」分支。

## Decision

- **任务消息用独立 Chat node kind 认领**：`dsh-leader-agent-worker-task` 只认 `user/message` + `surfaceOp === 'append'` + `source.kind === 'dsh-leader-agent/worker-task'`，用 `exclusive` 让官方定义不再处理它；分组位置与官方同类节点一致（回合首步给 `exchange`，其余给 `input`）——省掉 `groupTree` 会让节点落进回合的过程折叠区被默认隐藏，worker 收到任务却看不见。
- **认领失败退回官方上下文行**，内容不丢；旧记录只要 `source.kind` 与 `parentSessionId` 都对得上也按气泡渲染，不另做迁移；改名前的 `dsh-leader-kit/worker-task` 不被认领，退回上下文行。
- **渲染成用户气泡，而不是 agent 气泡**：在 worker 的会话里 leader 就是那个「user」，消息要驱动回合，形态也该与用户自己的消息一致——右对齐、无头像与名字、不折叠，只保留用户气泡的底色、圆角、内边距与最大宽度，下方是时间与复制按钮。宿主的 `UserMessageBubble` 是 rc.2 之后才进基线 `ui-primitives` 的导出，而下限仍是 rc.2，静态 import 在旧宿主上会拿到 `undefined`，所以按宿主数值用 `--dsw-*` 令牌复刻。worker 回报继续用左侧 agent 气泡，两套形态分开、不再共享布局。
- **任务正文与 assistant 内容同套 Markdown**：走 `Markdown` 包装（基线 `MarkdownText`，`variant: 'compact'`）。宿主的 `MarkdownText` 没有 `breaks` / 软换行开关，因此不做行级预处理：原文直接交给渲染器，单换行按 Markdown 规则合并，空行、标题、列表、围栏决定块结构，需要断行时用空行或 Markdown 语法。
- **这是有意取舍**：宿主自己的用户消息不是 Markdown（`UserTextRun` + `pre-wrap` 保留单换行），任务气泡特意不跟随，选择 assistant 内容的 Markdown 语义，也不维护「半个 CommonMark」的预处理；worker 回报仍按 `bubbleFormat` 判据走 Markdown / 纯文本，两套气泡共用 `MarkdownText` 但不共享正文策略。
- **文本与格式判据收进 shared**：host 的 `blocksToText` 与 shared 的 `workerReportText` 原本是同一份实现的两份拷贝，而 client 不能 import `src/host/message.js`（带 `node:crypto`）；合并到 `src/shared/message-text.js`（`messageText`、`bubbleFormat`），host 的通知正文、转录折叠与两个气泡共用 `messageText`，时钟抽到 `src/client/bubble-clock.js`，`workerReportFormat` 签名不变。

## Alternatives considered

- **继续让任务落进官方「触发行」**：正文要点开才看到，worker 收到任务却像一条系统通知；注册独立 Chat node。
- **渲染成 agent 左侧气泡**：在 worker 会话里 leader 就是那个 `user`，消息要驱动回合；用右侧用户气泡形态。
- **直接 import 宿主 `UserMessageBubble`**：它 rc.2 之后才进基线，下限版本会拿到 `undefined`；按宿主数值用 `--dsw-*` 令牌复刻。
- **为任务正文做换行预处理**：等于维护「半个 CommonMark」，还与 assistant 内容的 Markdown 语义分叉；原文直接交给渲染器。
- **让任务气泡与 worker 回报共用布局**：一边是用户气泡、一边是 agent 气泡，共享会把两套形态绑死；只共用 `MarkdownText`。

## Consequences

- **任务气泡没有身份头**：不显示 leader 名字与头像，也不能点名字跳回 leader 会话；`source.parentSessionId` 仍随消息落盘并作为认领凭证，但不再驱动界面。气泡没有独立的可见标识，靠内容与右侧用户气泡的形态与自己的消息区分，另带 `title` / `aria-label`「Leader 派发的任务」做悬停与读屏提示。
- **只认追加事件**（`surfaceOp === 'append'`）：替换副本只应留在模型侧，不进人类转录。
- **用户气泡不折叠**：长任务全文展示；worker 回报气泡仍默认两行、超出给「展示更多」。
- **气泡布局没有单测**（React 组件 + 宿主模块表，仓库仍不引 jsdom），形态与接线由 `tests/markdown.test.js` 的源码断言覆盖。
- **派工场景的 e2e 暂缺**：mock 游标是全局单值，`message_worker` 又需要 `spawn_worker` 返回的动态会话 id；要覆盖得先让 mock 按 session 分游标并支持从工具结果取参。

收益：worker 收到 leader 的任务时看到一条完整的用户气泡，正文按 Markdown 展开，不再是一条可折叠的系统通知。

## Testing

`tests/worker-task.test.js`、`tests/markdown.test.js` 与 `tests/bubble-clock.test.js`。双向：删掉任务气泡注册 → 「客户端入口把任务节点定义与渲染器都挂上」红；把正文换回 `UserTextRun` → 「任务正文交给 Markdown 渲染」红；把 `align-items` 改成 `flex-start` → 视觉用例红。还原后全绿。
