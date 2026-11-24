# Agent Note: 重启不再清空卡片槽位绑定

Status: implemented

## Problem

宿主销毁活 agent 时会发 `agent/disposed`，插件在那里调 `cards.detachSession` 摘卡，避免把已删会话留在槽位里。但「agent 被销毁」不等于「会话被删除」：宿主重启（升级、`npm run dev` 重启）会逐个销毁活 agent，而会话记录仍在。原有的 `disposed` 短路只覆盖插件卸载，覆盖不了「宿主先销毁 agent、后卸载插件」的顺序，重启于是把所有活 worker 的槽位绑定清掉。

实测：重启前卡片上还有 `review` / `dev` 两个槽位，重启窗口里卡片被写了两次、`slots` 变成 `{}`，revision 的增量正好等于销毁的活 worker 数；随后新进程才写 `board-default.json`。看板模式那次合并需要重启宿主才生效，用户在那次重启里丢了绑定。这不是该合并引入的逻辑，是重启路径上的存量缺陷——`detachSession` 在 `agent/disposed` 上无条件执行。

## Decision

- `agent/disposed` 里先查会话记录是否还在（`sessionExistsWithCtx`），只有返回 `false`（记录确实删了）才 `detachSession`；`true`（重启窗口，记录还在）跳过；`undefined`（会话库缺失）也跳过——宁可留死引用，也不在重启时误删。
- 判断本身抛错只记日志并保留槽位；摘卡失败沿用原来的告警。
- `disposed` 短路保留：插件卸载时 `workerSessions.disposeAll()` 也会发这个事件，那不是删会话。
- 不做启动期对账：它能清掉外部删除留下的死引用，但**不能阻止重启时丢绑定**；本次先把丢数据这条路径堵住。

## Alternatives considered

- **直接删掉 `agent/disposed` 里的摘卡**：能防丢，但外部删除会话（会话管理删、CLI 删）会留下死引用，直到下次重启都没人清；加一层会话存在性判断能同时保住两边。
- **启动时对账（扫卡片槽位 × 会话库）**：覆盖崩溃场景，但对「重启导致丢绑定」无效，而且要等下一次启动才清理；本次不做，等真出现外部删除的痛点再单开。
- **按进程信号设 shutdown 标志**：插件里监听 SIGTERM 侵入宿主生命周期，Windows 与嵌入场景也不一致。
- **延迟一个 tick 再看 `disposed`**：宿主可能在插件 dispose 之前就退出，定时器不保证执行。

## Consequences

- 重启后卡片槽位保留，worker 会话记录也在；下次 `message_worker` 按原绑定找会话，会话恢复与否由宿主负责。
- 外部删除会话时，若记录已从会话库删掉，仍会摘卡；若删除与销毁的顺序反了（先销毁、后删记录），槽位会留到用户手动清或下次删除——这是用「宁可留死引用」换数据安全。
- 会话库在重启窗口不可用（返回 `undefined` 或抛错）时同样保留绑定；代价是可能留下死引用。
- 已经丢掉的绑定不会自动恢复：本次只防再丢，用户需要时按 `workers.json` 里还活着的 worker 重新绑槽位。

## Testing

- `tests/leader-wiring.test.js` 新增「宿主重启销毁活 agent 时不清卡片槽位」：会话仍在 → 等 100ms 后槽位原样；把实现临时改回无条件 `detachSession`，该用例变红，还原后全绿。
- 既有「宿主销毁会话时摘槽位」「插件卸载后不清」「detach 抛错只记日志」继续覆盖删除、卸载与错误路径；假件的 `sessionQuery` 用会话 id 集合模拟真实宿主 `listSessions` 的返回形状。
