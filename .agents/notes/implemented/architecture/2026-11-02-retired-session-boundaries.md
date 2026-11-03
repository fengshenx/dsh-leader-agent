# 换协调者的四类边界：并发写入、client 身份、退役后的工具面与 worker 接管

## 背景

PR #28 把换下的协调者会话留在项目下、和 worker 同列（见 [2026-10-30-retired-coordinator-sessions.md](../feature/2026-10-30-retired-coordinator-sessions.md)），它的审查建议记为 [issue #31](https://github.com/fengshenx/dsh-leader-kit/issues/31)。

修的过程中又露出两层问题：一是「换人」不等于「新会话接过项目」——`COORDINATOR.md` 写的是「新会话立刻接手项目」，而原班 worker 的派工归属仍挂在退役会话上，换个人就废掉一班人；二是补投路径在「一次投出 ≥1 条」时整表删等待表，把同一轮里刚进去的条目一起丢掉。

四类边界的共性问题：**列表、身份、工具面、派工归属各有各的口径**。而工具面只在 `agent/created` 裁一次、换人不重建会话，所以凡是「退役之后不该再有」的能力都只能在调用时判。

## 决策

### 并发换协调者：退役追加必须是读-改-写

原来的 `replaceCoordinator` 在函数开头读一次项目快照，按快照算退役列表，最后整体写回。两个客户端（两个 tab 各有独立 `busy`）并发点击时，两次调用各建一个会话、各写一次：后写的把先写的覆盖掉，先建的那个既不在 `retiredCoordinatorSessionIds` 里、又留在 `coordinatorIndex` 里——直到进程重启都能派工、都被注入协调者手册，在官方工作区树里也掉回一条普通会话。

`createProjectStore().update(id, updates)` 因此接受**函数**形态：参数是磁盘上的当前记录，读-改-写落在存储的串行链（`serialize`）里。`replaceCoordinator` 的退役追加改用它，退役的是**落盘记录里的**当前协调者，不是进函数时的快照。

白名单要在函数求值之后套用：函数对象自带 `name` 属性，直接 `Object.hasOwn(updates, key)` 会把函数名当项目名写进记录。函数还必须同步返回普通对象（返回 `undefined` / 字符串 / Promise 都静默不生效），JSDoc 已写明。

并发不合并：两次点击仍会建两个会话，落选的那个进退役列表（项目下可打开的历史），不是孤儿。合并点击属于产品决策，没做。

### 索引对齐按重读记录，不按 `update` 的返回值

返回值是「这一次写下的状态」，两次并发就有两次写入；按各自返回值对齐等于认定「后完成的那次同步一定对」，正确性就押在微任务顺序上。落选的那次同步晚到一步，会把已被退役的会话重新写成协调者（落盘与索引不一致）。

`syncCoordinatorIndex(id)` 写完再读一次记录、按最新值对齐，晚到的同步只会朝最新值收敛。对齐放在失败路径之外：写已经落盘、新会话就是记录里的协调者，重读失败不该把它连带撤销。

### client：项目会话表不是 worker 表

`sessionsByProject` 现在把退役 id 并进同一张表（项目树要列它），而 client 拿它当 worker 表用，退役会话因此拿到本项目看板入口。`summarizeProject` 因此带出 `retiredCoordinatorSessionIds`，client 侧：

- `fetchProjectWorkers` / `isProjectWorker` 改名 `fetchProjectSessions` / `isProjectSession`——那张表列的是「项目下的会话」，身份要再分一次；
- `isRetiredCoordinatorSession` 在 `boardViewState` / `isBoardEntryVisible` / `resolveBoardAccess` 三处显式排除。

判据放在 client 的纯函数里而不是只放在 `resolveBoardAccess`：`isWorker` 是调用方传进来的参数，从旧数据算出来的 `true` 不该穿透到视图判定。退役会话的出口是 `not-viewable`（与同目录普通会话同一句提示），不给「去换新协调者」的引导——它自己就是被换下来的那个。

