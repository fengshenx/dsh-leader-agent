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

## 换人之后原班 worker 归新协调者：接管而不是重新派工

`COORDINATOR.md` 写的是「新会话立刻接手项目」。只把退役会话挡在门外不够——登记表里的
父会话仍是退役 id，新协调者过不了 `worker.parentSessionId !== parent.id`，那批工谁的
指令都收不到，等于换个人就废掉一班人。所以换人时做**接管**（`src/host/coordinator-handover.js`），
不新增「转移」工具：

- `worker-registry.reassignParent(from, to)`：改 `parentSessionId`，并把旧的父会话
  追加进 `reassignedFrom`——「谁派的工」是历史事实，改投不等于抹掉。
- `notification-store.reassignParent(from, to)`：只改还在队列里的通知。已投出的是旧会话
  的历史，搬它等于篡改历史。
- `dispatcher.reassignParent(from, to)`：等待表按到达顺序拼到接手会话已有条目之前
  （那些是更早完成的工），条目里的通知**跟着改 `parentSessionId`** 并丢掉旧 agent；
  续行计数取两者较大值（这批通知已经消耗过旧会话的额度，换人不该清零护栏），在飞记录
  改父会话并**丢掉 `parent` 活对象**（那是退役会话的 agent，回退到它等于把回报送进一个
  不能动手的会话）。
- 补投之后**不清等待表**：`redeliverPending` / `redeliverPendingFor` 原来在「本次投出
  ≥1 条」时整表 `delete`，会把同一轮里刚进等待表的条目（会话转忙、额度用尽）一起丢掉
  ——那批通知就只剩盘上一条，直到下一次 `agent/created`。`flushWaiting` 本来就按落盘
  队列逐条核对，已投出的会自己掉出去，不需要整表删。
- 等待表条目里的通知如果不改 `parentSessionId`，`deliverOnce` 仍按旧 id 取续行计数，
  这批通知就按 0 额度算——实测上限 2 却投出 4 条，护栏被换人绕过。
- 登记表改绑命中 0 条时不写盘（`serializeDeferredWrite`）：接管对每个退役 id 调一次，
  退役列表只增不删，每次换人都是 N 次空读改写。

**接手方与退役集取当前落盘记录**（`projects.get` 后遍历全部 `retiredCoordinatorSessionIds`），
不取调用那次写下的值：两次并发换人时，先完成的那次接管可能到记录已改成第三个人之后
才执行，按自己那次的值改就会把工交回一个已被换下的会话。按当前记录算则每次都朝最新值
收敛，与索引对齐同一个道理；顺带也补上早先漏迁留下的孤儿。

取舍与已知边界：

- 接管失败（登记表/队列 IO 错）直接抛给调用方：那时项目记录已经改绑，用户会看到「换
  协调者失败」而实际协调者已换。没有回滚——回滚要重建一条已经停掉的新会话，代价更大。
  再点一次换协调者会把没迁完的补齐（接管幂等）。
- 队列条目不留 `reassignedFrom`：它不是历史记录，改投后只有一个归属；需要追溯看登记表。
- `resumeCounts` 取较大值意味着接管后这批通知的自动续行额度沿用旧会话的消耗；人工在
  新会话里开口会复位（`resetResumeCount`）。
- 等待表条目握着的旧 agent 与新会话不可达时的兜底：换人后新会话若解析不到，回报留在
  盘上等它下次可达，**不能**回落到退役会话的 agent（那条会话已经没有工具面了）。

`message` 的注释与 `assertCoordinator` 只负责「退役会话不能自己下指令」，不再声称原班
worker 无人可投。


## 测试

- `tests/projects-store.test.js`：函数形态的 update 按磁盘当前值追加（并发两次都在）、同样只接受白名单、函数自身的属性不漏进记录。
- `tests/projects-service.test.js`：`Promise.all` 两次 `replaceCoordinator` 后，每条建出来的会话要么是当前协调者、要么在退役列表里；索引里只剩当前协调者。另一例把第一次 `update` 的兑现推迟到第二次之后，断言索引仍与落盘记录一致（不信完成顺序）。
- `tests/project-board-data.test.js`：退役协调者在看板入口/视图/访问权三处都不是项目会话，且不必等项目会话表问回来；会话表本身仍把它算作项目会话。
- `tests/dispatch.test.js`：退役会话 `message_worker` 被拒且不投递；索引未就绪时同样不投递。
- `tests/cards-tools.test.js`：退役会话的 `scope: 'all'` 与单卡 `cardId` 都被拒、默认范围照旧；当前协调者的跨项目查卡不受影响。
- `tests/coordinator-handover.test.js`：接管把登记表与未投递通知一起改到新会话（真存储）；记录已改成第三个人时晚到的接管仍朝最新值收敛；项目已删除或没有退役集时什么都不做。
- `tests/worker-registry.test.js` / `tests/notification-store.test.js`：改绑只动该动的记录、留 `reassignedFrom`、幂等、落盘可读回。
- `tests/dispatch.test.js`：接管后新协调者能 `message_worker` 原班 worker、退役会话仍被拒；在飞 worker 的回报投给新协调者；补投期间会话转忙时新进等待表的那条仍会送达；接管后等待中的通知按接手会话的额度计；新会话不可达时回报留给它而不投给退役会话。
- `tests/projects-service.test.js`：换协调者成功才触发接管，改绑失败不触发。

双向验证（逐项撤销修复 → 对应用例变红 → 还原全绿）：撤掉「函数形态 update 的读-改-写」（1 例）、「client 三处退役排除」（2 例）、「`message` 的身份校验」（2 例）、「白名单在函数求值之后套用」（2 例）、「索引按重读记录对齐」（1 例）、「`list_cards` 跨项目身份闸」（1 例）、「换人后触发接管」（1 例）、「接管里的登记表改绑」（2 例）、「在飞记录的父会话改绑」（1 例）、「补投后不清等待表」（1 例）、「等待表条目改父会话 id」（1 例）、「在飞记录丢掉旧 agent」（1 例）、「登记表 0 条不写盘」（1 例）。
