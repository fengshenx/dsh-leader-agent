# Agent Note: worker 的显示名与工具参数面

Status: implemented

## Problem

用户指出派工与续聊的参数太少，点名要 `name` 与 `rename`。原参数是 `spawn_worker(task, label?)` 与 `message_worker(childId, message)`：`label` 可选，缺了就截任务正文前 40 字充数，用户看到的是一句话的开头。

## Decision

- **参数面按 worker 工具的通行形状收敛**：`spawn_worker(name, cardId?, slot?, force?)`、`message_worker(sessionId, message, rename?)`。派工只建会话并立即返回，首条消息由 `message_worker` 投递（[派工两段化](2026-11-02-spawn-then-message-and-card-context.md)），`initialMessage` 随之删除。
- **`name` 必填**，不是可选的 `label`：名字是 worker 的身份，也是它在侧栏里的可读性来源；缺了就只能拿任务正文当名字。
- **`sessionId` 而不是 `childId`**：这个值本来就是会话 id，`childId` 是宿主 subagent 内部对「子会话」的叫法；工具面照用户与模型的视角命名。
- **`rename` 而不是独立的改名工具**：改名几乎总是伴随一次投递，拆成两个工具会让模型在同一轮里多写一次调用。
- **`cardId` 是投递卡门禁**：槽位绑定是「卡 → 槽位 → 会话」的多对多投影，一个会话可能同时挂在多张卡上，所以按「任一 active 卡匹配即放行」：挂未完成卡的 worker 不得接别的工作，否则同一条会话会同时服务两张卡、产物落错卡。
- **`force` 是名册软上限的逃逸**：常驻化之后「结算即回收」不存在了，未归档 worker 会一直占着，上限必须有。默认 50，到顶先给可复用候选（`message_worker` 冷恢复），确需新建时传 `force` 说明理由。
- **`name` 直接钉成 worker 的会话标题**：宿主会按首条 user 消息自动起标题，不钉住的话侧栏与项目树显示的是任务正文开头。实现要求 live session，worker 被销毁后改不动，此时登记表照样落新名（完成通知读它），只记一条日志——会话标题是显示面，改不成不能让派工或投递失败。
- **内部字段 `label` 一律改 `name`**：登记表、通知记录、消息来源包装与客户端视图数据同一个名字；旧的宿主字段 `startActivation({ label })` 已随 worker 常驻化删除。
- **旧数据只做读取退回，不做迁移**：旧记录只有 `label`，读时 `name ?? label`。不保留兼容垫片的原则针对写入路径与格式迁移；已落盘的运行时记录读旧字段，省下的是用户的历史通知。

## Alternatives considered

- **保留可选 `label`、缺了截任务正文**：用户看到的是一句话开头；`name` 改必填并钉成会话标题。
- **保留 `childId` 与独立改名工具**：`childId` 是宿主 subagent 内部叫法，改名几乎总伴随投递；用 `sessionId` + `rename`。
- **不做卡门禁 / 不设 worker 上限**：一个会话可能同时服务多张卡，常驻 worker 也会无界累积；卡门禁 + 默认 50 + `force`。
- **为旧 `label` 写兼容垫片**：只读旧记录用 `name ?? label`，写入路径不保留旧格式。

## Consequences

- **会话标题改名没有真机取证**：`sessionTitle.rename` 要求 live session，mock 实例里 worker 立刻跑完并销毁，抓不到改名瞬间；单测只覆盖「调用被发起且参数正确」，UI 里是否立即刷新未实测。
- **`rename` 对运行中 worker 的时序未实测**：现在先改名再投递（改名失败只记日志），宿主侧标题事件与消息事件的先后顺序没有取证。

收益：派工参数与 worker 身份一致：名字必填、改名随投递、卡门禁与上限挡住串卡与无界增长。

## Testing

`tests/dispatch.test.js`、`tests/worker-sessions.test.js`、`tests/worker-registry.test.js`、`tests/message-worker-tool.test.js` 钉住标题钉名、改名落盘与参数校验；双向：去掉派工后的改名调用或登记表的赋值，对应用例变红。
