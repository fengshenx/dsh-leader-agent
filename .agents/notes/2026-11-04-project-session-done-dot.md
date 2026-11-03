# 项目树会话行的完成绿点

## 背景

宿主左栏的官方会话行有「完成未读」绿点：会话从执行中转为空闲、且用户没在看它时点亮，打开后熄灭。项目的 worker 会话被渲染层排除出官方工作区树（`workspace-exclusion.js`），由项目面板自绘会话行呈现，而自绘行只画了运行中的加载圈——worker 跑完，项目树里毫无提示，用户只能逐个点开看。

## 决策

### 完成未读在插件侧自行投影，不找宿主要数据

绿点状态是宿主 ui-session 的进程本地投影（`completionUnread`，不落盘），不在任何对插件公开的服务上；把 `ui-session` 加进产物依赖也不可行——它不在宿主冻结模块表（`PLATFORM_MODULES`）的基线里，基线外宿主包不保证可用（见 client-side findings 笔记）。可行做法是照宿主同一套语义消费面板已有的 `sessions.list` 快照：`src/client/session-completion.js` 的 tracker 对齐宿主 `reconcileStatus` 的快照路径——首见只登记不标记（否则挂载即满屏绿点）；运行态 true→false 且非主视图会话（`retainedBy.mainView` 计数为 0）标记；主视图会话视为已读、切走不重点（没有新的完成跳变）；列表 phase 到 ready 后消失的会话清登记与标记，ready 之前不清（byId 可能暂时为空）。

### 绿点用宿主同一个 `StateDot`，不另画样式

`state: 'done'` 与官方会话行同一个基线 `ui-primitives` 组件、同默认尺寸（10px），视觉不需要任何自备 CSS。档位降序照官方 `sessionStatuses`：执行中（加载圈）盖过完成绿点；空闲不画点。

### tracker 随订阅 effect 同生命周期

实例化放在订阅 `useEffect` 里而不是组件顶层：订阅重挂（宿主重连）即重新开始跟踪，不把上一轮连接里看到的运行态当成这一轮的完成跳变。

## 边界

- 只有两档。官方的「待审批 / 待回答」橙点与子会话档来自 ui-session 的进程内投影与 pending 域服务，插件拿不到这两路状态，无从表达。
- 投影是单窗口进程内的：刷新或重连后从头开始，挂载前已空闲的会话不亮绿点。官方侧栏的完成提醒同为进程内投影，两边口径一致。
- 宿主事件路径里「列表基线 pending 期间首见空闲也算完成」的分支（`observeRunning` 的 `beforeBaseline`）不适用：插件只消费列表快照，观察不到基线之前的事件。
- 行提示走 title 后缀（「已完成，待查看」）：本仓会话行没有官方那套悬停卡，title 是唯一说明位。

## 验证

- `tests/session-completion.test.js` 8 例：首见不标记、完成跳变标记、完成时在主视图不标记、标记后打开清除且切走不重点、循环派工再标记、空闲快照不丢不补、ready 前后消失清理差异、缺 phase 容错。
- 双向验证：删掉 `unread.add(id)` 核心行 → 5 例红（完成跳变相关全挂）→ 还原 → 8 例绿。
- `tests/project-panel.test.js` 补两处接线断言：渲染档位嵌套三元（ongoing 先于 done）、tracker 在订阅 effect 内实例化且结果只经 `row.completed` 一条通道进渲染；全套单测 1051 例 0 fail。
- `tests/e2e/session-done-dot.e2e.js`（真实宿主 + mock）守完整时序：重启后已空闲的 worker 不凭空亮点 → running 圈出现后切到 leader → 完成跳变点亮绿点（title 带「已完成，待查看」）→ 打开熄灭。worker 靠 seed 登记表（`workers.json`）进项目树——归属判据是「目录 + worker 登记表」，工作区新建的普通会话不算。时序上 mock 加了 `stepDelayMs`（`mock-llm.mjs` 新参数，默认 0 不影响其他场景）：本地一轮只有几毫秒，「等 running 再切走」的两次页面动作插不进窗口，绿点判定是时序敏感的一次性跳变，错过不会重来。
- 场景偶发红在宿主已知竞态 `Sidebar Session opening failed … reference is released`（`SidebarSessionView.dispose` 抛出，栈里无插件帧，2026-11-03 decoupled 笔记有记录）。与那次「保持原样」的决策不同，本场景一个来回切三次视图，把该竞态的命中率放大到损害套件可用性（并发跑三连挂、串行也间歇红），因此在本场景窄豁免这一条消息样式（`HOST_VIEW_DISPOSE_NOISE`），其余 console.error 仍即失败。
- e2e 套件改**逐文件串行**（`package.json` 的 `e2e` 用 for 循环逐个 `node --test`）：node --test 跨文件并发在本地同时拉起 4 个 dsh 实例 + 4 个 chromium，负载把时序余量打穿，同一场景在不同步骤随机挂（done 不亮、ongoing 不出现各出现过）；`--test-concurrency=1` 则触发 node:test runner 的「Promise resolution is still pending」文件级误挂（三个场景文件 11 秒内全挂），不可用。串行后全套稳定。
- `npm run check` 全绿（含新文件覆盖率 100% 与文档预算）。
