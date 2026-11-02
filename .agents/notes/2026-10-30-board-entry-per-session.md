# 看板入口按会话过滤，看板对项目 worker 开放

## 背景

用户报告：右栏「开始」页里，普通会话也能看见「看板」入口。这与「只有协调者与 worker 的会话才有看板」的预期不符。

两件事叠在一起：

1. **入口从来是全局的**。宿主右栏的 tab 类型与 guide 入口是静态注册，注册表没有按会话过滤的扩展点（`docs/capability-gaps.md` 第 15 条；上一版决策也记过这条限制）。`2026-10-29` 的 note 只收紧了自动弹出与面板内容，入口本身对所有会话可见。
2. **看板内容在 #19 被收紧到协调者**，worker 打开也是一句「看板只在项目协调者会话中打开」。用户对「项目会话有看板」的预期里包含 worker。

## 决策

### 入口由本插件接管渲染

`sidebar.right.tab.guide.entry` 是 keyed slot，键是 tab 类型的 `providerId`（本插件是 `dsh-leader-kit`）。注册自己的渲染器后，guide 页里这一枚胶囊由本插件画：项目会话画，其余返回 `null`。

- 胶囊样式复刻宿主 `EntryBox`（`ui-sidebar-right` 的 `GuideBody.module.css`）：380px 宽、56px 最小高、14/20 内边距、14px 图标间距、`--dsw-radius-xl` 圆角、`--dsw-alias-*` 令牌。宿主改版式时本仓要跟——这是接管渲染的固定成本，与「图标从宿主 artwork 抄路径」同类，写进 capability-gaps 第 15 条。
- 点击只走 `tab.actions.openTab(kind, { replaceTab: true })`：rc.2 的 tab 级 `openTab` 把 `replaceTab` 换成同 kind 的 tab id，service 在同一次调用里关掉被替换的 tab。**不要再补 `tab.actions.close()`**——那行是 no-op，还会让后来者以为替换要手动关。
- 入口可见性按**身份**判，不照抄面板的视图状态：`isCoordinatorProject(project, sessionId) || isWorker === true`。协调者已失效时项目会话的入口保留——点开是「去左栏换新协调者」的引导，藏起来等于把出口也藏掉；但同目录的普通会话在同一个「协调者失效」状态下**不画**入口（面板侧给它们失效引导是 #19 的有意设计，入口不该照抄那个出口）。
- 胶囊保留宿主的 `data-sidebar-right-guide-entry={kind}`（`EntryBox` 用的是 `entry.kind`）：插件无快捷键，`aria-keyshortcuts` 无所谓，但真机取证与后续 e2e 靠这个标识认入口。

### 看板对项目会话开放

`boardViewState` 增加 `worker` 出口：项目协调者与该项目派出的 worker 都可看板，同目录里的普通会话仍不可看（提示去协调者或 worker 会话）。

worker 判定走 `projects/sessionsByProject`：worker 是普通根会话，会话头没有身份标记，只有宿主侧的 worker 登记表知道谁是 worker。客户端一次问全量再按 `projectId` 查表，比按会话逐个问省往返。

**判不出来按普通会话处理**（`fetchProjectWorkers` 失败、`sessionQuery` 缺失、worker 表里没有该会话）：宁可把入口藏起来，也不给一个没权限的会话画入口。

### 入口与面板共用 `resolveBoardAccess`

项目解析 + worker 身份收敛成一个纯函数（`resolveBoardAccess(callRemote, sessionId)` → `{ project, worker }`），入口与面板都读它，口径只有一处。三件具体的事：

- **worker 表失败单独兜底**：`resolveBoardAccess` 内部把 `sessionsByProject` 的失败按 `worker: false` 处理（fail closed）。此前入口与面板各自 await，面板那次失败会被 `.catch` 记成「读取项目失败」，文案指向错误原因，且 worker 保留上一次的值。
- **身份未判定不进 `not-viewable`**：`boardViewState` 的第三参是 `boolean | undefined`，`undefined` 表示「还没问出来」，返回 `pending`，面板给骨架。默认 `false` 会让 worker 首帧落进「看板只在项目会话中打开」——一句阶段性错话，恰好打在最容易误导 worker 的位置。
- **项目解析失败照常抛出**：那是「有没有项目」都答不上来，调用方自己决定重试还是显示错误。

