# Agent Note: 看板入口按会话过滤，看板对项目 worker 开放

Status: implemented

## Problem

用户报告普通会话在右栏「开始」页也能看见「看板」入口。两件事叠在一起：入口从来是全局的——宿主右栏的 guide 入口是静态注册，注册表没有按会话过滤的扩展点（`docs/capability-gaps.md` 第 15 条）；而看板内容此前收紧到只给 leader，worker 打开只得到一句「看板只在项目协调者会话中打开」，可用户对「项目会话有看板」的预期里包含 worker。

## Decision

- **入口由本插件接管渲染**：`sidebar.right.tab.guide.entry` 是 keyed slot，键是 tab 类型的 `providerId`；注册自己的渲染器后，项目会话画，其余返回 `null`。胶囊样式复刻宿主 `EntryBox`（宽高、内边距、图标间距、圆角与 `--dsw-alias-*` 令牌），宿主改版式时本仓要跟——这是接管渲染的固定成本，写进 capability-gaps 第 15 条。
- **点击只走 `tab.actions.openTab(kind, { replaceTab: true })`**：它把同 kind 的 tab 换掉并在同一次调用里关掉被替换的；不要再补 `tab.actions.close()`，那行是 no-op，还会让后来者以为替换要手动关。
- **入口可见性按身份判，不照抄面板的视图状态**：`isLeaderProject(...) || worker`。leader 失效时项目会话的入口保留——点开是「去左栏换新 leader」的引导，藏起来等于把出口也藏掉；同目录的普通会话在同一个失效状态下不画入口。退役 leader 即使仍解析得到项目也不给入口——它不再指挥这个项目。
- **保留 `data-sidebar-right-guide-entry={kind}`**：插件无快捷键，但真机取证与 e2e 靠这个标识认入口。
- **看板对项目会话开放**：`boardViewState` 增加 `worker` 出口，项目 leader 与该项目派出的 worker 都可看板，同目录普通会话仍不可看（提示去 leader 或 worker 会话）。
- **worker 身份走 `projects/sessionsByProject`**：worker 是普通根会话、会话头没有身份标记，只有宿主侧登记表知道；客户端一次问全量再按 `projectId` 查表，比按会话逐个问省往返。判不出来按普通会话处理（fail closed）：宁可把入口藏起来，也不给没权限的会话画。
- **入口与面板共用 `resolveBoardAccess`**：项目解析 + worker 身份收敛成一个纯函数，口径只有一处。三件具体的事：worker 表失败在函数内部按 `worker: false` 兜底（此前两处各自 await，面板那次失败会被记成「读取项目失败」，文案指向错误原因）；身份未判定不进 `not-viewable`（`undefined` 返回 `pending`，面板给骨架，默认 `false` 会让 worker 首帧落进「看板只在项目会话中打开」）；项目解析失败照常抛出——「有没有项目」都答不上来，由调用方决定重试还是显示错误。
- **复核节奏**：面板的 30 秒项目复核顺带刷新 worker 判定，卡片取数 effect 的依赖加上它，项目与身份同一批落地，中间没有「有项目但身份未知」的渲染。guide 入口在四类时机重判：挂载 / 会话切换；通道就绪（guide 页常比挂载先画出来，只靠聚焦重试会让入口长时间不出现）；窗口聚焦（项目可能在另一个窗口里建出来或换过 leader）；项目变更广播。不用 `ready-signal.js`：那是「就绪一次」的信号，项目可以反复增删。

## Alternatives considered

- **入口继续全局注册**：普通会话也能看到「看板」，点开是空的；没有按会话过滤的扩展点，只能接管 keyed slot。
- **leader 失效时把入口藏掉**：点开是「去左栏换新 leader」的引导，藏起来等于把出口也藏掉。
- **入口可见性照抄面板视图状态**：面板状态不知道会话身份；收敛到 `resolveBoardAccess`。
- **worker 身份未知时先放行**：会给没权限的会话画入口；判不出来按普通会话处理（fail closed）。

## Consequences

- **guide 的 More 菜单仍会列出「看板」**：`sidebar.right.tab.guide.actions` 是 root scope，拿不到会话，入口名单无法按会话过滤；点进去面板自己会给提示。要彻底消除需要宿主给 guide 入口加条件注册。
- **隐藏时外层 cell 仍渲染**：宿主用 `.entryCell` 包住每个入口的渲染结果，插件只能返回 `null`，普通会话的指南页因此多出一点列内间距，视觉上是一次轻微居中偏移。
- **入口判定是异步的**：每次挂载要一次 `resolveProject`，非 leader 再一次 `sessionsByProject`；判完之前不画（不闪一个会消失的入口）。每次聚焦与项目广播都会重问，没有节流。
- **项目变更广播只覆盖本进程**：侧栏收起（面板卸载）或另一个窗口改了项目，入口要等窗口聚焦才更新；宿主没有给客户端项目存储的变更事件。
- **入口是组件层，没有守卫用例**：本仓只测纯函数，没有 jsdom 与 React 测试，组件行为靠 dev 实例真机取证。
- **接管渲染的取舍**：换来入口诚实，代价是胶囊样式与宿主耦合；不接管则普通会话永远有一枚点开即空的入口。把 worker 放进可看范围推翻了「只属于 leader」，但 leader 仍持有调度权。
- 面板内容仍以项目为单位：worker 看到的是同一张项目看板，不是「自己那几张卡」。

收益：看板入口只在项目 leader 与 worker 上出现，点击直达，普通会话不再看到空入口。

## Testing

`tests/project-board-data.test.js` 钉住 `boardViewState` 的各出口、`isBoardEntryVisible` 的身份判据与 `resolveBoardAccess` 的兜底；`tests/project-changes.test.js` 钉住广播退订；双向：把入口改回按视图状态判、或删掉 `pending` 出口，对应用例变红。
