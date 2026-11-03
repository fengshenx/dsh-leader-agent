# 术语统一为 leader

**日期**：2026-11-03
**范围**：全仓文案、标识符、文件名，不含 `.worktrees/` 旧副本与 `.agents/notes/` 历史笔记

## 背景

`2026-11-02-rename-to-leader-kit.md` 把包名改成 `dsh-leader-kit`，但明确保留了 `COORDINATOR.md` 文件名、中文「协调者」叙述与内部领域标识。结果是同一角色在仓库里有两套叫法：产品与 skill 叫 leader，提示词文件名与文档叙述叫协调者。用户可见文案、提示词与代码注释互相指代时需要来回翻译，新读者也无法从文件名校准角色。

包未发布、无外部用户，保留旧词的收益（不破坏已初始化项目）不成立，这次把边界推翻。

## 决策

- 文案层：「协调者」统一为 `leader`；英文 `Coordinator` / `COORDINATOR` 统一为 `Leader` / `LEADER`
- 项目级提示词文件名 `COORDINATOR.md` → `LEADER.md`；常量 `COORDINATOR_CONTEXT_FILE` → `LEADER_CONTEXT_FILE`
- 领域标识随之改名：`coordinatorSessionId` → `leaderSessionId`、`retiredCoordinatorSessionIds` → `retiredLeaderSessionIds`、`isCoordinatorSession` → `isLeaderSession` 等
- 文件名：`src/host/coordinator-context.js` → `leader-context.js`、`coordinator-handover.js` → `leader-handover.js`、`src/client/coordinator-*.js` → `leader-*.js`，对应测试文件同名调整
- 文档预算表与提示词文档扫描面同步换成 `LEADER.md`
- 并行落地的 #82（覆盖率门禁）与 #85（桌面版挂载）带进来的新文件一并改名：`docs/getting-started.md`、桌面段与安装教程、`scripts/coverage-manifest.json` 里的 `leader-view.js` 路径、以及测试里的 `attachLeader` / `leaderSessionIndex` / `watchLeaderSessions`

### 落盘字段只写新键，读取退回旧键

领域标识改名会碰到项目注册表落盘的 `coordinatorSessionId` / `retiredCoordinatorSessionIds`。按「已落盘的运行时用户数据可以做读取退回」这条既有例外处理，而不是一刀切换：

- `projects/store.js` 的 `readStore()` 把旧键归一化成新键（新键已有值时以新键为准，旧键删掉），`update()` 在其后取值，所以写回只留新字段；
- 不退回的后果是升级即断链：`getByLeader()` 查不到项目 → `isLeaderSession=false` → 工具面按普通会话裁剪，老的 leader 静默丢掉 `spawn_worker` / `message_worker` / `list_cards` / `read_worker_session` / `create_card` / `update_card`，没有任何报错。

复核过其余存储域，没有跟着改名的持久字段：`workers.json`（`childId` / `parentSessionId`）、通知队列（`parentSessionId`）、卡片库（`projectId` / `slots[].sessionId`）都未改名，不需要退回。

### 手册文件读退回 `COORDINATOR.md`

插件只写/读 `LEADER.md`，但 `LEADER.md` 缺失时退回读 `COORDINATOR.md` 并记一条改名提示。选读退回而不是 fail loud：手册是增量信息、不是必需品（既有约定是缺失就静默），fail loud 会让只有旧文件的正常项目在每轮 turn 报错；而不退回则是升级后静默失去手册注入——两者之间，读退回保住了内容又留下了可发现的迁移提示。

两类提示都按「进程内目录」去重：手册每轮 turn 重新求值，不去重的话同一个项目每轮刷一条，真正的问题会被淹没；提示本就是一次性的迁移告警，换项目或重启进程会再报。另一类提示是两版并存且内容不一致——说明有人改了 `COORDINATOR.md` 却没同步，仍照样报一条，说明以 `LEADER.md` 为准、旧文件已不参与注入。

## 边界

