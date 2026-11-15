# Agent Note: 卡片存储与编号作用域

Status: implemented

## Problem

卡片是协调者维护的任务事实（编号递增不复用、`revision` 乐观并发、`archived` 终态、检查点记已确认的结论与下一步），看板与模型必须读写同一份数据；dsh 现成的 team 任务板与 storage domain 都覆盖不了 slot→session 绑定、links、checkpoint 与编号不复用。

## Decision

**自建落盘，不用 storage domain**：`defineDomain` 要求 zod schema 且存储域是 dsh 内部 peer 依赖，宿主按 peer 版本严格校验，带内部依赖的 bundle 会周期性失效。落盘与通知队列同构：原子写 + 全部读-改-写走同一条 promise 链串行化。

**槽位反查索引的重建排在同一条写链上**：索引是进程内的内存镜像（卡片库才是真源），启动时从卡片库重建；不排队会与建卡/改卡交错，把刚落盘的槽位绑定覆盖回旧快照。

**编号全局递增，不按项目**：全局 `counter` 持久化，归档与删除都不回收编号。项目实体落地后卡片多了项目归属字段，编号作用域不变——按项目过滤后编号有空洞但全局唯一，`@#n` 引用不歧义。

**`expectedRevision` 可选，冲突时拒绝落盘**：协议层要求改内容带 revision、槽位指派不带，两者共用一个更新入口，所以校验做成「带了才校验」。

**检查点的维护者与确认时间由宿主写入**：调用方只提供 summary / nextAction / blocker / outputVersion，`updatedBy` 取调用方 agent 的 session id、`updatedAt` 取宿主时间，调用方自称的时间不可信。

**客户端取数走 `output.presentationMeta`**：`output.render` 只给模型看文本、`output.value` 不进事件流；投影的 `meta` 随 `tool/result` 事件持久化进 session log，是客户端唯一稳定的结构化通道，形状 `{kind:'dsh-leader-agent-cards', scope:'card'|'all', cards}`，客户端按 id 合并单卡、按全量替换列表。

**卡片归属项目由宿主写卡时判定**：按调用方会话反查项目（协调者走注册表指针，其它会话按 cwd 的 realpath 与项目目录相同），写进 `projectId` / `createdBy`；模型不传项目参数——它未必知道自己在哪个项目的语境里。存量卡片没有 `projectId` 也不迁移（记录里没有创建会话 id，无法可靠反推）。

## Alternatives considered

- **用 dsh storage domain**：`defineDomain` 要求 zod schema，且 dsh 内部 peer 依赖会随宿主版本严格校验，带内部依赖的 bundle 会周期性失效；自建落盘 + 原子写/串行链换来零版本耦合。
- **用 agent-team 的任务板**：它覆盖不了 slot→session 绑定、links、checkpoint 与编号不复用。
- **编号按项目递增**：会要求迁移存量卡片的编号作用域，且跨项目 `@#n` 引用会歧义；当前全局唯一、允许空洞。

## Consequences

- **编号作用域的迁移代价**：将来若要求按项目编号，需迁移存量卡片的编号作用域；当前按项目过滤有空洞但全局唯一。
- **存量卡片归属无法反推**，不迁移（见[看板按项目组织](../feature/2026-10-27-project-bound-board.md)）。
- **库文件损坏时备份并写回空库**：只备份不写回会让存储文件就此消失，下次连「库是空的」都读不出来。
- **不落盘信号灯**：停滞/待注意等状态由看板按会话活性实时投影。
- **无删除 API**：归档是终态，删除交用户决定。

收益：卡片库成为看板与模型共用、可崩溃恢复的任务事实源，编号全局唯一、槽位绑定有单一真源。

## Testing

`tests/cards-store.test.js`、`tests/cards-tools.test.js` 与 `tests/slot-index.test.js` 钉住编号、revision、终态、宿主补写与槽位索引。槽位索引用例用可控文件系统把第一次读卡住，排出「重建读到旧快照、其间落盘完成」的确定顺序，去掉写链排队即失败。