### 复核节奏

面板的 30 秒项目复核顺带刷新 worker 判定（`load()` 走 `resolveBoardAccess`，非协调者才多问一次 worker 表），卡片取数 effect 的依赖加上 `worker`。项目与身份同一批落地，中间没有「有项目但身份未知」的渲染。

guide 入口在四类时机重判：

1. **挂载 / 会话切换**；
2. **通道就绪**（订阅 `onProjectRemoteReady`，与 `coordinator-view.js`、`project-panel.js` 同一模式）——guide 页常比 `$mount` 先画出来，挂载那一次必然失败，只靠聚焦重试会让入口长时间不出现；
3. **窗口聚焦**——项目可能在另一个窗口里被建出来或换过协调者；
4. **项目有变**（`src/client/project-changes.js` 的进程内广播）——左栏项目区块的 `refresh()` 成功后广播，注销项目、换协调者之后入口跟着更新，不留「点开说不属于任何项目」的胶囊。不用 `ready-signal.js`：那是「就绪一次」的信号，项目可以反复增删。

## 边界

- **guide 的 More 菜单仍会列出「看板」**：`sidebar.right.tab.guide.actions` 是 root scope，拿不到会话，入口名单无法按会话过滤。用户点 More 里的看板仍能打开面板（面板自己会给提示）。要彻底消除需要宿主给 guide 入口加条件注册。
- **隐藏时外层 cell 仍渲染**：`GuideBody` 用 `.entryCell`（380px 宽、flex 列里 14px gap）包住每个入口的渲染结果，插件只能返回 `null`，没法让 cell 一起消失。普通会话的指南页因此可能多出约 14px 的列内间距，视觉上是一次轻微居中偏移。
- **入口判定是异步的**：每次挂载要一次 `resolveProject`，非协调者再一次 `sessionsByProject`；判完之前不画（不闪一个会消失的入口）。每次聚焦与每次项目广播都会重问，没有节流——切窗口频繁时有放大，量级是两条 RPC。
- **项目变更广播只覆盖本进程**：左栏项目区块挂载时才会有广播。侧栏收起（面板卸载）或另一个窗口里改了项目，入口要等窗口聚焦才更新；宿主没有给客户端项目存储的变更事件。
- **入口是组件层，没有守卫用例**：本仓只测纯函数（`resolveBoardAccess` / `isBoardEntryVisible` / `boardViewState`），没有 jsdom 与 React 测试。双向验证覆盖的是纯函数那一层：把 `isBoardEntryVisible` 改成恒 `true` 或用视图状态重写，对应用例变红；把组件里 `setVisible(...)` 改成恒 `true` 不会红。组件行为靠 dev 实例真机取证。
- 面板内容仍以项目为单位：worker 看到的是同一张项目看板，不是「自己那几张卡」。

## 取舍

- 接管渲染换来入口诚实，代价是胶囊样式与宿主耦合；不接管则普通会话永远有一枚点开即空的入口。
- 把 worker 放进可看范围，推翻 #19 的「只属于协调者」：项目看板对项目内的会话可见是更自然的语义，协调者仍持有调度权（工具面与派工权限不变）。

## 验证

- `tests/project-board-data.test.js`：`boardViewState` 的六种出口（含 `pending`）、`isBoardEntryVisible` 与「协调者失效 × 协调者 / worker / 普通会话」三条出口、`resolveBoardAccess`（协调者不问 worker 表、普通会话与 worker 都问、worker 表失败兜底、项目解析失败抛出）、`fetchProjectWorkers` / `isProjectWorker`。
- `tests/project-changes.test.js`：退订生效、单个订阅者抛错不打断其余订阅者。
- 双向验证（逐项撤销修复 → 对应用例变红 → 还原全绿）：`isBoardEntryVisible` 改回按视图状态判 → 「协调者失效三条出口」变红；删掉 `pending` 出口 → 「身份未判定」变红；`resolveBoardAccess` 去掉 worker 表兜底 → 对应用例变红；`fetchProjectWorkers` 放行空 `projectId` → 归组用例变红。
- `npm run check`：470 项通过；`npm run build:client` 产物含 `sidebar.right.tab.guide.entry`、`data-sidebar-right-guide-entry`，且不再出现 `tab.actions.close()`。
