# 退役协调者会话留在项目下，和 worker 同列

## 背景

「换新 leader」按设计把旧会话降级为项目里的普通会话，但 UI 上没有对应的呈现位：官方工作区树的排除集只含当前 leader 与 worker，而 `sessionsByProject` 只按「cwd 等于项目目录 + worker 身份」收会话。旧会话两头都不在，掉回官方工作区树当一条与项目无关的普通会话行，项目行展开后也看不到它——观感是「点了换新 leader，只是凭空多出一条普通会话」。

## 决策

- 项目记录新增 `retiredLeaderSessionIds: string[]`，换 leader 时把旧 id 追加进去，`sessionsByProject` 把它们并进该项目的会话列表。
- **按 id 收，不按目录收**：放宽目录判据会让用户在项目目录里手开的会话混进项目——那是用户自己的会话，不属于编排；退役 id 是本插件建过的会话，有明确身份。
- **与改绑同一次写入**：分开两次 `store.update` 时，中途失败会留下「leader 已换、旧会话谁都不认」的记录；合成一次更新后，退役列表与 `leaderSessionId` 要么一起生效要么都不生效。
- **会话已从会话库消失时不再列出**：目录判据天然会过滤掉不存在的会话，id 判据不会；留着会得到一条点不开的空行，还会让「该项目下还没有会话」的判断失灵。
- **client 侧不用改**：退役会话进了 `sessionsByProject` 就自动进排除集，也就自动从官方工作区树里藏掉——「项目下可见」与「工作区树不可见」是同一个集合的两面。

## 边界

- **只按 id 收的代价**：更早的、id 没被记下的旧 leader 会话仍留在官方工作区树里，不会被自动收进项目。
- **「项目下可见」不等于「有看板」**：看板通道拿同一张表判 worker 身份，退役会话因此拿到过本项目看板入口；client 侧已按 `retiredLeaderSessionIds` 再分一次身份，见[退役会话的边界](../architecture/2026-11-02-retired-session-boundaries.md)。
- **退役列表只在项目记录里**：不改变会话本身，`sessionsByProject` 是它影响到的唯一读取面。

## 验证

`tests/project-session-index.test.js` 钉住「旧会话与 worker 同列、当前 leader 不列、连续换只增不重、会话库消失不列」；`tests/projects-store.test.js` 钉住字段落盘与读回；双向：撤掉退役 id 并入列表或换 leader 时追加，对应用例变红。
