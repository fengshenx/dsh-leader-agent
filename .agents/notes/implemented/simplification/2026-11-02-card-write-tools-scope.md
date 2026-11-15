# Agent Note: 卡片写入只给协调者与 worker

Status: implemented

## Problem

`create_card` / `update_card` 曾以「普通会话也能为项目登记待办」为由对所有会话开放。卡片是项目里的任务事实，普通会话不在任何项目编排里：它建的卡没有槽位、没人认领，只会污染看板；而看板本来就不给普通会话看——读写两侧的规则不一致。

## Decision

- **按角色分配**：协调者建卡、改卡、查卡；worker 只有 `update_card`，且限自己挂着的卡，`create_card` 与 `list_cards` 都没有——建卡与派工是协调者的一条动作链，卡片 revision 由卡片上下文每轮注入；普通会话三件全无（派工与全库查询 + 卡片写入）。
- **三份名单不合并**：`CARD_WRITE_TOOLS`、`COORDINATOR_ONLY_TOOLS`、`WORKER_DENY_TOOLS`（派工与全库查询 + `create_card`）。写名单与「只有协调者能用」是两条独立规则，合成一份会让 worker 跟着失去写卡。worker 不建卡有协议依据：`SLOTS.md` 三个槽位没有建卡步骤，`LEADER.md` 与 `leader-mode` 的协调者动作表都把建卡归协调者，worker 侧只用 `update_card` 挂交付物。
- **工具面之外，执行时再判一次身份**：工具面在 `agent/created` 一次性裁，而换协调者不重建旧会话，退役者手里仍留着写卡工具，直到下次冷恢复才重裁；所以 `execute` 第一句是 `assertCardWriter`。身份判定 `canWriteCardsFor` 先看 worker 内存集合，再等一次 `awaitIndex()`，读不出来就拒绝——索引未就绪时 `isCoordinatorSession()` 对所有人返回 true，写卡不能吃这个宽松（它会真实落盘）。拒绝先于入参校验，报错直说身份问题；装配漏传判定时 `createBundleTools` 直接抛错，不静默放行。
- **worker 只改自己挂着的卡**：`assertWorkerCardScope` 要求目标卡在 `bindingsOf(sessionId)` 里，且本次不能带 `slots` / `status` / `spec` / `title`——`slots` 决定谁在执行（改它是投递门禁要拦的坏状态），`status` 与 `spec` / `title` 是验收锚点与注入内容，都归协调者。范围校验放在跨项目校验之后、`store.update` 之前；`create_card` 另有 `assertCardCreator` 紧跟身份闸。
- **冷恢复先登记再 resume**：`send()` 原本先 `agents.resume()`、成功后才登记，而 `agent/created` 在 resume 内部发出，冷恢复的 worker 在判身份那刻还不算 worker，会丢掉 `update_card`。改为先登记、失败回滚，且只回滚这次新登记的 id（已收编的保留）；并发唤醒按会话 id 收敛到一次恢复（in-flight promise），避免两个作用域、一个泄漏。

## Alternatives considered

- **继续对所有会话开放建卡 / 改卡**：普通会话建的卡没有槽位、没人认领，只会污染看板；按角色分工具面。
- **把 `CARD_WRITE_TOOLS` / `COORDINATOR_ONLY_TOOLS` / `WORKER_DENY_TOOLS` 合成一份**：合成会让 worker 跟着失去写卡；三条规则独立维护。
- **只在 `agent/created` 裁工具面**：换协调者不重建旧会话，退役者仍留着写卡工具；执行时再 `assertCardWriter` 判一次。
- **让 worker 改 `title` / `spec` / `status` / `slots`**：这些是验收锚点、注入内容与执行者绑定，归协调者；worker 只能改挂着的卡的非规格字段。
- **冷恢复先 `resume` 再登记**：`agent/created` 在 resume 内部发出，判身份时还不算 worker；先登记、失败回滚。

## Consequences

- 普通会话读写都没有；退役协调者调用时即失去写卡，工具面要到下次冷恢复才收走。
- 启动瞬间的旧 worker 仍可能误判：`adopt()` 异步读登记表，窗口内冷恢复的老 worker 被判成普通会话（既有窗口，未消除）。
- 索引未就绪时协调者也拒写：宁可晚一轮，也不给普通会话真实落盘的越权窗口。
- worker 能写 `links` / `addLinks` 与其余非规格字段（如 `sortOrder`）；`title` / `spec` / `status` / `slots` 全归协调者。
- 产品行为变更：普通会话里「把这个记成卡」不再落盘，需要切到项目协调者。
- 文档门禁仍认三件：工具名未变。
- 本轮未做真机取证：工具面变化留待隔离 `DSH_HOME` + mock provider 的实例里看普通会话的工具列表。

收益：建卡与全库查询只留在协调者，worker 只能改自己挂着的卡，退役会话也不会靠旧工具面继续写卡。

## Testing

`tests/tool-gate.test.js`、`tests/cards-tools.test.js`、`tests/leader-wiring.test.js`、`tests/worker-sessions.test.js`；双向读数：删掉两处 `assertCardWriter` 调用 → 建卡与改卡被拒的用例红，还原后全绿。
