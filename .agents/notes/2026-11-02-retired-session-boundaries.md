# 换协调者的三处边界：并发写入、client 身份、退役后的指挥能力

PR #28 把退役协调者会话留在项目下（见 [2026-10-30-retired-coordinator-sessions.md](2026-10-30-retired-coordinator-sessions.md)），留下三条没修的非阻断建议（[issue #31](https://github.com/fengshenx/dsh-leader-kit/issues/31)）。三条的共同点是同一件事：**「项目下可见」不等于「还是项目会话」**——列表、身份、工具面各有各的口径。

## 并发换协调者：退役追加必须是读-改-写

原来的 `replaceCoordinator` 在函数开头读一次项目快照，按快照算退役列表，最后整体写回。两个客户端（两个 tab 各有独立 `busy`）并发点击时，两次调用各建一个会话、各写一次：后写的把先写的覆盖掉，先建的那个既不在 `retiredCoordinatorSessionIds` 里、又留在 `coordinatorIndex` 里——直到进程重启都能派工、都被注入协调者手册，在官方工作区树里也掉回一条普通会话。

决策：`createProjectStore().update(id, updates)` 接受**函数**形态，参数是磁盘上的当前记录，读-改-写落在存储的串行链（`serialize`）里。`replaceCoordinator` 的退役追加改用它，退役的是**落盘记录里的**当前协调者，不是进函数时的快照。

**索引对齐按重读的记录，不按 `update` 的返回值**。返回值是「这一次写下的状态」，两次并发就有两次写入，按各自返回值对齐等于认定「后完成的那次同步一定对」——那只在「两次 update 的续体按写入顺序兑现」时成立，正确性就押在微任务顺序上了。落选的那次同步晚到一步，会把已被退役的会话重新写成协调者（落盘与索引不一致）。`syncCoordinatorIndex(id)` 因此在写完后再读一次记录、按最新值对齐：晚到的同步只会朝最新值收敛。对齐不在 `try` 里——写已经落盘、新会话就是记录里的协调者，重读失败不该把它连带撤销。

两条附带边界：

- 白名单要在函数求值之后套用。函数对象自带 `name` 属性，直接 `Object.hasOwn(updates, key)` 会把函数名当项目名写进记录。函数也必须同步返回普通对象（JSDoc 已写明）。
- 并发不合并：两次点击仍会建两个会话，落选的那个进退役列表（项目下可打开的历史），不是孤儿。合并点击属于产品决策，没做。

## client 身份：项目会话表不是 worker 表

`sessionsByProject` 现在把退役 id 并进同一张表（项目树要列它），而 client 拿它当 worker 表用，退役会话因此拿到本项目看板入口。`summarizeProject` 因此带出 `retiredCoordinatorSessionIds`，client 侧：

- `fetchProjectWorkers` / `isProjectWorker` 改名为 `fetchProjectSessions` / `isProjectSession`——那张表列的是「项目下的会话」，身份要再分一次；
- `isRetiredCoordinatorSession` 在 `boardViewState` / `isBoardEntryVisible` / `resolveBoardAccess` 三处显式排除。

判据放在 client 的纯函数里而不是只放在 `resolveBoardAccess`：`isWorker` 是调用方传进来的参数，从旧数据算出来的 `true` 不该穿透到视图判定。退役会话的出口是 `not-viewable`（与同目录普通会话同一句提示），不给「去换新协调者」的引导——它自己就是被换下来的那个。

host 侧不把退役 id 从表里剔掉：同一张表还给项目树用，退役会话必须留在项目树下。

## 退役后的指挥能力：校验只能放在调用时

工具面在 `agent/created` 一次性裁，而换协调者不重建旧会话：退役会话手里仍留着 `spawn_worker` / `message_worker` / `list_cards`，直到进程重启按普通会话重裁。所以：

- `deniedToolsFor` **不需要改**。退役后索引里没有它，冷恢复时的 `agent/created` 会走「非协调者」分支，本来就被裁掉这三件。
- 缺口只在同一进程内不重建的存量会话，校验因此放进调用时：`dispatcher.dispatch` 与 `dispatcher.message` 共用 `assertCoordinator`（先 `awaitIndex()` 再判身份，不吃「索引未就绪就放行」的宽松），`create_list_cards` 的跨项目读取共用 `assertCrossProjectRead`（判据是摘要里的退役集合，不走 `isCoordinatorSession()` 的宽松分支）。
- 投递前判定，而不是拦住后再补：退役会话给原班 worker 下指令，是把「谁是协调者」判错了，不是投递失败。

`list_cards` 收口的口径：

- `scope: 'all'` 与单卡 `cardId` 两条路径都拒（都是跨项目寻址），返回**报错**而不是空列表——空列表会把「你没权限」伪装成「全库没有卡」；默认 `scope: 'project'` 照旧放行，退役会话读本项目与同目录的普通会话同档。
- 单卡查询不做「这张卡属于本项目就放行」的细分：工具在解析归属前就读了全库，要细分得先按卡的项目归属再判，超出这个口子的范围。需要读单卡全文时交给当前协调者。
- worker 本来就没有 `list_cards`（`COORDINATOR_ONLY_TOOLS`），所以这道闸只可能命中退役会话；判据是退役集合而不是「必须是协调者」，不会误伤将来可能放宽的工具面。

**边界：换人之后原班 worker 对谁都投不进去**。退役会话被身份闸挡住，新协调者被 `worker.parentSessionId !== parent.id` 挡住——登记表里的父会话还是退役 id，而 `src/host` 里没有改绑父会话的路径。继续用它们只有两条路：人下钻直接对话，或归档后在新协调者会话里重新派工。不改父会话是因为「谁派的工」是历史事实，改绑还要把在飞记录、完成通知队列与退役会话的历史一起换主；in-flight worker 的完成通知仍投给退役会话，那条通知落在没有工具面的会话里。`message` 的注释与报错文案都按这个实况写，不回退成「原班 worker 归新协调者」。

## 测试

- `tests/projects-store.test.js`：函数形态的 update 按磁盘当前值追加（并发两次都在）、同样只接受白名单、函数自身的属性不漏进记录。
- `tests/projects-service.test.js`：`Promise.all` 两次 `replaceCoordinator` 后，每条建出来的会话要么是当前协调者、要么在退役列表里；索引里只剩当前协调者。另一例把第一次 `update` 的兑现推迟到第二次之后，断言索引仍与落盘记录一致（不信完成顺序）。
- `tests/project-board-data.test.js`：退役协调者在看板入口/视图/访问权三处都不是项目会话，且不必等项目会话表问回来；会话表本身仍把它算作项目会话。
- `tests/dispatch.test.js`：退役会话 `message_worker` 被拒且不投递；索引未就绪时同样不投递。
- `tests/cards-tools.test.js`：退役会话的 `scope: 'all'` 与单卡 `cardId` 都被拒、默认范围照旧；当前协调者的跨项目查卡不受影响。

双向验证（逐项撤销修复 → 对应用例变红 → 还原全绿）：撤掉「函数形态 update 的读-改-写」（1 例）、「client 三处退役排除」（2 例）、「`message` 的身份校验」（2 例）、「白名单在函数求值之后套用」（2 例）、「索引按重读记录对齐」（1 例）、「`list_cards` 跨项目身份闸」（1 例）。
