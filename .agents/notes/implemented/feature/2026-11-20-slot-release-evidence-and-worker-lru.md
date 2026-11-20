# Agent Note: 槽位只在关闭时释放，worker 名册按最近使用复用

Status: implemented

## Problem

同一天两次出现同一种丢记录：审查交付后，leader 为了复用 worker 手动清空了卡上的 review 槽位，卡上再也找不到「谁审过」；把槽位补绑回旧会话又制造了假的「审核中」。靠 `LEADER.md` 约定先挂 `links` 没有拦住，约束必须内置。同一时期 `spawn_worker` 到顶只按 `registeredAt` 推荐最新创建的 worker，与「越久没用越该复用」相反。

## Decision

- 在卡片写入层硬拒「active 卡移除某个角色绑定」：`slots` 把角色从有会话改成没有就直接报错；要换人只能把该角色替换为新会话。手动释放只由 `done` / `archived` 状态变更触发，关闭时自动清空 `slots`。
- 例外是执行者会话归档或宿主销毁：`detachSession` 会摘掉所有卡片（含 active 卡）上指向该会话的槽位，这是死引用清理；`docs/usage.md` 与 `LEADER.md` 都明确写了这个例外，避免与「只由状态变更触发」冲突。
- 卡从 `active` 改 `done` 且 `links` 为空时，`update_card` 返回软提示「这张卡没有交付物链接，关闭后只剩标题」，不拒绝关闭。`LEADER.md` 只写原因与操作建议，不再承担拦截职责。
- `worker-registry` 新增 `lastUsedAt`：`message_worker` 成功投递后 `markUsed`，回合结算时 `markReported` 同步更新；新记录初始化为 `registeredAt`；旧表缺字段读取时按 `registeredAt` 兜底。
- `message` 先把这一轮登记进 `inflight`，再等 `markUsed` 落盘：`send()` 对活会话是同步 `agent.steer`，否则 `turn/end` 可能落在写 `workers.json` 的窗口里，找不到在飞记录而不结算。
- `describeRoster()` 的 `idle` 按 `lastUsedAt` 升序，`bound` 不动。到顶提示把最久未用排前面并带 `lastUsedAt`，挂未完成卡的单列，最近新建的标为保留上下文；不自动归档。上限仍为 50；`registeredAt` 保留用于 500 条登记文件截断、最近新建标注与同刻兜底。

## Alternatives considered

- 软提醒清空没有 links 的槽位：实际两次都被忽略，不能阻止丢记录；作为补充提示可以，作为主约束不够。
- 只在 `LEADER.md` 写约定或加 `spec` 状态块：靠人记得，正是本次失效的路径；状态块也不能恢复已清掉的归属。
- 硬拒所有 `slots` 改动：换人接力也被堵死；只拦「角色消失」，允许同角色替换。
- 用 `registeredAt` 当 LRU：登记早不等于最近没用；一个老 worker 可能刚接手新任务，反而应该保留。
- 到顶自动归档最久未用：归档丢上下文且不可逆，腾名额应由人判断；提示候选与 `force` 足够。
- 每次读旧表都整表重写补字段：无谓写盘；只在读快照补值，下一次真实写盘自然落盘。

## Consequences

- 以前手动清空 active 卡槽位的调用现在会报错；换人要显式替换会话或先关闭卡。存量卡片数据不变。
- 归档 / 宿主销毁链路保留 `detachSession` 的清理行为；这是文档写明的唯一例外，不经过 `update_card` 的硬拦截。
- 关闭且 `links` 为空的提示只是提示，仍可关闭；这类卡关闭后只剩标题，是已知代价。
- `lastUsedAt` 只在成功投递与回合结算时更新；人自己下钻聊天不改变 LRU，顺序以 leader 派工为准。
- 到顶提示变长（带时间与三类），但候选顺序可解释；没有自动清理，名册仍需人维护。
- 新增落盘字段，旧文件可读；`registeredAt` 的容量语义不变。

收益：卡未关闭时归属不会被静默删除，关闭时也有证据提示；名册到顶先复用最久未用、保留最近新建的上下文。

## Testing

- `node --test tests/cards-tools.test.js tests/slot-index.test.js tests/dispatch.test.js tests/worker-registry.test.js`
- 双向验证：撤掉 active 移除拦截，新增用例变红；LRU 用例三条同毫秒登记、`lastUsedAt` 为旧→中→新，撤掉 `idle.sort` 中的 `lastUsedAt` 比较后按 id 兜底会变成 mid→new→old，LRU 用例变红；分别还原后全绿。
- 竞态回归：让 `markUsed` 慢于 `turn/end`，在飞记录仍结算；退回旧顺序（先 `markUsed` 后 `inflight`）该用例变红。
- 销毁清理：`agent/disposed` 摘掉 active 卡槽位；归档后再触发 disposed 幂等，不重复报错。
- 全量 `npm run check`；另覆盖 done 释放、替换、旧表兜底与 500 条按 `registeredAt` 截断。
