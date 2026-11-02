# 换协调者的三处边界：并发写入、client 身份、退役后的指挥能力

PR #28 把退役协调者会话留在项目下（见 [2026-10-30-retired-coordinator-sessions.md](2026-10-30-retired-coordinator-sessions.md)），留下三条没修的非阻断建议（[issue #31](https://github.com/fengshenx/dsh-leader-kit/issues/31)）。三条的共同点是同一件事：**「项目下可见」不等于「还是项目会话」**——列表、身份、工具面各有各的口径。

## 并发换协调者：退役追加必须是读-改-写

原来的 `replaceCoordinator` 在函数开头读一次项目快照，按快照算退役列表，最后整体写回。两个客户端（两个 tab 各有独立 `busy`）并发点击时，两次调用各建一个会话、各写一次：后写的把先写的覆盖掉，先建的那个既不在 `retiredCoordinatorSessionIds` 里、又留在 `coordinatorIndex` 里——直到进程重启都能派工、都被注入协调者手册，在官方工作区树里也掉回一条普通会话。

决策：`createProjectStore().update(id, updates)` 接受**函数**形态，参数是磁盘上的当前记录，读-改-写落在存储的串行链（`serialize`）里。`replaceCoordinator` 的退役追加改用它，退役的是**落盘记录里的**当前协调者，不是进函数时的快照。

索引同步按 `update` 返回的记录做（先删退役集里的 id、再设当前 id），不按快照删 `previous`：串行链保证返回的记录就是那一刻的落盘值，并发时前一次调用建的会话会出现在后一次的退役集里，只有按返回记录对齐才能把它从索引里摘掉。

两条附带边界：

- 白名单要在函数求值之后套用。函数对象自带 `name` 属性，直接 `Object.hasOwn(updates, key)` 会把函数名当项目名写进记录。
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
- 缺口只在同一进程内不重建的存量会话，校验因此放进 `dispatcher.message`：与 `dispatch` 共用 `assertCoordinator`（先 `awaitIndex()` 再判身份，不吃「索引未就绪就放行」的宽松）。
- 投递前判定，不拦住后再补：退役会话给原班 worker 下指令，是把「谁是协调者」这件事判错了，不是投递失败。

**仍然敞着的一条**：`list_cards` 的 `scope: 'all'` 对退役会话仍可读（跨项目卡片元数据，只读）。它和工具面是同一个缺口，但没有「指挥」含义，这次没动；要收的话得在 `list_cards` 的 `execute` 里加同一道身份校验。

## 测试

- `tests/projects-store.test.js`：函数形态的 update 按磁盘当前值追加（并发两次都在）、同样只接受白名单、函数自身的属性不漏进记录。
- `tests/projects-service.test.js`：`Promise.all` 两次 `replaceCoordinator` 后，每条建出来的会话要么是当前协调者、要么在退役列表里；索引里只剩当前协调者。
- `tests/project-board-data.test.js`：退役协调者在看板入口/视图/访问权三处都不是项目会话，且不必等会话表问回来；会话表本身仍把它算作项目会话。
- `tests/dispatch.test.js`：退役会话 `message_worker` 被拒且不投递；索引未就绪时同样不投递。

双向验证：分别撤掉「函数形态 update 的读-改-写 + 按返回记录同步索引」（并发用例 1 例变红）、「client 三处退役排除」（2 例变红）、「`message` 的身份校验」（2 例变红）、「白名单在函数求值之后套用」（2 例变红），还原后全绿。
