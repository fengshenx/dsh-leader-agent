# 工作区行的可见性由项目侧决定：藏掉项目自建的那个，压掉它的激活态

**日期**：2026-10-30
**状态**：accepted

## 背景

左栏的官方工作区树里，一个目录可以既是项目（项目区块）又是工作区。两件事都源自「渲染层没有跟着项目侧的判断走」：

1. **项目自建的工作区凭空多出一行**。加项目会把目录注册成工作区（协调者会话要归属工作区才能被官方界面打开），于是工作区树里出现一行用户没加过的目录——项目区块里已经有同一个目录。
2. **被隐藏的会话仍然点亮它的工作区**。用户在项目目录里手动开一个会话（分组点亮成蓝），再点项目行打开协调者，工作区图标**仍然是蓝的**，可那个分组里已经没有可见的会话行（协调者会话在渲染层被排除）。

第 2 条的根因是两套机制的边界没对齐：

- 官方按「当前会话属于哪个分组」点亮目录图标（`Rows.tsx` 的 `active = containsCurrentDescendant || (group.expanded && group.containsCurrent)`，颜色是 `.folderActive` 的 `--dsw-alias-state-business-primary`）；
- 本仓把项目的协调者与 worker 会话从官方树里隐藏（`workspace-exclusion.js`），但点亮判定仍按数据层算。

## 决策

两件都在 `workspace-exclusion.js` 的渲染层完成，官方数据层不动：

- **藏掉项目自建的工作区**：项目记录里的 `workspaceId` 只在插件自己注册工作区时写入（复用的用户工作区不记，见 `ensureWorkspace`），拿它当身份依据，给 `[data-row-key="workspace:<id>"]` 加 `dsh-leader-kit-hidden-workspace`（`display: none`）。工作区仍留在宿主数据里——协调者会话的归属与打开路径都靠它。**组内属于这一组的行跟着一起藏**（会话行、「展开其余 N 个会话」按钮，加 `dsh-leader-kit-hidden-workspace-group`）：组展开时它们是 header 的兄弟节点，只藏 header 会留下一批没有标题的孤儿行——而展开恰恰是常态，宿主打开协调者会话时自己就会展开这一组。嵌套分组的行不跟着藏，各自跟自己的 header 走。
- **压掉激活态**：当前会话（`sessions.list` 快照里 `retainedBy.mainView > 0` 的那条，与宿主 `mainSessionId` 同判据）落在会话排除集里时，从 `workspaces.list` 快照的 `items` 反查它所属的工作区，给那一行加类，CSS 把行首图标槽的颜色压回 `--dsw-alias-label-tertiary`（未激活时官方也是这个色，见 `Rows.module.css` 的 `.slot`）。

判定抽成纯函数（`project-panel-logic.js` 的 `collectHiddenWorkspaceIds` / `currentSessionIdOf` / `quietWorkspaceOf`）：面板只负责订阅两个快照并把结果喂给排除器（`update({ sessionIds, quietWorkspaceIds, hiddenWorkspaceIds })`）。

### 与前次决策的关系

本笔记**反转了 [项目与角色槽位](2026-10-23-project-scope-and-role-slots.md) 的「取消项目工作区的隐藏」一条**（2026-10-27 修订，来自 #9 / `dc43c63`）：那一次取消它，理由是「插件注册的工作区一藏，用户在项目目录里手动开的会话就两边都看不到」。本次恢复的是**收窄版**——只藏插件自己注册的那一个（按项目记录的 `workspaceId`），用户自己加的同目录工作区照常显示；代价仍然存在（手动会话不在项目树、也不在左栏分组视图里），退路是宿主搜索与「在一个列表里」视图。旧笔记的三处「现行事实」已在原地标注反转。

## 边界

