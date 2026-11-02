# 项目自带一个工作区：会话归属数据层，隐藏留在渲染层

2026-11-02。同一个分支上先试过「项目与工作区彻底分离」（`af57681`），本轮把它推翻，理由与边界记在这里，省得再走一遍。

## 走过的弯路

解耦那版让协调者会话只带 `cwd` 建、不归属任何工作区。技术判断没错——`openSession` 只按会话 id retain（`ui-workspace/src/client/navigation.ts:523-553`），不归属的会话照样能在主区域打开。问题出在**左栏的位置**：不归属就落官方树的「未分组」，把会话行在渲染层藏掉之后，那里剩一个空组头。

想连组头一起藏，就得回答「这个组里还有没有别人的可见会话」，而要回答它必须复刻宿主的可见性规则：`blank && id !== current` 不渲染、归档会话默认不进组、当前会话例外（`ui-workspace/src/client/tree.ts:229-248`）。那等于把会话生命周期搬进插件，和宿主状态迟早漂移——这条放弃了。

## 现在的形态

- **建项目 = 建工作区**：`ensureWorkspace` 按 canonical 目录查，没有就 `create`，只有自建的那个记进项目记录 `workspaceId`（复用的用户工作区不记、不藏、删项目时不动）。
- **协调者会话直接归属**：`createCoordinatorSessionWithCtx` 走 `sessionController.create({ workspaceId })`，cwd 由工作区 path 给出，仍是项目目录——「会话在 `~/.dsh/sessions/<cwd>/` 下」这条不变。
- **worker 也归属**：`agents.create` 不接受 workspaceId，所以建完由 `attachToWorkspace` 挂进去（fire-and-forget：归属只影响分组，挂失败只记日志，不拖累派工）。派工侧经 `resolveWorkerWorkspaceId` 从项目记录取工作区。
- **隐藏仍在渲染层**：项目工作区整组藏掉（行 + 组内行 + 展开按钮），协调者/worker 会话行也藏。理由见 `docs/capability-gaps.md` 第 32、33 条：会话没有「侧栏不显示」字段，`origin` 只允许 `subagent`，归档会把会话拦在 `agent/pre-step` 之外。

## 用户删掉工作区之后

`WorkspaceRegistry.delete` 只删记录，会话与文件都不动，于是项目会话变松散、落回「未分组」。点项目行时 `attachCoordinator` 会重建（`create` 幂等）并把三类会话挂回去：协调者、退役协调者、该项目的 worker（名单来自 `sessionQuery.listSessions()` 加 worker 登记表）。**用户在项目目录里手动开的会话不碰**——把它们塞进一个被隐藏的工作区，等于让它们从界面上消失。

重建在左栏看不见（工作区行被藏着），所以客户端弹一条顶部提示（复用 `toast.js`，文案带归位数量）。

## 明确接受的代价

- 「未分组」组头在工作区被删、又还没点过项目行的窗口期会露出来（组里没有可见行，因为我们把插件会话藏了）。不复刻宿主可见性规则是刻意的。
- 工作区仍在宿主数据里：欢迎页的工作区选择器、工作区管理面板列得出来，用户能从那里删掉它（然后走上面的重建路径）。
- 官方分组行上的会话计数包含被隐藏的行；被隐藏的行仍在 DOM 里，官方搜索仍能命中。
- 目录已有用户自己的工作区时会被复用：不记 `workspaceId`、不藏，于是项目会话挂在用户的工作区里、行被藏，那个分组的计数比可见行多。

## 证据

- `npm run check` 528 绿。新增用例：worker 建完挂工作区（含工作区不存在、挂载失败两条退化路径）、工作区被删后重建并标出 `recreated`/`reconnected`、重建时把 worker 一起归位、`openCoordinatorSession` 透传重建标记。
- 真机（隔离实例，零真实 API 调用）：建项目后左栏只余 `Default workspace`，项目工作区行 `display:none`；手工把该工作区从 `workspace.json` 删掉并重启后点项目行，提示条读出「项目「own」的工作区已重建，1 个会话已归位。」，重建的工作区行与会话行都是 `display:none`，无 console error / pageerror。
