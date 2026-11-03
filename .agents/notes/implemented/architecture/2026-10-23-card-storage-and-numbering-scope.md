# 卡片存储与编号作用域

**范围**：`src/host/cards/store.js`、`src/host/tools/cards.js`

## 背景

卡片是协调者维护的任务事实：编号递增不复用、`revision` 做乐观并发、`archived` 是终态、检查点记录已确认的结论与下一步。看板要给人看，模型要能读写，两者需要同一份数据。

dsh 有两个现成方向：team 任务板（覆盖任务 + 依赖 + owner + CAS）与 storage domain。前者不覆盖 slot→session 绑定、links、checkpoint 与编号不复用；后者需要 dsh 内部包与 zod。

## 决策

**自建落盘，不用 storage domain**。`defineDomain` 要求 zod schema 且存储域服务是 `@deepseek-ai/dsh-storage-domain` peer 依赖，dsh 按 peer 版本与宿主严格校验——依赖内部包的 bundle 会周期性失效（`agent-team` 是活例）。自建与通知队列同构：原子写（tmp + rename）+ 全部读-改-写走同一条 promise 链串行化。

**槽位索引的重建也排在同一条写链上**。槽位反查索引是进程内的内存镜像（卡片库才是真源），进程启动时用 `loadSlotIndex()` 从卡片库重建。重建若不排队，就会与并发的建卡/改卡交错：重建读到旧快照、其间落盘完成，重建再把旧快照写回索引，丢掉刚落盘的槽位绑定，直到下一次改卡才恢复。写链已串行化，重建排进同一条链即可消除这一整类时序论证。

**编号全局递增，不按项目**。P2 没有项目实体（项目作用域推迟到 P3），按项目编号会让「先建实体再发卡」成为前置依赖，而卡片工具本身不依赖项目。全局 `counter` 字段持久化，归档与删除都不回收编号。项目实体落地后（P5），卡片**多了项目归属字段**，但编号作用域仍未改——按项目过滤后编号会有空洞，全局唯一反而不歧义（见[看板按项目组织](../feature/2026-10-27-project-bound-board.md)）。

**`expectedRevision` 可选，但冲突时拒绝落盘**。协议层要求「改内容带 revision，槽位指派不带」，两者共用一个更新入口，所以校验做成「带了才校验」。

**检查点的维护者与确认时间由宿主写入**。调用方只提供 summary / nextAction / blocker / outputVersion；`updatedBy` 取调用方 agent 的 session id，`updatedAt` 取宿主时间。调用方自称的确认时间不可信。

**客户端取数走 `output.presentationMeta`**。`output.render` 只给模型看文本，`output.value` 不进事件流；`presentationMeta` 投影的 `meta` 才随 `tool/result` 事件持久化进 session log，是客户端唯一稳定的结构化取数通道。投影形状 `{kind:'dsh-leader-kit-cards', scope:'card'|'all', cards}`，客户端按 id 合并单卡、按全量替换列表。

**卡片归属项目由宿主在写卡时判定**。P5 起卡片记录带 `projectId` 与 `createdBy`：宿主按调用方会话反查项目（协调者走注册表指针，其它会话按 cwd 的 realpath 与项目目录相同），把归属写进记录。模型不传项目参数——它未必知道自己在哪个项目的语境里调工具。存量卡片没有 `projectId`，不迁移（记录里没有创建会话 id，无法可靠反推）。

## 边界

- **编号作用域的迁移代价**：将来若要求按项目编号，需迁移存量卡片的编号作用域。当前是全局编号——按项目过滤后编号有空洞但全局唯一，`@#n` 引用仍不歧义。
- **存量卡片的归属无法反推**：卡片记录里没有创建会话 id，改造前建的卡归不了项目，不迁移（见[看板按项目组织](../feature/2026-10-27-project-bound-board.md)）。
- **库文件损坏时备份并写回空库**。只备份不写回会让存储文件就此消失，下次启动连「库是空的」都读不出来。
- **不落盘信号灯**。停滞/待注意等状态由看板按会话活性实时投影。
- **无删除 API**。归档是终态，删除交用户决定。

## 证据

49 例单测全绿（编号不复用、revision 递增、archived 终态、done⇄active 的 doneAt、检查点宿主补写、库损坏备份并写回空库、并发建卡不重号）。槽位索引另有独立用例，含「启动重建与写卡交错时不丢最新槽位绑定」——用可控的文件系统把第一次读卡住，排出「重建读到旧快照、其间落盘完成」的确定顺序；去掉写链排队该用例即失败。

sdk profile（dsh 0.2.1-rc.2）+ dsh 自带 mock LLM server 实测：模型工具列表含 `create_card`/`update_card`/`list_cards`；建卡落盘 `#1`、`revision: 0`；改卡后 `revision: 0 → 1`、`status: done` 且 `doneAt` 已记、`checkpoint.updatedBy` 被补成调用方会话 id；带过期 `expectedRevision` 调用报「卡片版本冲突：期望 0，当前 1」且未落盘；`tool/result` 事件的 `meta` 携带完整卡片对象。