- **只藏「插件注册的」工作区**。用户自己先加了同目录工作区、再建项目时，`ensureWorkspace` 复用那个工作区且不记 `workspaceId`——它照常显示。这条与「复用来的工作区不是我们的东西」一致。
- **项目目录里的手动会话只剩两条入口**。项目树只列 worker，工作区行藏掉后，用户在项目目录里手动开的会话不在左栏默认视图里；宿主的会话搜索与「一个列表里」视图仍能看到并打开它们。要让它们出现在项目树下，得把项目树从「只列 worker」改成「列整个目录的会话」——那是独立的行为变更，未在本轮做。
- **只在分组视图下压当前会话所属的那一组**。树模式（`groupBy: 'workspace-tree'`）下宿主会让**祖先分组**也点亮（`containsCurrentDescendant`），祖先行不会被压——浏览器侧拿不到分组层级与「当前会话的祖先链」的对应关系，扩展它要复制宿主的 `nestWorkspaces` 逻辑。
- **不改宿主数据层**。点亮与分组可见性都是宿主内部状态，没有对应接口；`groupExpansion` 这类视图状态是宿主插件内部的 store（持久化在 `dsh.workspace.view.v5`），第三方写它等于耦合宿主内部实现。
- **面板卸载即恢复原样**。排除器随项目面板挂载/卸载，侧栏收起时面板卸载，隐藏与会话排除一起失效——与既有排除机制同一生命周期。
- **两种标记都靠宿主 DOM 结构成立**，`engines.dsh` 却是 `>=0.2.1-rc.2 <0.3.0`：`data-row-key="workspace:<id>"` / `"session:<id>"` / `"overflow:<group>"`、分组容器的父元素带 `role="tree"`（顶层，`AnimatedRows`）或 `role="group"`（嵌套）、行元素外面包一层 HoverCard 的 `span`、图标槽是行的第一个 `span`、颜色令牌 `--dsw-alias-label-tertiary`。宿主改任一处，压灰或藏行会**静默失效**（症状只会是「又变蓝了」「又冒出来了」），没有测试和启动自检能发现。核对方法：逐 tag 对照 `packages/client/ui-workspace/src/client/rows/` 的 `Rows.tsx`（行结构与 `data-row-key`）、`WorkspaceBrowser.tsx`（`groupSection` 与 `div[role="group"]`）、`AnimatedRows.tsx`（列表容器的 `role="tree"`）与 `ui-primitives/src/HoverCard.tsx`（包裹 `span`）；rc.2 / rc.3 / rc.4 / rc.5 逐条核过，当时未漂移。
- **两份快照没到齐时不压灰**。`quietWorkspaceOf` 依赖会话快照（`retainedBy`）与工作区快照（`items`，`phase: 'pending'` 时是空数组）两份异步数据，任一份落后时返回 `undefined`：图标先蓝着，快照到了才变灰。这是安全方向的退回——宁可少压一次，不会压错行。
- **`quiet` 类在右侧面板激活时也可能挂着**。宿主算「当前会话」时还看 `panelActive`（右侧面板打开时认为没有当前会话，不点亮任何分组），本仓不看——那属于宿主的视图 store，读它等于耦合内部状态。因为 `quiet` 只把颜色压回未激活色，两种判定下视觉一致，无副作用。
- **判定随当前会话变化**。用户在官方树里点回一个正常会话，压灰在同一个 `sync` 里撤销（会话快照已就绪的前提下；见上一条）。

## 验证

真机（隔离实例，宿主 `dsh 0.2.1-rc.2`，无头 Chrome 走 CDP 探针，`window-size=1440,900`）：

| 检查项 | 修复前 | 修复后 |
|---|---|---|
| 插件注册的项目工作区 `hide-demo` | `display: flex`（出现在树里） | `display: none` + `hidden-workspace` 类 |
| 用户自己的同目录工作区 `hide-user` | `display: flex` | `display: flex`（不受影响） |
| 打开组内普通会话后点项目行打开协调者 | `folderActive`，`rgb(65, 118, 230)`（仍蓝） | `folderActive` + `quiet` 类，`rgb(129, 133, 140)` |

撤销方式：把 `markWorkspaceRow` 的命中判断换成 `false`、把 `collectHiddenWorkspaceIds` 改成返回空集，各自重建产物后读数分别回到 `rgb(65, 118, 230)` 与 `display: flex`；还原后两种标记重新生效——双向成立。

**组内行跟着藏**（B1，分支 head `8a4a51f` 之后的修复）：这一条只有 DOM 桩单测，没有 GUI 读数——真机取证里那个分组没有「被藏的工作区 + 已展开 + 有会话行」的样本。结构依据是宿主源码：组内会话行与「展开其余 N 个会话」按钮是 header 的兄弟节点（`WorkspaceBrowser.tsx` 的 `groupSection` 里 `<ProjectRowItem>` 与 `sessions.map(…)` 同级），只藏 header 会留下没有标题的孤儿行。

单测新增 15 条（分支累计）：`tests/workspace-exclusion.test.js` 10 条（压灰 3 条 + 藏行 2 条 + 两类行各认各的前缀 1 条 + 组内行跟着藏 4 条），`tests/project-panel.test.js` 5 条（藏行集只取插件注册的、当前会话取 `mainView` 那条、被排除时压灰、没被排除/不在工作区视图里时不压）。`npm run check` 485 全绿（合并 main 后的总数：#24 带来 10 条，本分支 15 条）。

双向验证：撤掉 `markGroupRows` 的标记那句 → 「组内会话行一起藏」「重新显示不残留」「嵌套分组不跟外层藏」3 条变红；撤掉嵌套分组过滤那句 → 「嵌套分组的会话行不跟着外层分组一起藏」1 条变红；还原 → 17 条全绿。

未 GUI 实测的部分：树模式下的祖先分组点亮（见边界）、组内行跟着藏（见上）。

**复现真机读数**：起隔离实例（`DSH_HOME=/tmp/dsh-verify-home`，宿主 `dsh 0.2.1-rc.2`，mock/keyless provider），`window-size=1440,900` 开无头 Chrome 走 CDP；建一个项目 → 在项目目录里手动开一个会话并展开该分组 → 点项目行打开协调者 → 读 `document.querySelector('[data-row-key^="workspace:"]')` 所在行的图标槽 `getComputedStyle().color`（`rgb(65, 118, 230)` 是点亮，`rgb(129, 133, 140)` 是压回未激活色），再用同一元素的 `display` 确认藏行。

