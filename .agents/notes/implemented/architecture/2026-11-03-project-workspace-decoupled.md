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

项目会话落进官方树的「未分组」。会话行本来就被排除（`workspace-exclusion.js`），这次补上组头：组内已渲染的会话行全被隐藏、且没有可见的「展开其余 N 个会话」时，给组头加 `dsh-leader-agent-empty-ungrouped`。判据只看 DOM 现状，不复刻宿主的可见性规则（`blank && id !== current` 不渲染、归档不进组）——上一轮正是因为「复刻规则会漂移」才推翻了解耦路线，这次把判据压到「读渲染结果」就绕开了这个反对理由。

### 历史挂载在启动时摘掉，只摘项目目录那个工作区

`detachFromWorkspaces({ workerIds, registry })`：把现任 leader、`retiredLeaderSessionIds` 与登记的 worker 放进目标集合，**只对「工作区目录（realpath 归一后）等于某个项目目录」的工作区**调 `detachSession`。`detachSession` 幂等，重跑是空操作；只摘这三类，用户在项目目录里手动开的会话不动。

范围必须收窄：用户把项目会话手动分组到别的工作区是个明确动作，第一版对所有工作区摘，等于每次启动都把用户的分组抹一遍。收窄不会漏摘老挂载——旧版本的自动挂载本来就落在项目目录对应的工作区里；判据用归一后的目录相等，符号链接写法（macOS 的 `/tmp` → `/private/tmp`）也能对上。

两个实现约束都是踩出来的：

- **要用 `ctx.inject(['workspaceRegistry'], …)` 等宿主服务就绪。** 插件 `apply` 期间 `ctx.get('workspaceRegistry')` 是 `undefined`（服务在宿主装配完成后才可用），迁移于是静默变成空操作。第一版就是这么错的：e2e 里 `workspace.json` 的 `sessionIds` 一直留着 leader，日志干干净净。
- **不要遍历工作区的 `sessionIds` getter。** 它按会话 cwd 索引过滤（`candidateMatches`），刚重启时历史会话可能还没索引到——要摘的恰好就是这类。对目标集合里的会话直接调 `detachSession`，包不包含交给宿主在写入链里判。

### 删项目语义简化

`deleteProject` 只回 `{ removed }` / `{ removed: false, notFound: true, reason }`。`workspaceRemoved` / `skipped` 这类回执随工作区归属一起删掉；确认弹窗与结果提示改成「文件夹、会话记录与 dsh 工作区都会保留」。

## 边界

- **迁移每次启动都跑一遍**：项目数 × 工作区数的 `detachSession` 调用（基本都是空操作）。量级小，避免再加「迁移版本号」这类状态。
- **没有工作区服务的组合（acp / headless / sdk）里迁移不跑**：`ctx.inject` 等不到服务，也没东西可摘。worker 身份收编（`adoptedWorkers`）不依赖工作区，不受影响。
- **用户在项目目录里自建的工作区照常显示**：会话行仍被排除、折叠计数按排除后修正；删项目不动它。
- **迁移只处理项目目录对应的那个工作区，且按目录配对**：摘除集合是「该项目自己的 leader / 退役 leader + 全局 worker」，不是所有项目会话的并集——否则 B 项目的 leader 被拖进 A 项目目录的工作区时会被 A 的迁移连带摘掉。用户手动分组到其它工作区的那一份从此归用户所有，插件不读也不改。
- **目录解析失败时归一器回落原字符串**（`createCanonicalizer` 的 `catch`）：项目目录被删或改名后，工作区记的路径与项目记录不再是同一字符串，那批老挂载会漏摘。影响仅限「目录已经不存在的项目」——它们的会话本来就打不开，漏摘只留下一条指向不存在目录的分组记录。彻底修要在项目记录里存 canonical 目录，超出本 PR 范围。
- **「未分组」组头判据只看 DOM**：宿主若改成把空组头直接不渲染，这条补丁自然失效（不再需要），不会反过来藏掉有内容的组。
- 存量记录里的 `workspaceId` 字段不迁移、不读取；`store.draft` 与 `MUTABLE_FIELDS` 已经不再产出它。

## 验证

