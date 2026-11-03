# 项目与 dsh 工作区解耦：不建、不挂、删项目不动工作区

2026-11-03。取代 [项目自带一个工作区](2026-11-02-project-owns-workspace.md)（该笔记与后续两份修订都指向归属路线）。

## 背景

两个用户报障同源：

1. **在项目目录的工作区里新建会话，打开的是项目 leader。** 宿主 `ui-workspace` 的 `createInWorkspace()` 在 `startSession` / `selectWorkspace` 等入口会先在工作区里找「第一个空白会话」当可复用的新建草稿（`summary.blank && summary.cwd === workspace.path && workspace.sessionIds.includes(id)`）。旧版本把 leader 挂进项目目录的工作区，而 leader 一直空着，于是用户点「新建会话」时复用的正是它。
2. **删项目连工作区一起删，删工作区点项目行又自动重建。** 项目记录带 `workspaceId`，`remove()` 先 `registry.delete(workspaceId)`；`attachLeader()` 在工作区被删后按需重建并把 leader、退役 leader、worker 一起挂回去。两个东西被绑成一条命。

## 决策

### 项目不碰工作区

`create` 只建 leader 会话与记录（`sessionController.create({ cwd, sessionId })`，不传 `workspaceId`）；`replaceLeader` 只确认目录可用；`remove` 只 `store.remove(id)`。项目记录不再有 `workspaceId`，`attachLeader` / `ensureWorkspace` / `recordWorkspaceOwnership` / `discardWorkspace` / `removeWorkspace` / `isWorkspaceAlive` 全部删除。

### 渲染层接管「未分组」

项目会话落进官方树的「未分组」。会话行本来就被排除（`workspace-exclusion.js`），这次补上组头：组内已渲染的会话行全被隐藏、且没有可见的「展开其余 N 个会话」时，给组头加 `dsh-leader-kit-empty-ungrouped`。判据只看 DOM 现状，不复刻宿主的可见性规则（`blank && id !== current` 不渲染、归档不进组）——上一轮正是因为「复刻规则会漂移」才推翻了解耦路线，这次把判据压到「读渲染结果」就绕开了这个反对理由。

### 历史挂载在启动时摘掉

`detachFromWorkspaces({ workerIds, registry })`：把现任 leader、`retiredLeaderSessionIds` 与登记的 worker 放进目标集合，对每个工作区实体逐个 `detachSession`。`detachSession` 幂等，重跑是空操作；只摘这三类，用户在项目目录里手动开的会话不动。

两个实现约束都是踩出来的：

- **要用 `ctx.inject(['workspaceRegistry'], …)` 等宿主服务就绪。** 插件 `apply` 期间 `ctx.get('workspaceRegistry')` 是 `undefined`（服务在宿主装配完成后才可用），迁移于是静默变成空操作。第一版就是这么错的：e2e 里 `workspace.json` 的 `sessionIds` 一直留着 leader，日志干干净净。
- **不要遍历工作区的 `sessionIds` getter。** 它按会话 cwd 索引过滤（`candidateMatches`），刚重启时历史会话可能还没索引到——要摘的恰好就是这类。对目标集合里的会话直接调 `detachSession`，包不包含交给宿主在写入链里判。

### 删项目语义简化

`deleteProject` 只回 `{ removed }` / `{ removed: false, notFound: true, reason }`。`workspaceRemoved` / `skipped` 这类回执随工作区归属一起删掉；确认弹窗与结果提示改成「文件夹、会话记录与 dsh 工作区都会保留」。

## 边界

- **迁移每次启动都跑一遍**：项目数 × 工作区数的 `detachSession` 调用（基本都是空操作）。量级小，避免再加「迁移版本号」这类状态。
- **没有工作区服务的组合（acp / headless / sdk）里迁移不跑**：`ctx.inject` 等不到服务，也没东西可摘。worker 身份收编（`adoptedWorkers`）不依赖工作区，不受影响。
- **用户在项目目录里自建的工作区照常显示**：会话行仍被排除、折叠计数按排除后修正；删项目不动它。
- **「未分组」组头判据只看 DOM**：宿主若改成把空组头直接不渲染，这条补丁自然失效（不再需要），不会反过来藏掉有内容的组。
- 存量记录里的 `workspaceId` 字段不迁移、不读取；`store.draft` 与 `MUTABLE_FIELDS` 已经不再产出它。

## 验证

- `npm run check`：1001 tests / 985 pass / 16 skipped / 0 fail；70 个源文件，54 个被单测加载，覆盖率门禁全绿（`workspace-exclusion.js` 79→82、`projects/service.js` 95→96）。
- 单测新增：删除项目只删记录、建项目不注册工作区、迁移摘除与幂等、迁移不碰用户会话、没有工作区服务时迁移是空操作、摘除失败只记日志、装配层「工作区服务就绪后把项目 leader 从工作区里摘掉」（守住 `ctx.inject` 接缝）。
- 双向验证：
  1. 撤掉 `ctx.inject` 里的 `detachFromWorkspaces` 调用 → e2e「启动迁移应把 leader 从工作区里摘掉」超时变红（`最后一次观察：false`），还原后 7-9 秒变绿；
  2. 让 `markUngroupedHeader` 直接 `return false` → e2e「未分组里只剩被排除的项目会话时，组头也要藏起来」变红，还原后变绿。
- e2e（`tests/e2e/project-workspace.e2e.js`，真实 dsh + 本地 mock + chromium）：两段式实例——第一段拿宿主的空会话，停实例后 seed `projects.json` 并把 leader 塞回默认工作区（模拟旧数据）→ 第二段启动，等 `storages/workspace.json` 里 leader 被摘掉 → 点项目行打开 leader（引导卡出现）→ 断言「未分组」组头带 `dsh-leader-kit-empty-ungrouped` → 点工作区行的「新建会话」→ 引导卡消失、当前会话不是 leader。连跑 3 次全绿。