host 侧不把退役 id 从表里剔掉：同一张表还给项目树用，退役会话必须留在项目树下。

### 退役后的工具面：校验只能放在调用时

工具面在 `agent/created` 一次性裁，而换协调者不重建旧会话：退役会话手里仍留着 `spawn_worker` / `message_worker` / `list_cards`，直到进程重启按普通会话重裁。

`deniedToolsFor` **不需要改**：退役后索引里没有它，冷恢复时的 `agent/created` 会走「非协调者」分支，本来就被裁掉这三件。缺口只在同一进程内不重建的存量会话，校验因此放进调用时——`dispatch` 与 `message` 共用 `assertCoordinator`（先 `awaitIndex()` 再判身份，不吃「索引未就绪就放行」的宽松）；投递前判定，而不是拦住后再补：退役会话给原班 worker 下指令，是把「谁是协调者」判错了，不是投递失败。

### `list_cards` 的跨项目读取一并收口

`scope: 'all'` 与单卡 `cardId` 两条路径都过 `assertCrossProjectRead`，判据取摘要里的退役集合（不走 `isCoordinatorSession()` 的宽松分支）：

- 两条路径都拒，且返回**报错**而不是空列表——空列表会把「你没权限」伪装成「全库没有卡」；
- 默认 `scope: 'project'` 照旧放行：退役会话读本项目与同目录的普通会话同档；
- 单卡查询不做「这张卡属于本项目就放行」的细分：工具在解析归属前就读了全库，要细分得先按卡的项目归属再判；需要读单卡全文时交给当前协调者；
- worker 本来就没有 `list_cards`（`COORDINATOR_ONLY_TOOLS`），这道闸只可能命中退役会话；判据是退役集合而不是「必须是协调者」，将来放宽工具面也不会误伤 worker。

### 换人之后原班 worker 归新协调者：接管而不是重新派工

只把退役会话挡在门外不够：登记表里的父会话仍是退役 id，新协调者过不了 `worker.parentSessionId !== parent.id`，那批工谁的指令都收不到。所以换人时做**接管**（`src/host/coordinator-handover.js`），不新增「转移」工具：

- `worker-registry.reassignParent`：改 `parentSessionId`，旧父会话追加进 `reassignedFrom`——「谁派的工」是历史事实，改投不等于抹掉；
- `notification-store.reassignParent`：只改未投递的通知，已投出的是旧会话的历史；
- `dispatcher.reassignParent`：等待表按到达顺序拼到接手会话已有条目之前（那些是更早完成的工），条目里的通知跟着改 `parentSessionId` 并丢掉旧 agent；续行计数取两者较大值；在飞记录改父会话并丢掉 `parent` 活对象——那是退役会话的 agent，回退到它等于把回报送进一个不能动手的会话；
- `dispatcher.redeliverPendingFor`：改投过来的通知推一次投递。新会话的 `agent/created` 早于这次迁移，那一刻队列里还没有它的事，不推就一直躺在盘上。

**接手方与退役集取当前落盘记录**（`projects.get` 后遍历全部 `retiredCoordinatorSessionIds`），不取调用那次写下的值：两次并发换人时，先完成的那次接管可能到记录已改成第三个人之后才执行，按自己那次的值改就会把工交回一个已被换下的会话。按当前记录算则每次都朝最新值收敛（与索引对齐同一个道理），顺带补上早先漏迁留下的孤儿。

`replaceCoordinator` 成功后触发接管（`index.js` 晚绑定装配：接管依赖派工器，而派工器依赖项目服务）。`message` 的注释与 `assertCoordinator` 只声称「退役会话不能自己下指令」，不再声称原班 worker 无人可投。

### 补投不清等待表，条目跟着改父会话 id

