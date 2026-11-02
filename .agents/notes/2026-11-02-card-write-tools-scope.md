# 卡片写入只给协调者与 worker

**状态**：implemented（2026-11-02）
**范围**：`src/host/tools/{gate,cards}.js`、`src/host/{index,worker-sessions}.js`、`docs/architecture.md`、`docs/usage.md`、`README.md`、`.agents/skills/leader-mode/SKILL.md`、`tests/`

## 背景

用户在一次普通会话里看到 `update_card` 出现在工具列表里，问「普通会话为什么也能写卡」。查下来这不是漏网，是 2026-10-27 的显式决策：`create_card` / `update_card` 对所有会话开放，理由是「普通会话也能为项目登记待办」。

那条理由站不住：卡片是项目里的任务事实，普通会话不在任何项目编排里。它建出来的卡没有槽位、没有协调者认领，只会污染看板；它也不该改别人项目的卡。看板本来就已经拒绝普通会话查看（看板只对协调者与该项目的 worker 展示），写却一直开着——读写两侧的规则不一致。

## 决策

### 卡片写入按角色分配

`CARD_WRITE_TOOLS` = `create_card` / `update_card`，从「对所有会话开放」改成「协调者与 worker 才有」：

- **协调者**：建卡、改卡、查卡，保持原样。
- **worker**：保留两件。它边干活边把状态与产物链接写回自己的卡；`list_cards` 仍然没有——卡片的 revision 由卡片上下文注入（每轮求值），不需要列表。
- **普通会话**：三件都没有。`PLAIN_SESSION_DENY_TOOLS` = 派工与全库查询 + 卡片写入。

写名单与「只有协调者能用」是两条独立规则（`COORDINATOR_ONLY_TOOLS` 不含卡片写入）：worker 保留前者、没有后者，把两者合成一份名单会让 worker 跟着失去写卡。

### 工具面之外再判一次身份

工具面在 `agent/created` 一次性裁，而换协调者不重建旧会话：退役会话手里仍留着 `create_card` / `update_card`，直到下次冷恢复才按普通会话重裁。因此 `execute` 的第一句就是 `assertCardWriter`，退役者与普通会话同档、立即失去写卡。

- 判定由 `index.js` 组装：`isCoordinatorSession` 或 `isWorkerSession`。工具工厂的 `canWrite` 缺省放行，只为「文档门禁取工具名」与单测构造；装配路径必须传。
- 索引未就绪时 `isCoordinatorSession()` 保守放行，闸随之放行：这时问不出谁是协调者，宁可多放一轮也不让协调者的建卡失败。
- 拒绝发生在入参校验之前，报错直接说清是身份问题，不让调用方以为改改参数就能过。

### 冷恢复先登记再 resume

查工具面资产时发现一个真实时序缺陷：`worker-sessions.js` 的 `send()` 先 `agents.resume()`、成功后才 `workerIds.add()`，而 `agent/created` 在 resume 内部就发出了。冷恢复的 worker 因此在判身份那一刻还不算 worker，被裁成普通会话。

改动前后果有限（少的是 worker 本来就不该有的编排工具）；收紧写卡之后，它会让冷恢复的 worker 丢掉 `update_card`，再也汇报不了自己的卡——正是 worker 保留写卡的目的。改为先登记、失败回滚，与 `spawn()` 既有的「先登记再创建」同一模式。

回滚只针对**这次新登记**的身份（`known` 为假才删）：已收编的 worker id 必须留着，`forget()` 的约定就是「会话 id 不复用，留着不会误判」。无条件删会让一次临时恢复失败抹掉合法 worker 的身份，它下次在 GUI 里被打开时（宿主自己的 resume 路径）会被裁成普通会话。

## 边界

- **普通会话读写都没有**：`list_cards` 早就在 `COORDINATOR_ONLY_TOOLS` 里；本次把写也收掉，两侧规则一致。
- **退役协调者立刻失去写卡**：调用时判身份，与 `spawn_worker` / `message_worker` / 跨项目 `list_cards` 同口径；工具面要到下次冷恢复才收走，两者并存不冲突。
- **启动瞬间的旧 worker 仍可能误判**：`workerSessions.adopt()` 在装配时异步读登记表，窗口内冷恢复的老 worker 会被判成普通会话（既有窗口）。本次未消除它，只是让 `send()` 这条主动恢复路径先登记。
- **索引未就绪时的放行窗口**：`isCoordinatorSession()` 在索引读不出来时对所有会话返回 true（`projects/service.js:354-357`），窗口内普通会话仍能建卡落盘。卡片写入没有像派工那样加 `awaitIndex()` 兜底，索引永久损坏（重试 3 次后停止）时会一直宽松。这是有意的方向：这时问不出谁是协调者，拒绝写卡会让项目整体瘫痪，而放行的代价只是一张可能没人认领的卡。
- **产品行为变更**：在普通会话里对模型说「把这个记成卡」不再能落盘，需要切到项目协调者会话。这是有意的取舍——普通会话没有项目归属，卡落盘后看板上没人认领。
- **文档门禁仍认三件**：`documentedToolNames()` 从 `createBundleTools()` 取名字，工具名没有变化，`scripts/verify-doc-tool-names.mjs` 的允许集不用改。

## 验证

- 单测：`tests/tool-gate.test.js` / `tests/cards-tools.test.js` / `tests/worker-sessions.test.js` 共 86 例全绿；全量 `npm run check` 见 PR。
- 本轮新增用例：
  - `tool-gate`：普通会话禁掉三组工具、`applyToolGate` 对普通会话留下完整限制、三组名单互不重叠；
  - `cards-tools`：普通会话建卡与改卡都被拒且不落盘、协调者与 worker 放行、身份闸先于入参校验、`createBundleTools` 把判定透传给两件工具；
  - `worker-sessions`：resume 期间已登记为 worker、resume 失败只回滚这次新登记的身份（已收编的 worker 保留、未登记 id 清掉）。
- 双向验证（逐条撤销 → 对应用例变红 → 还原 → 全绿）：
  1. `deniedToolsFor` 普通会话分支改回 `COORDINATOR_ONLY_TOOLS` → `tool-gate` 3 例变红（普通会话没有派工/全库查询与卡片写入、缺 worker 判定按普通会话、applyToolGate 留下限制）。
  2. 删掉两处 `assertCardWriter` 调用 → `cards-tools` 3 例变红（建卡与改卡被拒且不落盘、协调者与 worker 放行、身份闸先于入参校验）。
  3. `createBundleTools` 去掉 `create_card` 的 `canWrite` 透传 → 「createBundleTools 把写卡身份判定透传给卡片工具」变红。
  4. `send()` 改回「先 resume 后登记」→ 「冷恢复前先登记 worker 身份」变红。
  5. 把失败回滚改成无条件 `workerIds.delete` → 「冷恢复失败只回滚这次新登记的身份」变红（已收编 id 也变 false）；改成完全不回滚，同用例也变红（未登记 id 留着身份）；还原后绿。
- 未做真机取证：工具面变化需要在隔离 `DSH_HOME` + mock provider 的实例里看普通会话的工具列表，本次只验证了判定与执行闸；留待下一次 GUI 取证。
