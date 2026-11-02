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
- **worker**：只有 `update_card`，且限自己挂着的卡（见下节）。它边干活边把状态与产物链接写回自己的卡；`create_card` 与 `list_cards` 都没有——建卡与派工是协调者的一条动作链，卡片的 revision 由卡片上下文注入（每轮求值），不需要列表。
- **普通会话**：三件都没有。`PLAIN_SESSION_DENY_TOOLS` = 派工与全库查询 + 卡片写入。

写名单与「只有协调者能用」是两条独立规则（`COORDINATOR_ONLY_TOOLS` 不含卡片写入）：worker 保留改卡、没有前者，把两者合成一份名单会让 worker 跟着失去写卡。worker 的禁用集因此是第三份清单（`WORKER_DENY_TOOLS` = 派工与全库查询 + `create_card`），不是前两份的简单组合。

**worker 不建卡的协议依据**：核过 `SLOTS.md` 的三个槽位（dev / review / discuss），没有任何建卡步骤；`COORDINATOR.md` 的「一个 worker 一张卡」与 `leader-mode` 的协调者动作表（`playbooks/program.md`）都把 `create_card` 归协调者；worker 侧唯一的写卡指示是 `playbooks/implementation.md` 的「用 `update_card` 的 `addLinks` 把交付物挂到卡片」。没有流程依赖 worker 建卡，因此禁掉，与普通会话同一口径。

### 工具面之外再判一次身份

工具面在 `agent/created` 一次性裁，而换协调者不重建旧会话：退役会话手里仍留着 `create_card` / `update_card`，直到下次冷恢复才按普通会话重裁。因此 `execute` 的第一句就是 `assertCardWriter`，退役者与普通会话同档、立即失去写卡。

- 工具工厂的 `canWrite` 缺省放行，只为「文档门禁取工具名」与单测构造；装配路径必须传，`createBundleTools` 会检查。
- 身份判定抽到 `tools/gate.js` 的 `canWriteCardsFor`，与派工同口径：先看 worker（内存集合，不依赖索引），再等一次 `awaitIndex()`，读不出来就拒绝。索引未就绪时 `isCoordinatorSession()` 对所有会话返回 true，写卡不能吃这个宽松——它会真实落盘并归属到项目，不是「多放一轮」。装配漏传判定时 `createBundleTools` 直接抛错（见边界最后一节）。
- 拒绝发生在入参校验之前，报错直接说清是身份问题，不让调用方以为改改参数就能过。

### 冷恢复先登记再 resume

查工具面资产时发现一个真实时序缺陷：`worker-sessions.js` 的 `send()` 先 `agents.resume()`、成功后才 `workerIds.add()`，而 `agent/created` 在 resume 内部就发出了。冷恢复的 worker 因此在判身份那一刻还不算 worker，被裁成普通会话。

改动前后果有限（少的是 worker 本来就不该有的编排工具）；收紧写卡之后，它会让冷恢复的 worker 丢掉 `update_card`，再也汇报不了自己的卡——正是 worker 保留写卡的目的。改为先登记、失败回滚，与 `spawn()` 既有的「先登记再创建」同一模式。

回滚只针对**这次新登记**的身份（`known` 为假才删）：已收编的 worker id 必须留着，`forget()` 的约定就是「会话 id 不复用，留着不会误判」。无条件删会让一次临时恢复失败抹掉合法 worker 的身份，它下次在 GUI 里被打开时（宿主自己的 resume 路径）会被裁成普通会话。

### worker 只改自己挂着的卡

身份闸回答「能不能写卡」，回答不了「写哪张、写什么」。worker 的 cwd 就是项目目录，同项目里别的 worker 的卡它一样能改；也能整卡替换 `slots`——后者正是投递门禁（`dispatch.js` 的 `assertCardGateOpen`）认定必须拦下的坏状态（一个会话同时挂多张 active 卡，产物无从归属）；还能把卡标 `done`，提前关掉自己的卡、释放执行者，绕过协调者的验收；也能改 `spec`，把验收锚点换成自己写的那份。`update_card` 因此加一道 `assertWorkerCardScope`：worker 的目标卡必须在 `bindingsOf(sessionId)` 里，且本次不能带 `slots`、`status` 或 `spec`。协调者不受限，换执行者、判定完成与维护规格都归它。