`redeliverPending` / `redeliverPendingFor` 原来在「本次投出 ≥1 条」时整表 `waiting.delete`，会把同一轮里刚进等待表的条目（会话转忙、额度用尽）一起丢掉——那批通知就只剩盘上一条，直到下一次 `agent/created`；web 里会话常驻时表现为「一直没送到」。`flushWaiting` 本来就按落盘队列逐条核对，已投出的会自己掉出去，不需要整表删。

等待表条目里的通知如果不改 `parentSessionId`，`deliverOnce` 仍按旧 id 取续行计数，这批通知就按 0 额度算（实测上限 2 却投出 4 条，护栏被换人绕过）；`deliver` 的 `disposed.has(...)` 也查旧 id。

登记表改绑命中 0 条时不写盘（`serializeDeferredWrite`）：接管对每个退役 id 调一次，退役列表只增不删，每次换人都是 N 次空读改写。

## 边界

- **接管失败不回滚**：登记表/队列 IO 错直接抛给调用方。那时项目记录已经改绑，用户会看到「换协调者失败」而实际协调者已换；回滚要重建一条已经停掉的新会话，代价更大。再点一次换协调者会把没迁完的补齐（接管幂等）。
- **新会话不可达时不回落到退役会话**：回报留在盘上等它下次可达。宁可晚到，也不投进一条已经没有工具面的会话。
- **队列条目不留 `reassignedFrom`**：它不是历史记录，改投后只有一个归属；要追溯看登记表。
- **`resumeCounts` 取较大值**：接管后这批通知的续行额度沿用旧会话的消耗；人工在新会话里开口会复位（`resetResumeCount`）。
- **`list_cards` 解析不到项目时放行**：会话连项目归属都没有时判不出退役身份，读类工具按放行处理。
- **只解决同一项目内换人**：跨协调者、跨项目的 worker 仍被父会话校验拦住，`message` 的跨会话拒绝照旧。

## 验证

- `tests/projects-store.test.js`：函数形态的 update 按磁盘当前值追加（并发两次都在）、只接受白名单、函数自身的属性不漏进记录。
- `tests/projects-service.test.js`：`Promise.all` 两次 `replaceCoordinator` 后，每条建出的会话要么是当前协调者、要么在退役列表里；把第一次 `update` 的兑现推迟到第二次之后，索引仍与落盘记录一致；换人成功才触发接管，改绑失败不触发。
- `tests/project-board-data.test.js`：退役协调者在看板入口/视图/访问权三处都不是项目会话，且不必等项目会话表问回来。
- `tests/cards-tools.test.js`：退役会话的 `scope: 'all'` 与单卡 `cardId` 都被拒、默认范围照旧；当前协调者的跨项目查卡不受影响。
- `tests/coordinator-handover.test.js`：接管把登记表与未投递通知一起改到新会话（真存储）；记录已改成第三个人时晚到的接管仍朝最新值收敛；项目已删除或没有退役集时什么都不做。
- `tests/worker-registry.test.js` / `tests/notification-store.test.js`：改绑只动该动的记录、留 `reassignedFrom`、幂等、落盘可读回；命中 0 条不写盘（按 inode 判，带「真改到时照常落盘」的对照组）。
- `tests/dispatch.test.js`：退役会话 `message_worker` 被拒且不投递；接管后新协调者能 `message_worker` 原班 worker；在飞回报投给新协调者；新会话不可达时回报留盘；补投期间会话转忙时新进等待表的条目仍送达；等待中的通知按接手会话的额度计。

双向验证（逐项撤销修复 → 对应用例变红 → 还原全绿）：函数形态 update 的读-改-写（1 例）、client 三处退役排除（2）、`message` 身份校验（2）、白名单在函数求值之后套用（2）、索引按重读记录对齐（1）、`list_cards` 跨项目身份闸（1）、换人后触发接管（1）、接管里的登记表改绑（2）、在飞记录的父会话改绑（1）、接管尾声的补投（2）、补投后不清等待表（1）、等待表条目改父会话 id（1）、在飞记录丢掉旧 agent（1）、登记表 0 条不写盘（1）。
