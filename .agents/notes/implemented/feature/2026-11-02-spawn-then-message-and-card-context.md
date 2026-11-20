# Agent Note: 派工两段化与卡片上下文

Status: implemented

## Problem

`spawn_worker` 建完会话立即投递任务，而槽位绑定要等协调者拿到 `childId` 再写卡，worker 首轮请求组装时索引里还没有它；卡片事实又没有任何注入路径（worker 被禁 `list_cards`，也没有按绑定渲染的 provider），协调者只能把 spec 抄进任务消息；`update_card` 的 `links` 是整体替换，worker 想挂 PR 就得先读整卡，而它读不到。

## Decision

- **派工两段化**：`spawn_worker({ name, cardId?, slot?, force? })` 建会话、登记、可选绑卡后立即返回，不产生模型调用；任务正文由 `message_worker` 的第一条消息投递。绑定与任务都落定之后才开工，重启与复用走同一条投递路径。
- **绑卡在返回前完成**：会话 id 是预生成的，绑定写入成功才返回 `childId`，随后首条消息组装时 `slotIndex` 与 `cardIndex` 都已就绪。
- **绑定失败即回滚**：销毁刚建的会话、不写登记表。呈现（改名、挂工作区）推后到绑定成功之后——改名会追加 `session/title` 让零 turn 会话落盘，而宿主没有删除会话文件的能力，失败回滚会留下孤儿 jsonl；派工因此用 `spawn({ deferPresentation: true })` + `present()` 两段。
- **不建在飞记录**：没有消息就没有 turn，先挂一条会让结算等一个永远不来的 `turn/end`；在飞记录由 `message` 首次投递建立。`owners` 只补本进程窗口的归属兜底，登记表仍是跨进程真源，换协调者时与在飞记录一起改投。
- **绑卡前校验**：在建会话之前判项目归属（卡有 `projectId` 时调用方项目必须一致，无归属的存量卡不拦）与卡状态（`done`/`archived` 拒绝），拒绝抛错、不静默跳过。否则 A 项目的协调者能写 B 的 `slots`、作废 B 持有的 `expectedRevision`，派出的 worker 每轮带着 B 的 spec。
- **写 `slots` 的两条路径共用同一道状态闸**：`bindSlot` 与 `update({ slots })` 都拒绝非 `active` 卡；`update` 同次把状态改回 `active` 是显式重新指派，放行。槽位已绑**别的**会话时抛错、提示显式改派——静默顶替会让在跑的 worker 失去角色注入而不自知。
- **卡片事实走运行时上下文**：注册 `systemPrompt.context` provider（排在角色槽位之后），渲染编号、标题、状态、槽位、revision、spec 全文与链接，不拼进任务消息（那会冻结成派工那一刻的快照）。宿主每轮求值、文本变化才追加一条 user 消息，所以没变的轮次不重复注入。
- **索引同一条重建路径**：`cardIndex` 与 `slotIndex` 在建卡、改卡、摘绑定、启动 `loadIndexes` 时一起维护，provider 才能在同步的提示词组装里读到。槽位索引一个会话一个槽位、后绑的卡胜出；卡片事实索引保留**全部**绑定，多卡照实渲染并提示先确认服务哪一张。
- **`addLinks` 增量合并**：`update_card` 新增 `addLinks`，在写链内按 id 合并（无 id 按 `label + url` 去重），与整体替换的 `links` 互斥。不放开 `list_cards`（会扩大读取面与工具语义），增量合并把冲突消掉，并发追加由写链串行化。两条路径共用链接校验与归一化（`normalizeHttpUrl`、按 WHATWG URL 落盘规范形式），增量路径不补 id，非法 URL 报同样的「第几条、哪个标签」错误。
- **挂卡门禁**：挂着 `active` 卡的 worker 只放行同卡续跑，别的 `cardId`（或干脆不带）都拒——一个会话同时服务两张卡会让产物落错卡。名册到顶时把这类 worker 从 `idle` 放进 `bound`，报错把「推荐复用（最久未用优先）」「挂着未完成卡」「最近新建（保留上下文）」分开列；候选必须过滤，否则提示与实际能力自相矛盾。名册 LRU 口径见[按最近使用复用](2026-11-20-slot-release-evidence-and-worker-lru.md)。
- **名册一次读盘**：`describeRoster` 用 `cardBindingsBySession` 取全量绑定再分组，不逐 worker 读 `cards.json`（O(N × 文件体积)），也不查启动时可能未就绪的同步 `cardIndex`——查不到绑定会让门禁 fail-open。
- **同时挂多张 `active` 卡直接拒绝**：那种会话在并行服务多条工作线，产物无从归属，而角色注入只按一张卡算；该状态只有整卡替换 `slots` 才造得出来，正常派工与关闭释放都不会。
- **关闭卡片自动释放执行者**：状态变 `done`/`archived` 时 store 把 `slots` 一并清空，绑定、槽位索引、卡片事实一起失效；`update_card` 拒绝「关闭卡片 + 同次绑定槽位」而非静默忽略；只在 `slots` 非空时才写空对象（否则 `isSameContent` 判变化、无谓 bump `expectedRevision`）；重新打开不恢复绑定——那是新的指派。
- **跨项目注入堵在写入侧**：`card-context` 按**会话 id** 取绑定，绑定写不进去就不会注入那张卡；存量绑错的数据不自动迁移。