- **历史 Agent Note 保留原文**：`.agents/notes/` 是当时的决策记录，改词会歪曲记录；指向这些笔记的链接文件名（含 `coordinator`）同样保持原样。
- **`COORDINATOR.md` 保留为兼容入口**：根目录仍放一个只指向 `LEADER.md` 的短文件，给 Telov 等仍按旧文件名找 leader 手册的外部工具用。插件优先读 `LEADER.md`，缺失时退回读它并记日志；这个文件同时受文档预算门禁管理，正文不承载规则。
- **`dsh-coordinator` 历史包名**：`docs/capability-gaps.md` 记录数据目录改名来源时保留旧包名，不属于本次术语范围。
- **`.worktrees/` 旧副本**：独立 checkout，随分支处置。
- 旧 `projects.json` 读得出来，不需要手动重建绑定；下一次写回（改名、换 leader、拖排序）会自动落成新字段。

## 验证

- `npm run check` 全绿（15s）：964 例通过 / 16 skip / 0 fail；覆盖率门禁 68 个源文件、53 个被单测加载、其中 45 个行覆盖 100%、15 个登记为单测不可加载；13 篇 standing docs 都在天花板内。
- 文档预算：合并 #85 的 `docs/getting-started.md` 后重新登记，`README.md` 与 `docs/getting-started.md` 按 ≥5% 重算（5.02% / 5.03%），AGENTS 11.29% 与 `capability-gaps` 11.03% 满足 ≥10%，`LEADER.md` 与兼容 shim `COORDINATOR.md` 都在清单里（shim 只登记、不承载规则）。
- `npm run build:client` 重建 `lib/client.js`。
- 替换后对全仓（排除历史笔记、`lib/`、`.dev/`、`.worktrees/`）grep `coordinator|Coordinator|COORDINATOR|协调者`，只余两处有意保留的历史专名与读取退回用的旧键/旧文件名。
- 合并 #85 后复扫一次，除历史笔记外全部命中都属有意保留：兼容 shim 自身与指向它的说明（根目录 `COORDINATOR.md`、`AGENTS.md`、`README{,_ZH}.md`、`docs/usage.md`、`docs/getting-started.md`、`doc-budgets.json`）、读取退回的旧键与旧文件名（`projects/store.js`、`leader-context.js` 及三个测试文件）、`docs/capability-gaps.md` 里的历史包名 `dsh-coordinator`。`.agents/notes/` 的旧词属历史记录（含 #82 的 `coverage-gate.md` 提到旧文件名），不改。
- 锚点检查：`playbooks/program.md#leader-动作与工具` 修正为 GitHub 锚点格式（空格转连字符）。
- 兼容性用例（新增）：
  - `tests/projects-store.test.js`「旧字段名的注册表仍能读出 leader 与退役列表，写回只留新字段」：老格式 `projects.json` → `getByLeader` 命中、列表字段归一化、`update()` 后落盘无旧键；「新旧字段同时存在时以新字段为准」。
  - `tests/projects-service.test.js`「旧字段名的注册表仍能恢复 leader 身份与工具面」：真实 store + `loadIndex()` → `isLeaderSession=true`、`directoryOfLeader` 有值、`deniedToolsFor` 返回 leader 的禁用集（不含 `spawn_worker`）。
  - `tests/leader-context.test.js`「手册文件名写死为 LEADER.md」「两版都在时以 LEADER.md 为准」「只有旧名 COORDINATOR.md 时退回读取，并提示改名」「两版手册都在且内容一致时不提示」「两版内容不一致时提示以 LEADER.md 为准，且每个目录只报一次」「旧名退回提示每个目录只报一次」「新版缺失、旧名位置读失败时返回空串并记日志」。
- 双向验证：撤掉 `readStore()` 的旧键归一化 → store 与 service 两条用例变红（2 fail）；撤掉手册退回分支 → 旧名用例变红（1 fail）；把 `LEADER_CONTEXT_FILE` 常量改回 `COORDINATOR.md` → 3 条用例变红（改名前这一操作是 8/8 全绿）；撤掉旧名提示的目录去重 → 「每个目录只报一次」变红（1 fail）；撤掉内容不一致提示 → 对应用例变红（1 fail）。还原后 96 例全绿（三个测试文件），手册测试文件 14 例全绿。
