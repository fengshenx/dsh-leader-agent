# leader 会话在项目树下独立出行

**范围**：`src/client/{project-section,project-panel-logic,icons}.js`、`tests/project-panel.test.js`、`tests/e2e/project-workspace.e2e.js`、`docs/{usage,architecture}.md`、`README.md`、`README_ZH.md`

## 背景

需求（issue #116）：项目行首的目录图标属于「项目本身」，不动；要换的是 **leader 会话的图标**，换成九宫格。

改之前项目树里没有这个渲染点：`selectProjectSessionRows` 遇到 `leaderSessionId` 直接跳过，leader 不单独出行，项目名就是它的唯一入口。所以「给 leader 换图标」实际是「先让 leader 在列表里有一行」。

## 决策

### leader 行由独立选择器取，固定第一行、不参与水位折叠

`selectLeaderSessionRow` 只读 `sessionRows[leaderSessionId]`，`selectProjectSessionRows` 继续排除 leader。没有把 leader 行塞进 worker 那一份：那份要过 `foldSessions` 的水位折叠，leader 被折进「展开其余」就等于没加这一行。归档 leader 与快照里还没有的会话都返回 `undefined`，项目树里不出现空壳行。

### 选中态从项目行搬到 leader 行

`isLeaderCurrent` 删除，项目行不再有 `data-selected`；选中态回到会话行的通用规则 `row.id === currentSessionId`。理由是同一个当前会话现在有两行可放底色，原来是「leader 只能在项目行上亮」的历史妥协。搬走之后分层与宿主工作区树一致：项目行只点亮行首文件夹（`data-active`），整行底色归会话行。

代价：项目行不再有 `aria-current`。读屏用户从会话行拿到同样的信息。

### leader 行不给归档入口

`SessionRow` 的归档按钮是「从列表移除 + 摘掉卡片槽位」。对 leader 用同一个动作等于让项目失去 leader（`isProjectOpenable` 变假），而换人有自己的出口——项目行的「换新 Leader」。所以 `leader === true` 时不渲染那一块。

### 项目行行首加载圈只在收起时出现

`showsProjectActivity` 改成 `expanded` 优先短路。原来的判据写着「leader 跑起来时任何展开状态都算亮」，其前提是 leader 没有自己的行、行首是唯一提示；现在 leader 行自己带 spinner，两处同画会被读成两件在跑的事。收起时 leader 行不可见，行首照旧代显（`leaderRunning` 入参保留）。

### 九宫格自绘，不借宿主带加号的字形

宿主 `artwork.ts` 没有纯九宫格：`apps-add-outline` 与 `apps-add-compact-outline` 都是 3 个格子加一个「+」，放在会话行首会被读成「新建会话」。`icons.js` 里新增 `apps-grid-fill`：九个 2.4px 圆角方块（`rx` 0.6），步长 5、边距 1.8，填充不描边，与宿主同一套 16 box 口径。

## 边界

- **标题宽度**：行首槽位从「只放运行圈」变成「常驻一个 16px 图标」，同一条会话标题早 16px 截断。
- **旧 leader 不带标记**：勾选只认 `project.leaderSessionId` 与快照行，不看会话角色；被换下的 leader 仍按普通会话列在下面，这是既有口径。
- **两条打开路径并存**：点项目行与点 leader 行都打开同一个会话。项目行承担「打开项目」，leader 行承担「在列表里认出它」。
- **图标与宿主视觉耦合**：`apps-grid-fill` 是本仓自绘的，宿主没有对应字形，不会随宿主图标更新而变化；`folder-*` 系列仍与宿主同步。
- **没有 lint 兜底**：这次改动删掉 `const selected` 后漏改了同组件里的 `aria-current`，`node --check` 与单测都不报错，只有 e2e 表现为「项目行整块不渲染」。改动后必须手扫被删变量的引用（见 `AGENTS.md` 的测试小节）。

## 验证

- 单测：`tests/project-panel.test.js` 新增「leader 会话行单独取，且不混进 worker 列表」「leader 行取不到时返回 undefined」「leader 行固定第一行、行首九宫格、不给归档入口」三条；`showsProjectActivity` 的展开分支断言由 `true` 改为 `false`（两条）。`npm run check` 全绿：49 个用例在 `project-panel.test.js`，全仓 1065 通过。
- 双向验证一：把 `showsProjectActivity` 的两个 `if` 换回原顺序（`leaderRunning` 先判）→「行首加载圈的合成判定」「项目行展开后不再代显任何运行态」两条变红；还原后 49 全绿。
- 双向验证二：把渲染里的 `leader: true` 改成 `false` → e2e `project-workspace` 在 `data-leader` 与九宫格 svg 两处断言上失败；还原后通过。
- e2e：断言并进 `tests/e2e/project-workspace.e2e.js`（真实 `dsh web` + 本地 mock）：同一个项目场景里先展开列表，断言第一行 `data-session-id` 等于 leader 会话、`data-leader="true"`、行首 `.dsh-leader-agent-session-leader-icon svg` 恰好 1 个、行内没有归档按钮。没有单开文件：每个 e2e 文件各自起两次实例，多一个文件后并发跑到 7 个场景时，既有的 `project-workspace` 两次全量各挂一次（15s 等引导卡超时），退回 6 个场景全绿——并发压力买不到新信息。全量 `npm run e2e` 6/6 通过。