**状态与规格归协调者的依据**：`playbooks/implementation.md` 的交付一节写明「卡片规格与状态仍由协调者维护，不自行标 done」「开发完成不代整卡验收，不标整卡 done；有卡时回交协调者按验收判断」；`playbooks/program.md` 写「`status` 与 `spec` 仍归协调者」，并把卡片/spec 的用途定为「只保存稳定需求与当前调度摘要（阶段、审查 head、结论、下一步）」；`SLOTS.md` 的 dev 槽位写的是「交付做到 PR；合并与 approve 不由你决定」——worker 连合并都不能决定，判不了完成，也不该改目标、范围与验收。`#60` 的「关闭卡片自动释放执行者」同样按协调者的收工动作设计（关闭会抽走 worker 的卡片上下文，协议层要求关闭前确认该轮已交活）。因此收窄实现，而不是改协议。

范围校验放在跨项目校验之后、`store.update` 之前：跨项目先给出更准确的原因，范围闸只在同项目内兜「哪张卡、写什么」。

`create_card` 的 worker 限制另有一道 `assertCardCreator`，紧跟在身份闸之后：工具面已经把 `create_card` 从 worker 摘掉，但工具面是创建时一次性的，执行时再判一次才与其余写卡规则同构。

### 并发冷恢复共用一次 resume

`send()` 原本在 `live` 未命中时各自 `agents.resume()`：同一会话被并发唤醒会建出两个作用域，后一个经 `live.set` 覆盖前一个，被覆盖的那个再没有 dispose——泄漏一个 agent。改为按会话 id 收敛到一次恢复（`resumeOnce` 的 in-flight promise），两条消息投到同一个 handle；恢复失败时两条调用各自拿到原错误，身份回滚仍只发生一次。

## 边界

- **普通会话读写都没有**：`list_cards` 早就在 `COORDINATOR_ONLY_TOOLS` 里；本次把写也收掉，两侧规则一致。
- **退役协调者立刻失去写卡**：调用时判身份，与 `spawn_worker` / `message_worker` / 跨项目 `list_cards` 同口径；工具面要到下次冷恢复才收走，两者并存不冲突。
- **启动瞬间的旧 worker 仍可能误判**：`workerSessions.adopt()` 在装配时异步读登记表，窗口内冷恢复的老 worker 会被判成普通会话（既有窗口）。本次未消除它，只是让 `send()` 这条主动恢复路径先登记。
- **索引未就绪时同样拒绝写卡**：`isCoordinatorSession()` 在索引读不出来时对所有会话返回 true（`projects/service.js:354-357`），写卡闸等一次 `awaitIndex()`，问不出身份就不写。协调者在同一状态下也会被拒，与派工/续聊的 `assertCoordinator` 一致——宁可让协调者晚一轮再建卡，也不给普通会话一个真实落盘的越权窗口。索引失败后 `index.js` 重试 3 次（2s/4s），之后保持拒绝。项目存储本身对损坏文件做恢复（重写空表），所以索引失败实际只剩 IO 与装配异常这两条路径。
- **装配漏传判定直接失败**：`createBundleTools` 在 `cards` 有值而 `canWriteCards`、`isWorkerSession`、`cardBindingsOf` 有任一不是函数时抛错。缺省放行只剩「文档门禁无参取名字」与「单测直接调工具工厂」两个合法场景，这两条都不需要「有 cards 但没判定」这个组合。旧版本下漏传是静默失效：工具面照裁、执行时却对所有会话开放，全量用例不会红。
- **worker 建卡两面都关**：工具面（`WORKER_DENY_TOOLS` 的 `create_card`）与执行时（`assertCardCreator`）。执行时那道是决定性的——工具面在 `agent/created` 一次性裁，与其余写卡规则保持同一结构。
- **worker 不能改状态与规格**：`done` / `archived`、重开与 `spec` 都归协调者（依据见上一节）。worker 在交付完成后只在 `links` 里挂产物、在回报里写进展，卡片的完成由协调者按验收判断（本仓是 PR 合并 + worktree 移除）。
- **worker 仍能改标题与卡内容之外的事实**：本次只收 `slots` / `status` / `spec` 三项；`title` 与 `links` 留给 worker（协议层只点名了前两项的归属，且标题不构成验收锚点）。
- **产品行为变更**：在普通会话里对模型说「把这个记成卡」不再能落盘，需要切到项目协调者会话。这是有意的取舍——普通会话没有项目归属，卡落盘后看板上没人认领。
- **文档门禁仍认三件**：`documentedToolNames()` 从 `createBundleTools()` 取名字，工具名没有变化，`scripts/verify-doc-tool-names.mjs` 的允许集不用改。

