# 项目目录的工作区行一直可见：渲染层不再藏它

2026-11-02。

## 背景

加项目会顺带把目录注册成 dsh 工作区（协调者会话要归属分组，见 [项目自带一个工作区](2026-11-02-project-owns-workspace.md)）。此前客户端按项目记录的 `workspaceId` 在左栏工作区树里把这一行**整组藏掉**（[工作区行可见性由项目侧决定](2026-10-30-quiet-workspace-activation.md)），理由是项目区块里已经有同一个目录。

实测反馈：加项目后工作区树里找不到这个目录，之后手动再加同目录也看不到。后者不是巧合——宿主 `WorkspaceRegistry.create` 对同一 canonical 路径幂等（`packages/workspace/workspace/src/index.ts:222-244`），返回的是同一个工作区 id，仍然命中隐藏集合。也就是说**没有任何操作路径**能把藏掉的那一行变回可见，除非先去工作区管理面板删掉它再加回来。

被藏掉的一行还带走了一个真实入口：用户在项目目录里手动开的会话不属于项目（不进项目树），原本只能从官方工作区树打开，工作区行藏掉后左栏就没有入口了。

## 决策

### 工作区行一直可见，渲染层只排会话行

删掉「按 `workspaceId` 藏工作区行」这一层：`collectHiddenWorkspaceIds`、`HIDDEN_WORKSPACE_CLASS`、`HIDDEN_GROUP_ROW_CLASS`、`markGroupRows` 与组内行的连带隐藏全部移除。`workspace-exclusion.js` 现在只做两件事——按会话 id 排除协调者/worker 行，以及当前会话属于排除集时压掉承载它的工作区激活态。

`workspaceId` 的语义随之收窄：它只表示「这个工作区是随项目建的」，用于删项目时一并摘掉（`removeProjectWorkspace`）与重建提示，不再驱动任何可见性判断。

### 为什么不选「手动添加之后才可见」

另一种可接受的行为是：默认不显示，用户手动把目录加成工作区后才显示。宿主侧拿不到信号——`create` 幂等复用同一条记录，既不新建 id 也不改标题，插件无法区分「用户刚手动加的」与「一直就在的」。要靠这个行为，只能在客户端拦发布区工作区面板的添加动作，而那是宿主 UI、没有第三方扩展点。

### 激活态压灰保留

工作区行可见了，但组内的协调者与 worker 行仍被排除（它们由项目区块呈现）。官方按数据层点亮「当前会话所在分组」，点亮的分组里找不到可见的会话行，所以仍把图标压回三级标签色。工作区行可见不改变这条判断的成立条件。

## 边界

- 同一个目录在左栏出现两行：项目区块一行、官方工作区树一行。这是用户接受的形态——项目行是协调者入口，工作区行是目录入口。
- 分组行上的会话计数仍包含被排除的协调者/worker 行，数字与可见行数对不上（既有代价，与 [官方树排除](2026-11-02-project-owns-workspace.md) 一致）。
- 删除项目仍会摘掉随项目建的那个工作区（宿主 `delete` 只删注册，目录与会话日志都在）。工作区行现在可见，用户更可能注意到它被移除——确认弹窗的文案已经讲清这一点。
- 工作区被用户在管理面板删掉后的重建路径不变，提示条仍在：触发点在项目行上，用户未必注意左栏多回一行。
- 用户先自己有同目录工作区、再加项目时，`ensureWorkspace` 复用且不记 `workspaceId`，删项目不动它——这条与之前一致，只是现在两种情形在左栏看起来相同。
- 反向撤不回：把工作区行藏起来的行为已经删除，没有留下开关。

## 验证

- `npm run check`：639 tests / 639 pass / 0 fail（rebase 到 116ecad 后读数）。构成：base 87d2963 有 610 条，本 PR 删 7 条与藏行相关的用例（`workspace-exclusion.test.js` 6 条：2 条工作区行藏行 + 4 条组内行连带隐藏；`project-panel.test.js` 1 条藏行集），新增 2 条（「工作区行不被整行隐藏」+ 覆盖真实标记路径的「真实标记路径下工作区行只带压灰类」），净 -5；rebase 把 main 侧新增的 34 条（拖拽排序、`npm start`、agent-team 护栏等）一起带进来。
- 双向验证（单测）：给 `markWorkspaceRow` 临时加回 `row.classList.toggle('dsh-leader-kit-hidden-workspace', true)` → 2 条变红（11 pass / 2 fail）；给真实标记路径 `markRows` 加回同一句 → 「真实标记路径…」变红（12 pass / 1 fail）；还原 → 13 条全绿。
- `npm run build:client` 重建产物，`grep hidden-workspace lib/client.js` 零命中。
- 真机（隔离 dev 实例，`.dev/home` 里已有一个带 `workspaceId` 的项目；无头 Chrome 走 CDP 读 `[data-row-key^="workspace:"]` 的 `getComputedStyle().display`）：

  | 检查项 | 修复前 | 修复后 |
  |---|---|---|
  | 项目自建的工作区行（4 行工作区里承载项目的那个） | `display: none` | `display: flex` |
  | 其余工作区行 | `display: flex` | `display: flex` |
  | 被排除的项目会话行 | `display: none` | `display: none` |
  | 项目区块 | 正常渲染 | 正常渲染 |

  修复前读数用「临时把隐藏类与样式加回 → 重建 → reload」取得，还原后重读回到 `flex`；页面 `Runtime.exceptionThrown` / console error 计数 0。承载被排除会话的那一行仍带 `dsh-leader-kit-quiet-workspace`，激活态压灰按原设计保留。