## Alternatives considered

- **一段式派工：建会话后立刻投任务**：worker 首轮请求组装时槽位与卡片索引还没就绪；改为建会话、绑卡、返回，再由 `message_worker` 投第一条。
- **把 spec 抄进任务消息**：会冻结成派工那一刻的快照，改卡不生效；走运行时上下文每轮求值。
- **放开 `list_cards` 让 worker 自己读卡**：扩大读取面与工具语义，还得处理并发链接替换；用卡片上下文注入 + `addLinks` 增量合并。
- **绑定失败后靠事后清理**：改名会 materialize 会话文件，宿主没有删除能力，回滚会留下孤儿；把呈现推后到绑定成功之后。
- **允许一个会话同时挂多张 `active` 卡**：产物无从归属，角色注入只按一张卡算；直接拒绝。

## Consequences

- **空会话窗口**：建了 worker 却没投递时，它是一条空闲会话，占项目树一行与名册名额。协议要求同一轮投递，本方案不做超时回收。
- **绑定失败不留盘靠「不 materialize」**：宿主没有删除会话文件的能力，所以回滚不能删 jsonl；把改名这个 materialize 步骤推后，失败时磁盘上还没有文件。将来建会话本身若开始落事件，这条保证会失效。
- **空会话冷恢复未取证，且依赖改名这个间接保证**：宿主只有 `flush()` 才 materialize 空会话，当前靠派工成功时的改名追加了 `session/title`；装配里缺 `sessionTitle` 或将来去掉改名，重启后 `message_worker` 会冷恢复失败，而卡还绑在会话上。
- **未真机取证**：首轮请求同时含角色槽位与卡片事实、`addLinks` 后看板出现链接、空会话冷恢复，都需要隔离 `DSH_HOME` + mock/keyless provider 的 GUI 实例。
- **卡片上下文的体积**：spec 全文在首次注入与每次变更时进入上下文，按现有 spec 纪律（稳定需求、不追加历史）约束，不做截断（截断会让 worker 按残缺规格开工）。注入不授予权限，工具面仍由 `tools/gate.js` 裁剪。
- **关闭卡片会抽走在跑 worker 的上下文**：协调者在 worker 仍在跑时标 `done`，worker 下一轮就不再带卡片事实与角色槽位。这是「关闭即收工」的预期代价，协议层要求关闭前确认该轮已交活；store 看不到会话运行状态，关闭释放不区分谁在跑。
- **`spawn_worker` 不兼容旧参数**：仍传 `initialMessage` 会明确报错，不静默忽略；工具名与文档门禁比对集合不变。

收益：派工在绑定与任务都落定后才开工，worker 首轮就带着卡片事实与角色，失败回滚也不留孤儿。

## Testing

`tests/card-context.test.js`、`tests/cards-store.test.js`、`tests/cards-tools.test.js`、`tests/dispatch.test.js` 与 `tests/worker-sessions.test.js`。双向：去掉 `assertCardAssignable` → 跨项目绑卡用例红；把派工的 `deferPresentation` 改回 `false` → 「绑定失败回滚时不做呈现」红；去掉 `addLinks` 的 `assignIds: false` → 重复追加用例红。还原后全绿。
