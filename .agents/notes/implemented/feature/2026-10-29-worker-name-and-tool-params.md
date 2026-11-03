# worker 的显示名与工具参数面

**状态**：implemented（2026-10-29）
**范围**：`src/host/tools/spawn-worker.js`、`src/host/tools/message-worker.js`、`src/host/dispatch.js`、`src/host/worker-registry.js`、`src/shared/worker-report.js`、`src/client/worker-report-definition.js`、`src/client/worker-report-view.js`、`skills/leader-mode/playbooks/program.md`、`README.md`、`tests/dispatch.test.js`、`tests/dispatch-continuation.test.js`、`tests/message-worker-tool.test.js`、`tests/worker-registry.test.js`、`tests/worker-report.test.js`

## 背景

用户指出派工与续聊的参数太少，点名要 `name` 与 `rename`。原参数是 `spawn_worker(task, label?)` 与 `message_worker(childId, message)`：`label` 可选，缺了就截任务正文前 40 字充数。

## 决策

**参数面按 worker 工具的通行形状收敛**：`spawn_worker(name, initialMessage)`、`message_worker(sessionId, message, rename?)`，两组前两项都必填。三处命名的选择各有理由：

- `name` 必填而不是可选的 `label`。名字是 worker 的身份，也是它在侧栏里的可读性来源，缺了就得拿任务正文当名字——这正是首条消息自动起标题的效果，用户看到的是一句话的开头。
- `sessionId` 而不是 `childId`。这个值本来就是会话 id，`childId` 是宿主 subagent 内部对「子会话」的叫法，工具面照用户与模型的视角命名。
- `rename` 而不是独立的改名工具。改名几乎总是伴随一次投递（worker 换角色继续干活），拆成两个工具会让模型在同一轮里多写一次调用。

**起初没搬、后来按用户要求补上的两项**：

- `cardId`（投递卡门禁）：最初的判断是「没有 worker 挂 active 卡这一层运行时约束」，但本 bundle 的槽位绑定就是「卡 → 槽位 → 会话」的多对多投影，一个会话可能同时挂在多张卡上。于是门禁按「任一 active 卡匹配即放行」实现：挂未完成卡的 worker 不得接别的工作，否则同一条会话会同时服务两张卡、产物落错卡。
- `force`（名册软上限逃逸）：常驻化之后「结算即回收」不存在了，未归档 worker 会一直占着，上限必须有。默认 50，到顶先给可复用候选（`message_worker` 冷恢复），确需新建时传 `force` 说明理由。

这两项的实现与理由见 [worker 常驻化与交作业](../architecture/2026-10-29-worker-as-root-session.md)。

**`name` 直接钉成 worker 的会话标题**。这是这项改动真正被看见的部分：宿主会按首条 user 消息自动起标题，不钉住的话侧栏与项目树显示的是任务正文开头。实现走宿主 `sessionTitle.rename(session, name)`，它要求 live session——worker 被销毁后改不动，此时登记表照样落新名（完成通知读它），只记一条日志说明标题没改。会话标题是显示面，改不成不能让派工或投递失败。

**内部字段 `label` 一律改 `name`**：登记表、通知记录、消息来源包装（`worker-report` 的 `worker` 字段）与客户端视图数据同一个名字。改名前的宿主字段 `startActivation({ label })` 已随 worker 常驻化一并删除——worker 现在建的是根会话，不再走 subagent 通道。

**旧数据只做读取退回，不做迁移**：改名之前落盘的 worker 记录、通知队列与消息来源只有 `label`，读的时候 `name ?? label`。仓库未发布不保留兼容垫片的原则针对写入路径与格式迁移；已落盘的运行时记录读一条旧字段省下的不是垫片而是用户的历史通知。

## 验证

- `npm run check`：368 例全绿（362 + 6 新增：登记表改名落盘、派工钉标题、会话不在内存时派工照常成功、续聊改名同时改两处并影响完成通知、rename 非字符串报错、rename 与投递同次交给派工器）。
- 回归有效性双向验证（三条，精确撤销后对应用例变红，还原后 `diff -q` 一致）：
  - 去掉派工后的 `renameSessionTitle(...)` → 「派工时把 worker 会话标题定成 name」红。
  - 去掉续聊里的 `renameWorker(...)` → 「续聊带 rename 时登记表与会话标题都改到新名字」红。
  - 去掉 `workers.rename` 里的赋值 → 「改显示名落盘，跨实例读得到新名」红。
- `npm run build:client` 通过。

## 未覆盖

- **会话标题改名的真机取证没做**。`sessionTitle.rename` 要求 live session，mock 实例里派工后 worker 立刻跑完并销毁，抓不到改名瞬间的侧栏标题；单测覆盖了「调用被发起且参数正确」，标题在 UI 里是否立即刷新没有实测。
- **`rename` 对运行中 worker 的时序没有实测**。现在的顺序是先改名再投递（改名失败只记日志），宿主侧标题事件与消息事件的先后顺序没有取证。