- `npm run check`：997 用例通过（16 跳过）；70 个源文件，54 个被单测加载，覆盖率门禁全绿。
- `src/host/projects/service.js` 行覆盖 97.76%（门槛 97，余量 0.76pp）。剩的 12 行未覆盖（`35-36`、`52-53`、`100-101`、`587-589`、`605-608`、`772-776`）都在本 PR 未触及的存量分支上：建服务的参数与依赖校验、会话聚合的两条空分支、`get` 取不到记录时的返回、以及 worker 的 getter。要抬余量得另开任务补那几处。
- `src/client/workspace-exclusion.js` 行覆盖 82.49% → 84.72%（导出 `restoreExpandButton` 给单测，补三条：文本仍是我们写的那句时换回宿主原数、宿主已重写过文案时不碰文本、没有 dataset 的节点只去掉隐藏类），登记门槛 82 → 84。剩余未覆盖是 `78-85`（内联 CSS 模板字符串）与 `447-517`（observer 编排，要真实 DOM 与 rAF，单测不引 jsdom）。
- 单测新增：删除项目只删记录、建项目不注册工作区、迁移摘除与「第二遍零写盘」的幂等、迁移不碰用户会话、迁移不碰用户手动分组到别的工作区的会话、迁移按 realpath 认目录（符号链接写法照样摘净）、从注册表取工作区实体（`list` 只给 id、`get` 给实体）、建项目落盘失败时撤销 leader 会话、撤销失败只记日志、没有工作区服务时迁移是空操作、摘除失败只记日志、装配层「工作区服务就绪后把项目 leader 从工作区里摘掉」（守住 `ctx.inject` 接缝）、未分组超过一屏且混着用户会话时按钮数字与组头都不动、迁移不摘别的项目拖进本项目目录工作区的 leader、退役 leader 也在摘除范围内、一个项目都没有时迁移不碰任何工作区。
- 双向验证：
  1. 撤掉 `ctx.inject` 里的 `detachFromWorkspaces` 调用 → e2e「启动迁移应把 leader 从工作区里摘掉」超时变红（`最后一次观察：false`），还原后 7-9 秒变绿；
  2. 让 `markUngroupedHeader` 直接 `return false` → e2e「未分组里只剩被排除的项目会话时，组头也要藏起来」变红，还原后变绿；
  3. 撤掉迁移的目录收窄判据（对所有工作区摘）→「迁移不碰用户手动分组到别的工作区的会话」变红，还原后 45 例全绿；
  4. 把归一后的目录比较换成字符串比较 → 4 条迁移用例变红（含 realpath 那条），证明判据确实依赖 realpath 归一；
  5. 把假件的 `detachSession` 改成「不在账上也写」→ 幂等用例的「第二遍写盘 0」变红；
  6. 删掉假 registry 的 `get` → 「list 只给 id 时也能摘」变红；
  7. 撤掉 `create()` 失败分支里的 `abandonLeaderSession` → 两条撤销用例变红；
  8. e2e 当前会话行的选择器改回旧的 `aria-current` / `.selected` → 「应当能读到当前会话行」变红（旧写法恒为 null，原断言等于空转）；把比较反向（断言当前会话就是 leader）→ 「不应停在 leader 上」变红；
  9. 把按目录配对改回「全局 targets × 全局目录集合」→「迁移不摘别的项目拖进本项目目录工作区的 leader」变红，还原后 51 例全绿。
- e2e 的已知噪音：`assert.deepEqual(e2e.problems, [])` 偶发红在宿主侧 `Sidebar Session opening failed: Error: Session reference "…" is released`（`SidebarSessionView.dispose` 抛出，栈里没有插件帧）。单跑 4 次 3 绿 1 红；为它改断言或加 retry 都会削弱「页内错误即失败」这条纪律，所以保持原样，遇到时按宿主噪音记录。
- e2e（`tests/e2e/project-workspace.e2e.js`，真实 dsh + 本地 mock + chromium）：两段式实例——第一段拿宿主的空会话，停实例后 seed `projects.json` 并把 leader 塞回默认工作区（模拟旧数据）→ 第二段启动，等 `storages/workspace.json` 里 leader 被摘掉 → 点项目行打开 leader（引导卡出现）→ 断言「未分组」组头带 `dsh-leader-agent-empty-ungrouped` → 点工作区行的「新建会话」→ 引导卡消失、当前会话不是 leader。连跑 3 次全绿。