## 验证

- 单测：合 main（`98891c8`）后全量 `npm run check` 821 例（812 pass / 9 skip / 0 fail）。
- 本轮新增用例：
  - `tool-gate`：普通会话禁掉三组工具、worker 只禁建卡而保留改卡、`applyToolGate` 对普通会话留下完整限制、名单互不重叠；`canWriteCardsFor` 的三态——worker 短路不碰索引、索引未就绪拒绝（不吃 `isCoordinatorSession()` 的宽松）、就绪后只认当前协调者；
  - `cards-tools`：普通会话建卡与改卡都被拒且不落盘、协调者与 worker 放行、身份闸先于入参校验、`createBundleTools` 把判定透传给两件工具、传了 `cards` 不传判定时抛错、worker 只能改自己挂着的卡、不能改 `slots` / `status` / `spec`（协调者不受限）、worker 建卡被拒且不落盘；
  - `coordinator-wiring`（装配层，跑真实 `apply`）：普通会话写卡被拒且协调者能建卡、真实 `replaceCoordinator` 之后退役会话的 `create_card` / `update_card` 都被拒而新协调者通过；
  - `worker-sessions`：resume 期间已登记为 worker、resume 失败只回滚这次新登记的身份（已收编的 worker 保留、未登记 id 清掉）、同一会话并发续聊只恢复一次（两个 handle 泄漏成唯一一个、两条消息投同一 handle）、并发恢复失败时两条调用都拿到同一个错误、恢复完成后清掉在飞记录（`forget()` 之后再 `send` 会重新恢复）。
- 双向验证（逐条撤销 → 对应用例变红 → 还原 → 全绿）：
  1. `deniedToolsFor` 普通会话分支改回 `COORDINATOR_ONLY_TOOLS` → `tool-gate` 3 例变红（普通会话没有派工/全库查询与卡片写入、缺 worker 判定按普通会话、applyToolGate 留下限制）。
  2. 删掉两处 `assertCardWriter` 调用 → `cards-tools` 3 例变红（建卡与改卡被拒且不落盘、协调者与 worker 放行、身份闸先于入参校验）。
  3. `createBundleTools` 去掉 `create_card` 的 `canWrite` 透传 → 「createBundleTools 把写卡身份判定透传给卡片工具」变红。
  4. `send()` 改回「先 resume 后登记」→ 「冷恢复前先登记 worker 身份」变红。
  5. 把失败回滚改成无条件 `workerIds.delete` → 「冷恢复失败只回滚这次新登记的身份」变红（已收编 id 也变 false）；改成完全不回滚，同用例也变红（未登记 id 留着身份）；还原后绿。
  6. 删掉 `index.js` 装配处的 `canWriteCards` 实参 → 4 条装配层用例变红（`createBundleTools` 当场拒绝启动），还原后全绿。
  7. `canWriteCardsFor` 去掉 `awaitIndex()` 判断（回到 fail-open）→ 「索引未就绪时拒绝」变红，还原后绿。
  8. 写卡判定改成恒放行 → 装配层两条用例变红（普通会话、退役协调者都能写卡），还原后绿。
  9. 删掉 `update_card` 的 `assertWorkerCardScope` 调用 → 「worker 只能改自己挂着的卡」变红，还原后绿。
  10. 删掉 `index.js` 装配处的 `isWorkerSession` / `cardBindingsOf` 实参 → 4 条装配层用例变红（`createBundleTools` 拒绝启动），还原后绿。
  11. `send()` 改回「每条各自 resume」→ 两条并发用例与身份回滚用例变红（resume 调了 2 次），还原后绿。
  12. 删掉 `create_card` 的 `assertCardCreator` 调用 → 「worker 不能建卡」变红；`deniedToolsFor` 的 worker 分支改回 `COORDINATOR_ONLY_TOOLS` → `tool-gate` 2 例变红；均还原后绿。
  13. 删掉 `assertWorkerCardScope` 的 `status` 检查 → worker 改状态的三条断言变红；删掉 `resuming.delete` → 「恢复完成后清掉在飞记录」变红（第二次 `send` 命中旧 promise、`resume` 只调了 1 次）；均还原后绿。
  14. 删掉 `assertWorkerCardScope` 的 `spec` 检查 → 「worker 不能改卡片规格」变红，还原后绿。
- 未做真机取证：工具面变化需要在隔离 `DSH_HOME` + mock provider 的实例里看普通会话的工具列表，本次只验证了判定与执行闸；留待下一次 GUI 取证。
