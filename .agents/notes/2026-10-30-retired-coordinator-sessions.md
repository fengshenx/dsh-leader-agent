# 退役协调者会话留在项目下，和 worker 同列

## 问题

「换新协调者」按设计把旧会话降级为项目里的普通会话（`service.replaceCoordinator` 的原注释），
但 UI 上没有对应的呈现位：官方工作区树的排除集只含**当前**协调者 id 与 worker 会话
（`src/client/project-panel-logic.js` 的 `collectExcludedSessionIds`），而 `sessionsByProject`
只按「cwd 等于项目目录 + worker 身份」收会话（`src/host/projects/session-index.js`）。
旧会话两头都不在，于是掉回官方工作区树，作为一条跟项目无关的普通会话行留在工作区分组下；
项目行展开后也看不到它。用户看到的观感是「点了换新协调者，只是凭空多出一条普通会话」。

## 决策

项目记录新增 `retiredCoordinatorSessionIds: string[]`，换协调者时把旧 id 追加进去，
`sessionsByProject` 把它们并进该项目的会话列表。

三条边界：

- **按 id 收，不按目录收**。放宽目录判据会让用户在项目目录里手开的会话也混进项目——
  那是用户自己的会话，不属于编排（`session-index.js` 头注释即此意）。退役 id 是
  本插件建过的会话，有明确身份。
- **与改绑同一次写入**。分开两次 `store.update` 时，中途失败会留下「协调者已换、
  旧会话谁都不认」的记录；合成一次更新后，`retiredCoordinatorSessionIds` 与
  `coordinatorSessionId` 要么一起生效要么都不生效。
- **会话已从会话库消失时不再列出**。目录判据天然过滤掉不存在的会话，id 判据不会：
  留着会得到一条点不开的空行，还会让「该项目下还没有会话」的判断失灵。

client 侧不用改：退役会话进了 `sessionsByProject` 就自动进排除集，也就自动从官方
工作区树里藏掉——「项目下可见」与「工作区树不可见」是同一个集合的两面。

**补正（2026-11-02）**：这句只对工作区树成立。看板那条通道拿同一张表判 worker 身份，
退役会话因此拿到本项目看板入口；client 侧已改为按 `retiredCoordinatorSessionIds`
再分一次身份，见 [2026-11-02-retired-session-boundaries.md](2026-11-02-retired-session-boundaries.md)。

## 测试

- `tests/project-session-index.test.js`：换下后旧会话与 worker 同列、当前协调者不列；
  连续换两次只增不重；退役会话不在会话库时不列。
- `tests/projects-store.test.js`：新字段可写、重开实例可从盘读回。

双向验证：分别撤掉「退役 id 并入列表」与「换协调者时追加退役 id」，对应用例各变红
（1 例 / 2 例），还原后全绿。
