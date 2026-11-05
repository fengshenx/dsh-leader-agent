# 项目树会话行的完成绿点

## 背景

宿主左栏的官方会话行有「完成未读」绿点：会话从执行中转为空闲、且用户没在看它时点亮，打开后熄灭。项目的 worker 会话被渲染层排除出官方工作区树（`workspace-exclusion.js`），由项目面板自绘会话行呈现，而自绘行只画了运行中的加载圈——worker 跑完，项目树里毫无提示，用户只能逐个点开看。

## 决策

### 完成未读在插件侧自行投影，不找宿主要数据

绿点状态是宿主 ui-session 的进程本地投影（`completionUnread`，不落盘），不在任何对插件公开的服务上；把 `ui-session` 加进产物依赖也不可行——它不在宿主冻结模块表（`PLATFORM_MODULES`）的基线里，基线外宿主包不保证可用（见 client-side findings 笔记）。可行做法是照宿主同一套语义消费面板已有的 `sessions.list` 快照：`src/client/session-completion.js` 的 tracker 对齐宿主 `reconcileStatus` 的快照路径——首见只登记不标记（否则挂载即满屏绿点）；运行态 true→false 且非主视图会话（`retainedBy.mainView` 计数为 0）标记；主视图会话视为已读、切走不重点（没有新的完成跳变）；列表 phase 到 ready 后消失的会话清登记与标记，ready 之前不清（byId 可能暂时为空）。

### 绿点用宿主同一个 `StateDot`，不另画样式

`state: 'done'` 与官方会话行同一个基线 `ui-primitives` 组件、同默认尺寸（10px），视觉不需要任何自备 CSS。档位降序照官方 `sessionStatuses`：执行中（加载圈）盖过完成绿点；空闲不画点。

### tracker 随订阅 effect 同生命周期

实例化放在订阅 `useEffect` 里而不是组件顶层：订阅重建即重新开始跟踪，不把上一轮里看到的运行态当成这一轮的完成跳变。

### 订阅只在挂载时建立一次，props 经 ref 解引用

`getSessions` / `refreshSessionIndex` 都是 slot inject 的内联函数，宿主每次重渲染 occupant 都换新引用；把它们放进订阅 effect 的依赖，等于让宿主任何一次重渲染（实测：会话标题晚到就够）把订阅重挂——完成未读投影随之清零，跑完的绿点凭空消失。修复为 effect 依赖恒空、取值经 `useRef` 走最新一份；挂载早于会话服务就绪时轮询补挂（10 秒拿不到就 console.error，Fail Loud）。接线断言钉住这三件事（ref 存在、tracker 在 effect 内、依赖恒空）。

### 完成未读会话不被折叠

绿点是通知语义，被折进「展开其余 N 个会话」后面就看不见。`src/client/session-watermark.js` 的 `requiredWatermark` 照宿主注意力水位，除运行中外也认 `completed`，在前 50 条内把水位抬到它所在位置；长列表里「有子代理在跑」「等你输入」「当前会话」三档仍没有数据源，不参与。取舍：完成未读越多，展开的基线越高（最多 50 条），打开后投影清除、水位回落；不做则 worker 较多的项目里绿点基本不可见，与这个功能的目的冲突。

## 边界

- 只有两档。官方的「待审批 / 待回答」橙点与子会话档来自 ui-session 的进程内投影与 pending 域服务，插件拿不到这两路状态，无从表达。
- 投影是单窗口进程内的：刷新或组件卸载后从头开始，挂载前已空闲的会话不亮绿点。官方侧栏的完成提醒同为进程内投影，两边口径一致。
- 宿主事件路径里「列表基线 pending 期间首见空闲也算完成」的分支（`observeRunning` 的 `beforeBaseline`）不适用：插件只消费列表快照，观察不到基线之前的事件。
- 行提示走 title 后缀（「已完成，待查看」）：本仓会话行没有官方那套悬停卡，title 是唯一说明位。

## 验证

- `tests/session-completion.test.js` 9 例：首见不标记、完成跳变标记、完成时在主视图不标记、标记后打开清除且切走不重点、循环派工再标记、空闲快照不丢不补、ready 前后消失清理差异、缺 phase 容错、只迭代 `ids`（目录外的行不参与）。
- `tests/session-watermark.test.js` 8 例：新增完成未读抬水位、50 条上限对 completed 同样生效、`foldSessions` 让第 6 条完成未读露出。
- 双向验证：删掉 `unread.add(id)` 核心行 → 5 例红（完成跳变相关全挂）；撤掉 `requiredWatermark` 的 `completed` 分支 → 3 例红；绕开 `ids` 迭代 → 1 例红；各自还原后全绿。
- `tests/project-panel.test.js` 补两处接线断言：渲染档位嵌套三元（ongoing 先于 done）、tracker 在订阅 effect 内实例化且结果只经 `row.completed` 一条通道进渲染；全套单测 1082 通过 / 17 跳过。
- `tests/e2e/session-done-dot.e2e.js`（真实宿主 + mock）守完整时序：重启后已空闲的 worker 不凭空亮点 → running 圈出现后切到 leader（等行退出选中态确证视图释放）→ 完成跳变点亮绿点（title 带「已完成，待查看」）→ 打开熄灭。worker 靠 seed 登记表（`workers.json`）进项目树——归属判据是「目录 + worker 登记表」，工作区新建的普通会话不算。元素等待统一走 `waitForLocator`（预算随 #104 纪律，失败自动带页面读数），另补 mock 请求数与实例日志尾取证。worker 两轮在同一个会话里发消息，请求历史会带首轮 marker；两轮共用同一个 `MARKER_WORKER`、脚本排两步，重开 worker 后先等首轮历史「第一轮回执」上屏再发第二轮。修掉「两轮换 marker → `resolveMarker` 看到两个标记 → mock 400」后单场景连跑 5 次全绿（12.4 / 11.3 / 11.3 / 11.3 / 11.3 秒）。
- mock 的 `stepDelayMs`（`mock-llm.mjs` 新参数，默认 0 不影响其他场景）只负责把第二轮拉长到够「等 running 圈再切走」。提交版曾把偶发红归因到「3 秒踩 SSE 首事件超时」，实际根因是同一会话两轮换了 marker、历史里同时出现两个标记，mock 在 SSE 之前回 400，轮次没开始，绿点不可能亮；`scenario 请求数：3` 是 leader + 首轮 + 第二轮的正常次数，>3 才是宿主重发。
- 本场景一个来回切三次视图，会放大宿主已知竞态 `Sidebar Session opening failed … reference is released`（`SidebarSessionView.dispose` 抛出，栈里无插件帧，2026-11-03 decoupled 笔记有记录）。因此窄豁免这一条消息样式（`HOST_VIEW_DISPOSE_NOISE`），其余 console.error 仍即失败；该豁免与绿点不亮的根因（mock marker 400）是两件事。
- e2e 套件改**逐文件串行**（`package.json` 的 `e2e` 用 for 循环逐个 `node --test`）：node --test 跨文件并发在本地同时拉起 4 个 dsh 实例 + 4 个 chromium，负载把时序余量打穿，同一场景在不同步骤随机挂（done 不亮、ongoing 不出现各出现过）；`--test-concurrency=1` 则触发 node:test runner 的「Promise resolution is still pending」文件级误挂（三个场景文件 11 秒内全挂），不可用。串行后全套稳定。
- `npm run check` 全绿：1082 通过 / 17 跳过，新文件行覆盖 100%，`docs/usage.md` 5318/5600（余量 5.04%）。
