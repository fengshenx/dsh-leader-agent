# 派工两段化与卡片上下文

**范围**：`src/host/{dispatch,worker-sessions,index}.js`、`src/host/tools/{spawn-worker,cards}.js`、`src/host/cards/{store,card-context}.js`、`.agents/skills/leader-mode/`、`docs/architecture.md`、`tests/`

## 背景

用户提出三件事：worker 建出来后不要立刻开工，等协调者发消息；那条消息要带卡片信息；worker 有产出（如 PR）时能自己挂到卡片链接上。

现状的三个缺口：

- `spawn_worker` 建完会话立即 `followup(initialMessage)`（`worker-sessions.js`），而槽位绑定要等协调者拿到 `childId` 再 `update_card` 写入。worker 首轮请求组装时索引里还没有它，角色槽位正文要到下一次模型请求才出现；协议层把这当成已知限制，要求首轮简报点名方法入口（`program.md` 当时的写法）。
- 卡片事实没有任何注入路径：worker 的工具面被裁掉 `list_cards`，也没有按绑定渲染 spec 的 provider。协调者只能把 spec 抄进任务消息。
- `update_card` 的 `links` 是整体替换，worker 想挂 PR 就得先读整卡；而它读不到卡（`list_cards` 被禁），冲突时只能盲改或报错。

同一轮追加两条：派 worker 之前要检查它挂没挂卡（挂卡不能派新活），以及关闭卡片要自动释放卡上的 worker。

## 决策

### 派工两段化：`spawn_worker` 只建会话，`message_worker` 才开工

`spawn_worker({ name, cardId?, slot?, force? })` 建会话、登记、可选绑卡后立即返回，不产生模型调用；任务正文由 `message_worker` 的第一条消息投递。

- **为什么不在 `spawn` 内部先绑卡再 `followup`**：那样首轮能带角色与卡片，但派工语义仍是一次调用完成「建人」与「派活」两件事。用户要的是显式分工：绑定与任务都落定之后才开工，重启/复用同一条投递路径。
- **绑卡在返回前完成**：会话 id 是预生成的，绑定写入成功后才返回 `childId`；协调者随后的第一条消息请求组装时，`slotIndex` 与 `cardIndex` 都已就绪。
- **绑定失败即回滚**：`bindSlot` 抛错时销毁刚建的会话，不写登记表——留一个没挂卡的会话，协调者会以为指派好了。
- **呈现推后到绑定成功之后**：改名（`renameTitle`）与挂工作区原本在建会话时立即做，而改名会追加 `session/title` 事件、让零 turn 会话在磁盘上 materialize。绑定失败时活会话可以 dispose，宿主的 `SessionPersistence` 却没有 delete，jsonl 会留成孤儿；把呈现推到绑定成功之后再执行，失败回滚时磁盘上就没有任何会话。派工因此用 `spawn({ deferPresentation: true })` + `present()` 两段。
- **派工不建在飞记录**：没有消息就没有 turn，先挂一条在飞记录会让结算等一个永远不来的 `turn/end`。在飞记录由 `message` 首次投递建立。
- **本进程归属兜底**（`owners`）：`message` 的归属校验原本只读落盘登记表，登记失败时同一轮里连自己刚建的 worker 都投不进。内存归属只补本进程窗口，登记表仍是跨进程真源；换协调者时 `owners` 与在飞记录一起改投。

### 绑卡前校验项目归属与卡状态

`spawn_worker` 的 `cardId` 路径在**建会话之前**做两道校验，与 `update_card` 同口径：

- **项目归属**：卡有 `projectId` 时，调用方协调者所属项目必须与它一致；无归属的存量卡不拦。原先 `bindSlot` 只看「卡在不在、是否归档」，A 项目的协调者拿 `list_cards(scope:'all')` 读到的 B 项目 cardId 能直接写 B 的 `slots`/`revision`（作废 B 侧持有的 `expectedRevision`），A 派出的 worker 还会每轮带着 B 的 spec 全文。
- **卡状态**：`done` 与 `archived` 都拒绝。关闭即释放执行者，把 done 卡绑到新会话会让投递门禁（按 `active` 过滤）看不见这条绑定，而 `cardIndex` 照旧注入卡片事实。
- 拒绝是抛错，不静默跳过：调用方拿不到成功回执，`spawn_worker` 也不会留下一条没挂卡的会话。
- `card-context` 按**会话 id** 取绑定，绑定写不进去就不会给这个 worker 注入那张卡；跨项目注入的入口是绑定本身，堵在写入侧。存量已绑错的数据不自动迁移。

### 写 `slots` 的两条路径都拒绝非 `active` 卡

`bindSlot` 与 `update({ slots })` 共用同一道状态闸：`done` 拒绝，`archived` 拒绝（终态）。`update` 同次把状态改回 `active` 是显式重新指派，放行——这样「重开再绑」仍然是一次调用能完成的事。

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
- `addLinks` 与整体替换共用同一份链接校验与归一化（`normalizeHttpUrl`，按 WHATWG URL 落盘规范形式），只由 `assignIds` 区分是否补 id：增量路径不补 id，store 才能按 `label + url` 去重；非法 URL 在两条路径上报同样的「第几条、哪个标签」错误。

