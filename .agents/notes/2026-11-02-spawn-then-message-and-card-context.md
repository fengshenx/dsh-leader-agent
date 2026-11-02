# 派工两段化与卡片上下文

**状态**：implemented（2026-11-02）
**范围**：`src/host/{dispatch,worker-sessions,index}.js`、`src/host/tools/{spawn-worker,cards}.js`、`src/host/cards/{store,card-context}.js`、`.agents/skills/leader-mode/`、`docs/architecture.md`、`tests/`

## 背景

用户提出三件事：worker 建出来后不要立刻开工，等协调者发消息；那条消息要带卡片信息；worker 有产出（如 PR）时能自己挂到卡片链接上。

现状的三个缺口：

- `spawn_worker` 建完会话立即 `followup(initialMessage)`（`worker-sessions.js`），而槽位绑定要等协调者拿到 `childId` 再 `update_card` 写入。worker 首轮请求组装时索引里还没有它，角色槽位正文要到下一次模型请求才出现；协议层把这当成已知限制，要求首轮简报点名方法入口（`program.md` 当时的写法）。
- 卡片事实没有任何注入路径：worker 的工具面被裁掉 `list_cards`，也没有按绑定渲染 spec 的 provider。协调者只能把 spec 抄进任务消息。
- `update_card` 的 `links` 是整体替换，worker 想挂 PR 就得先读整卡；而它读不到卡（`list_cards` 被禁），冲突时只能盲改或报错。

## 决策

### 派工两段化：`spawn_worker` 只建会话，`message_worker` 才开工

`spawn_worker({ name, cardId?, slot?, force? })` 建会话、登记、可选绑卡后立即返回，不产生模型调用；任务正文由 `message_worker` 的第一条消息投递。

- **为什么不在 `spawn` 内部先绑卡再 `followup`**：那样首轮能带角色与卡片，但派工语义仍是一次调用完成「建人」与「派活」两件事。用户要的是显式分工：绑定与任务都落定之后才开工，重启/复用同一条投递路径。
- **绑卡在返回前完成**：会话 id 是预生成的，绑定写入成功后才返回 `childId`；协调者随后的第一条消息请求组装时，`slotIndex` 与 `cardIndex` 都已就绪。
- **绑定失败即回滚**：`bindSlot` 抛错时销毁刚建的会话，不写登记表——留一个没挂卡的会话，协调者会以为指派好了。
- **派工不建在飞记录**：没有消息就没有 turn，先挂一条在飞记录会让结算等一个永远不来的 `turn/end`。在飞记录由 `message` 首次投递建立。
- **本进程归属兜底**（`owners`）：`message` 的归属校验原本只读落盘登记表，登记失败时同一轮里连自己刚建的 worker 都投不进。内存归属只补本进程窗口，登记表仍是跨进程真源；换协调者时 `owners` 与在飞记录一起改投。

### 卡片事实走运行时上下文，不拼进任务消息

`src/host/cards/card-context.js` 注册 `systemPrompt.context` provider（order 106，排在角色槽位之后），渲染编号、标题、状态、槽位、revision、spec 全文与链接列表。

- 卡片是会被改的事实：worker 自己挂 PR、协调者改 spec/验收。拼进消息就冻结成派工那一刻的快照，后续轮次读到的仍是那条旧消息。
- 宿主对运行时上下文的语义是「每轮求值、渲染文本变化才追加一条 user 消息」，所以卡片没变的轮次不重复注入，体积只在首次与变更时付出。
- 同步索引 `cardIndex` 与 `slotIndex` 在同一条重建路径上维护（建卡、改卡、摘绑定、启动 `loadIndexes`），provider 才能在同步的提示词组装里读到。
- 槽位索引保留「一个会话一个槽位、后绑的卡胜出」；卡片事实索引保留**全部**绑定，多卡是异常但照实渲染并提示先确认服务哪一张。

### `addLinks` 增量合并，不放开 `list_cards`

`update_card` 新增 `addLinks`，在 store 的写链内按 id 合并（同 id 原位更新字段；无 id 按 `label + url` 去重），与整体替换的 `links` 互斥。

- worker 不需要先读整卡，也不会覆盖协调者刚写的条目；并发追加由写链串行化，条目不丢。
- 放 worker 进 `list_cards` 也能解决冲突重读，但那扩大了读取面与工具语义；增量合并把冲突消掉，改动更小。
- 卡片上下文里已带 `revision` 与当前链接，worker 有现状可对照。

### 槽位被占时拒绝，不静默顶替

`bindSlot` 在目标槽位已绑**别的**会话时抛错，提示先用 `update_card` 显式改派。静默顶替会让在跑的 worker 失去角色注入而不自知。

## 边界

- **空会话窗口**：建了 worker 但没投递时，它是一条空闲会话，占项目树一行与名册名额。协议要求同一轮投递；本方案不做超时回收。
- **空会话冷恢复未取证**：worker 没跑过 turn 时没有会话日志，进程重启后 `agents.resume` 能否恢复并投递，需真机验证（见下）。若不可行，退路是建会话时投递一条占位消息——不提前引入。
- **卡片上下文的体积**：spec 全文在首次注入与每次变更时进入上下文；按现有 spec 纪律（稳定需求，不追加历史）约束，不做截断（截断会让 worker 按残缺规格开工）。
- **不是每轮注入**：卡片没变的轮次不产生新消息；旧快照仍留在历史里，模型按最新的读。
- **注入不授予权限**：卡片事实与槽位一致，只贡献文本，工具面仍由 `tools/gate.js` 裁剪。
- **`spawn_worker` 不兼容旧参数**：仍传 `initialMessage` 会明确报错，不静默忽略（本仓未发布，不留垫片）。
- **工具名不变**：`spawn_worker` / `message_worker` / `update_card` 的名字与文档门禁比对集合不变。

## 验证

- 单测：660 例全绿（`npm test`）。新增覆盖：`card-context.test.js` 8 例（provider 属性、空绑定、规格/链接渲染、多卡提示、归档标注、渲染异常）；`cards-store.test.js` 9 例（`addLinks` 合并/同 id 更新/去重/互斥/无变化不 bump、`bindSlot` 绑定与拒绝顶替、`cardIndex` 随建卡改卡摘绑同步）；`cards-tools.test.js` 4 例（`addLinks` 追加、互斥、缺标签、schema 暴露）；`dispatch.test.js` 3 例（带卡派工在返回前完成绑定、槽位被占回滚且不登记、装配缺 `bindCardSlot` 时明确报错）与工具参数用例；`worker-sessions.test.js` 改为断言建会话不投递。
- 双向验证：
  1. 把 `dispatch` 的绑卡分支临时改成恒不执行 → 「派工带 cardId 与 slot 时，绑定先于开工完成」变红；还原后绿。
  2. 把 store 的 `addLinks` 临时改成整体替换 → 「addLinks 追加链接并保留原有条目」变红；还原后绿。
- 未做真机取证：需要隔离 `DSH_HOME` + mock provider 验证「首轮请求同时含角色槽位与卡片事实」「worker `addLinks` 后看板 2 秒内出现链接」以及空会话冷恢复，留待下一次 GUI 取证。
