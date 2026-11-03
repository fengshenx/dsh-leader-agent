# 未分组组头改按会话快照判空，不再读 DOM

## 背景

用户报告：删掉项目目录或工作区后会话「消失」，卸载插件「未分组」就回来。上一次修复（#105）只处理了「项目目录失效后仍排除它的会话」这条，判据仍是 DOM：从 `[data-row-key="workspace:"]` 往上找分组容器，数容器里的会话行，全被隐藏才藏组头。

在 rc.5 的真实数据上验证这条判据不成立。宿主把未分组的组头与会话行分在不同层，`groupSectionOf(header)` 找不到「直接子元素里有 `overflow:` 按钮」的容器时回落到 `header.parentElement`（宿主 `HoverCard` 包出来的 `span`），那个容器里永远没有会话行；再叠上折叠（每组只渲染 5 行 + 展开按钮）与渲染时机，`querySelectorAll('[data-row-key^="session:"]')` 恒为空，判空恒为真。结果是**无条件给组头加 `display: none !important`**——用户看到的是未分组整组消失，卸载插件就回来。

实测读数：修复前组头 `class` 带 `dsh-leader-kit-empty-ungrouped`、`display: none`，而未分组的 `groupSection` 里确实有 0 行可查；同一页面里宿主自己的会话列表（`/api/session/list`）返回 285 条、9 条 `cwd` 指向被删目录且 `blank=false`——数据在，只是 DOM 上查不到。

## 决策

### 判据搬到会话快照

`ungroupedVisibleCount` 用 `sessionRows`（宿主 `sessions.list` 快照）+ `workspaceItems` + `excluded` + `archivedSessionIds` + `currentSessionId` 数「未分组里还剩几个没被排除、宿主会渲染的会话」，经 `exclusion.update` 传给渲染层；`markUngroupedHeader` 只看 `visibleCount === 0 && !anyVisibleOverflow`。

口径照宿主 `sessionVisible`：不在任何工作区、`origin !== 'subagent'`、未归档、不是「非当前的空会话」。`ungroupedExcludedCount`（折叠按钮的数字修正）与 `ungroupedVisibleCount` 共用 `ungroupedSessionIds`，两个数同源，否则按钮数字与组头显隐会各算一套。

DOM 上只留一条保护：还有可见的「展开其余 N 个会话」就不藏。宁可留一个空组头，也不误伤用户自己的会话。

### 项目列表加低频轮询

`directoryUsable` 只在 `refresh()` 时算，而 `refresh()` 原本只在挂载、通道就绪、窗口聚焦与增删改之后跑。用户在文件管理器或终端里删目录，既不产生会话事件也不产生焦点事件，排除集就一直停在「目录可用」上——`project-directory-gone.e2e.js` 里靠手工派发 `focus` 事件才通过，那个事件正是掩盖缺陷的东西。改成每 5 秒重读一次项目列表，页面不可见时跳过、切回可见立刻补一次。

`refresh` 用 `sameProjectList` 比较渲染字段，值没变就不 `setState` 也不广播——否则每 5 秒都会重渲染整棵项目树并通知右栏。

### 不做的

不在渲染层复刻宿主的渲染时机（折叠、虚拟滚动、分组顺序）。那等于把宿主的排版实现写进插件，每换一版都要重新对一次；快照计数与排版无关。

## 边界

- 快照计数依赖 `sessionRows` / `workspaceItems` 的新鲜度：宿主缓存旧值时组头会按旧值显隐一帧。
- 目录状态最坏滞后一个轮询间隔（5 秒）；页面不可见时更久，切回可见立刻补。
- 会话能否「落到未分组」仍由宿主决定（删工作区只删注册，会话记录保留）；本仓只管不把它们藏掉。

## 验证

- 单测：`tests/workspace-exclusion.test.js` 31 条（新增「未分组可见数只数没被排除的会话」「未分组只剩被排除的会话时可见数为 0」「组头容器里查不到行也按会话快照保留组头」）、`tests/project-panel.test.js` 47 条（新增 `sameProjectList` 的等价判定，含目录失效、顺序变化与旧版宿主无字段）、`tests/projects-service.test.js` 52 条（`directoryUsable` 标注）。`npm run check`：1048 用例通过 / 17 跳过，71 个源文件、55 个被加载、47 个行覆盖 100%；`src/client/workspace-exclusion.js` 行覆盖 85.42%，门槛 84 → 85。
- e2e：`tests/e2e/ungrouped-header.e2e.js` 走界面删工作区造松散会话，断言未分组组头无 `dsh-leader-kit-empty-ungrouped`、`display` 不是 `none`、会话行可见。单跑 3.1 秒；全量串行 6 条全绿。
- 双向验证：把传给渲染层的可见数固定成 0（等价于旧的 DOM 判空恒真）→ e2e 在「未分组里还有会话时不能给组头加隐藏类」变红（`true !== false`）→ 还原 → 变绿。
- `project-directory-gone.e2e.js` 去掉删目录后手工派发的 `focus` 事件后仍然通过（7.6 秒），证明轮询真的兜住了这件事；把轮询间隔调到 60 秒，同一条用例 30 秒超时变红。