### 挂卡门禁：挂着未完成卡的 worker 不接新活

投递门禁（`assertCardGateOpen`）只放行同卡续跑：worker 挂着 `status === 'active'` 的卡时，`message_worker` 带别的 `cardId`（或干脆不带）都会被拒。名册到顶时 `describeRoster` 把这类 worker 从 `idle` 里摘出来放进 `bound`，`spawn_worker` 的上限报错分两段列出——可复用的候选，与「挂着未完成卡、先关闭再复用」的清单（带卡号、卡名、槽位）。

- 挂卡的 worker 已经有活，再派一条会让一个会话同时服务两张卡，产物落错卡。
- 候选清单必须过滤：把挂着卡的 worker 推荐成「可复用」，协调者投递就会被门禁拒，提示与实际能力自相矛盾。
- `describeRoster` 用一次读盘（`cardBindingsBySession`）取全量绑定再分组，不逐 worker 读 `cards.json`。逐 worker 读是 O(N × 文件体积)：审查实测 20 个 worker 时一次派工 20 次 `readFile`、约 8.9× 文件放大、2ms；卡片库随 spec 全文增长后比例还会变大。不查同步 `cardIndex` 的原因不变：启动时索引可能未就绪，查不到绑定会让门禁 fail-open 把挂卡 worker 当空闲。
- **同时挂多张 `active` 卡直接拒绝**，与声明哪张卡无关：那种会话在并行服务多条工作线，产物无从归属；角色注入本来就只按一张卡算（`slotIndex` 后绑胜出），上下文与实际服务对象已经不一致。这种状态只有整卡替换 `slots` 才造得出来，正常派工与关卡释放都不会。修法是拿着被拒提示先关掉多余的卡。

### 关闭卡片自动释放执行者

卡片状态变为 `done` 或 `archived` 时，`cards.store.update` 把 `slots` 一并清空；`update_card` 拒绝「关闭卡片 + 同次绑定槽位」的组合。

- 关闭即收工：绑定、槽位索引、卡片事实一起失效，worker 不再带旧卡上下文，也能接新任务。这比让协调者手工清 `slots` 可靠——漏一次就留下一个永远挂卡的 worker。
- 只在 `slots` 非空时才写 `{}`：本就没有 `slots` 字段的卡加上空对象会让 `isSameContent` 判为变化，无谓 bump 作废别人持有的 `expectedRevision`。
- 重新打开不恢复绑定：那是新的指派，静默恢复会让一张卡突然多出一个没人通知的执行者。
- 工具层拒绝而不是静默忽略同次传的 `slots`：调用方会以为绑定生效，实际刚被释放。

### 槽位被占时拒绝，不静默顶替

`bindSlot` 在目标槽位已绑**别的**会话时抛错，提示先用 `update_card` 显式改派。静默顶替会让在跑的 worker 失去角色注入而不自知。

## 边界

- **空会话窗口**：建了 worker 但没投递时，它是一条空闲会话，占项目树一行与名册名额。协议要求同一轮投递；本方案不做超时回收。
- **绑定失败不留盘靠的是「不 materialize」**：宿主没有删除会话文件的能力（`SessionPersistence` 无 delete，`close()` 只排空与释放租约），所以回滚不能删 jsonl。本方案把改名这个 materialize 步骤推后，绑定失败时磁盘上还没有文件；如果将来建会话本身就开始落事件，这条保证会失效。
- **空会话冷恢复未取证，且依赖改名这个间接保证**：两段化后「建了 worker 没投递 → 重启 → `message_worker`」要求 `agents.resume` 能恢复一条**零 turn** 的会话。宿主 `flush()` 才会 materialize 空会话、`close()` 不会，未 materialize 的会话「leaves nothing behind」；当前能成立靠的是派工成功时的 `renameTitle` 追加了 `session/title`。装配里缺 `sessionTitle`（`worker-sessions.js` 已有降级日志）或将来去掉改名，这条链路就断，重启后 `message_worker` 会冷恢复失败、而卡还绑在会话上。更稳的做法是用宿主允许的插件记录显式落一条事件，但 rc.2 是否提供、需要按 `engines.dsh` 下限核对——本 PR 不做，记为已知边界。
- **GUI 与首轮上下文仍未真机取证**：本次只在隔离 home + 假件上验证了「绑定失败无 jsonl」；「首个模型请求同时含角色槽位与卡片事实」「worker `addLinks` 后看板 2 秒内出现链接」「空会话冷恢复」都需要隔离 `DSH_HOME` + mock/keyless provider 的 GUI 实例，未做。
- **卡片上下文的体积**：spec 全文在首次注入与每次变更时进入上下文；按现有 spec 纪律（稳定需求，不追加历史）约束，不做截断（截断会让 worker 按残缺规格开工）。
- **不是每轮注入**：卡片没变的轮次不产生新消息；旧快照仍留在历史里，模型按最新的读。
- **注入不授予权限**：卡片事实与槽位一致，只贡献文本，工具面仍由 `tools/gate.js` 裁剪。
- **`spawn_worker` 不兼容旧参数**：仍传 `initialMessage` 会明确报错，不静默忽略（本仓未发布，不留垫片）。
- **工具名不变**：`spawn_worker` / `message_worker` / `update_card` 的名字与文档门禁比对集合不变。
- **关闭卡片会抽走在跑 worker 的上下文**：协调者在 worker 仍在跑时把卡标 `done`，worker 下一轮请求就不再带卡片事实与角色槽位。这是「关闭即收工」的预期代价，协议层要求关闭前确认该轮已交活。
- **关闭释放不区分谁在跑**：store 层看不到会话运行状态，关掉就清绑定；需要保留绑定时不要关，改成改派。

