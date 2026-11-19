# Agent Note: worker 回报气泡的呈现

Status: implemented

> **部分被 [worker 头像改用 blobatar](2026-11-19-blobatar-avatars.md) 取代**：minidenticons、63 seed 池与「深色轮廓弱」的取舍已不成立；source 标记、节点定义与气泡结构仍以本篇为准。

## Problem

worker 的完成通知此前是一条普通用户消息，正文带「【worker 回报】」前缀，渲染成右对齐的用户气泡：读起来像用户自己在说话，还混着协议口吻。回报需要以助手侧形态呈现，身份头在气泡上方单独一行，正文里没有前缀。

## Decision

- **说话人标记放在 `source`，不放正文**：通知消息用自定义 kind `dsh-leader-agent/worker-report`，带 `worker: { name, childSessionId, report, outcome }` 与通用契约的 `form: 'notice'` + `summary`。正文是模型读的事实，前缀会同时污染模型上下文与界面；`source` 是宿主的归属字段，链路上原样透传，自定义 kind 原样落进 session log（宿主自己就有十几个这样的 kind，是预留的扩展位）。`form: 'notice'` + `summary` 保证降级成官方上下文行时，折叠行显示的是人话而不是原始 kind 字符串。
- **前缀在生成侧去掉**，不靠「注入前缀再视图层剥离」：正文是自己拼的，不写更省一层，也没有解析失败时的兜底分支。
- **新增独立 Chat node kind，用 exclusive claim 接管**：注册独立 `ConversationNodeDefinition`，`match` 只认带本仓 source 标记的 `user/message`，返回 `exclusive: true`，再按 kind 注册 keyed renderer，影响面只有 worker 回报这一类消息。抢占 `user` key 要完整复刻官方用户渲染器（右对齐、actions 行、pending/echo 态），DOM 后处理又认不出插件消息且会被 React 覆盖，两条都否决。
- **`groupTree` 必须给，且按官方口径条件式**：没有 `groupTree` 的节点会被归进回合的过程折叠区并默认隐藏——建好了却看不见。回合首步开启新 exchange，其余留在 `'input'`：连续多次回报不该全落进上一个 exchange，它是被 `followup` 唤醒的新 turn 的第一条输入。
- **界面渲染与模型读的事实分开**：正文保留完整协议字段（任务、子会话 id、状态、产物摘要、下一步）给模型；界面只渲染 worker 最后一次回报的内容——成功是产物摘要，失败是失败原因，单独放在 `source.worker.report` 里（`outcome` 记终态）。
- **气泡底用前景色混出极淡一层**：比页面同色的底色更有层次，又不抢正文。
- **名字是按钮，点击下钻到 worker 的子会话**：走 `uiWorkspace.openSession(childSessionId)`；`uiWorkspace` 只挂在 web-app bundle 上，必须惰性 `ctx.get('uiWorkspace')`，写进 `inject` 缺服务会让整个插件挂起。
- **气泡下方是时间与复制按钮**，与官方消息底部 chrome 同形：时间按宿主口径（今天 `HH:MM`、同年往日 `M月D日 HH:MM`、跨年加年份；本仓不做多语言，固定中文）；复制自己实现，宿主 `useClipboardCopy` 不可 import。
- **头像用 `minidenticons`，种子取 worker 的身份名**：同名恒同图，底色与图案同色相并满足非文本对比度基线；用显示文案派生会同一 worker 跨任务换脸。
- **只认领追加到转录尾部的事件**（`surfaceOp === 'append'`）：替换副本只应留在模型侧，不该出现在人类转录里。
- **`notice` 摘要压到 120 字符**：宿主把这条约束写在生产者身上，本仓不 peer 依赖 dsh 内部包，在 `shared/worker-report.js` 里等价实现。

## Alternatives considered

- **继续在正文写「【worker 回报】」前缀**：同时污染模型上下文与界面，读起来像用户自己说话；说话人放 `source`。
- **注入前缀再在视图层剥离**：多一层解析与失败兜底；生成侧直接不写。
- **抢占官方 `user` key 或做 DOM 后处理**：要完整复刻官方用户渲染器，DOM 还会被 React 覆盖；注册独立 Chat node。
- **把回报并进上一个 exchange**：连续回报会全落进上一条；`groupTree` 让每次回报开新 exchange。

## Consequences

- **回报不进会话标题、turn 摘要与 markdown 转录导出**：宿主只把 `source.kind === 'user'` 算作真人输入。这是自定义 kind 的代价，换来它不会被误当成用户说的话。
- **历史消息不追溯**：改造前的通知仍是老形态；改造后但带 `report` 之前落盘的消息没有回报正文，气泡退回显示整条正文。
- **降级形态**：定义没注册上时消息退化成官方上下文注入行，而不是右对齐用户气泡，内容不丢。
- **深色主题下头像外轮廓弱**：不描边、不加容器环、不提亮底色——补救层在头像尺寸下显得又脏又重。
- **头像会撞图**：内置 seed 只有 63 个，撞图不影响身份识别——名字就在头像旁边。
- **渲染器组件本身没有单测**：本仓不引 React 与 jsdom；可判定的逻辑（source 判型、正文取文本、头像种子、定义的 match/start/buildViewNode）已抽成纯模块并覆盖。
- 客户端 bundle 多了唯一运行时依赖 `minidenticons`（纯 JS、无传递依赖）。

收益：worker 回报以助手侧气泡呈现，身份与产物分开，模型读到的是事实而不是协议前缀。

## Testing

`tests/worker-report.test.js` 覆盖 source 判型、正文无前缀、头像种子、节点定义的 match 与 `groupTree`、摘要长度；真机读数：session log 里 `source.kind` 为 `dsh-leader-agent/worker-report`、气泡左对齐带头像，用户自己的输入仍是右对齐气泡。