## 验证

- 单测：**757 例全绿**（`npm test`）。rebase 到 main 后基数变了：PR 正文原写 667、审查实测 668，都是切分支时的旧基数；main 之后合入的 PR 又带来一批用例。当前 `main@732202b` 是 715 例，本 head 相对它新增 42 例（原分支 29 + 审查修复 11 + 与 #53 合并时补的 2）。
- 本 PR 覆盖：`card-context.test.js` 8 例（provider 属性、空绑定、规格/链接渲染、多卡提示、归档标注、渲染异常）；`cards-store.test.js` 的 `addLinks` 合并/同 id 更新/去重/互斥/无变化不 bump、`bindSlot` 绑定与拒绝顶替、`cardIndex` 随建卡改卡摘绑同步、关闭释放与重新打开，本轮另加 4 例（`bindingsBySession` 分组与逐个反查同口径、`bindSlot` 拒绝 done、拒绝 archived、整卡替换 `slots` 拒绝 done 且允许同次重开）；`cards-tools.test.js` 的 `addLinks` 追加、互斥、缺标签、schema 暴露，以及与 #53 合并后补的 2 例（`addLinks` 也走 URL 归一化且不补 id、非法 URL 与整体替换同口径拒绝）；`dispatch.test.js` 的带卡派工绑定先于开工、槽位被占回滚且不登记、装配缺 `bindCardSlot` 明确报错、名册到顶不推荐挂卡 worker、关闭卡后 worker 被释放，本轮另加 6 例（跨项目绑卡拒绝且不建会话、同项目放行、done/archived 绑卡拒绝且不建会话、绑定失败不做呈现、owners 与在飞记录一起改投、名册一次读盘）；`worker-sessions.test.js` 改为断言建会话不投递，另加 `deferPresentation`/`present` 1 例。
- 双向验证（本轮）：
  1. 去掉 `dispatch` 的 `assertCardAssignable` → 「spawn_worker 拒绝把别的项目的卡…」变红；还原后绿。
  2. 把 `assertActiveForBinding` 改成直接 return → 「bindSlot 拒绝已关闭」「bindSlot 拒绝已归档」「整卡替换 slots…」三条变红；还原后绿。
  3. 把派工的 `deferPresentation: true` 改回 `false` → 「绑定失败回滚时不做呈现」变红；还原后绿。
  4. 去掉 `reassignParent` 的 owners 改投 → 「owners 与在飞记录一起改投」变红；只去掉 inflight 改投，同用例也变红（`handedOver` 为 0）；还原后绿。
  5. 让 `describeRoster` 不走 `cardBindingsBySession` → 「名册一次读盘…」变红（bulk 0 / per-worker 2）；还原后绿。
  6. 把 `addLinks` 的 `{ assignIds: false }` 去掉 → 「重复 addLinks」「addLinks 与整体替换共用 URL 归一化」变红；把 URL 归一化改成原样落盘 → 后者变红；还原后绿。
- 绑定失败无 jsonl 探针（临时 home，`DSH_HOME` 指同一目录；会话存储按宿主 jsonl 语义建模：`create` 只留未 materialize 句柄、`append` 才落盘、`dispose` 不删文件）：
  - 绑卡成功 → `sessions/` 下 1 个 jsonl；
  - 绑卡失败（槽位已占）→ 新增 0 个 jsonl；
  - 修复前的等价路径（`spawn` 默认立即改名）→ jsonl 已生成，`dispose` 后仍在（`legacyFileSurvivesDispose: true`），正是要避免的孤儿。
- 未做真机取证：需要隔离 `DSH_HOME` + mock/keyless provider 验证「首轮请求同时含角色槽位与卡片事实」「worker `addLinks` 后看板 2 秒内出现链接」以及空会话冷恢复，留待下一次 GUI 取证。这三项在审查里仍是待确认项，本 PR 不声称已验证。
