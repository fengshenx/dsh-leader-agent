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

### 落盘字段只写新键，读取退回旧键

领域标识改名会碰到项目注册表落盘的 `coordinatorSessionId` / `retiredCoordinatorSessionIds`。按「已落盘的运行时用户数据可以做读取退回」这条既有例外处理，而不是一刀切换：

- `projects/store.js` 的 `readStore()` 把旧键归一化成新键（新键已有值时以新键为准，旧键删掉），`update()` 在其后取值，所以写回只留新字段；
- 不退回的后果是升级即断链：`getByLeader()` 查不到项目 → `isLeaderSession=false` → 工具面按普通会话裁剪，老的 leader 静默丢掉 `spawn_worker` / `message_worker` / `list_cards` / `read_worker_session` / `create_card` / `update_card`，没有任何报错。

复核过其余存储域，没有跟着改名的持久字段：`workers.json`（`childId` / `parentSessionId`）、通知队列（`parentSessionId`）、卡片库（`projectId` / `slots[].sessionId`）都未改名，不需要退回。

### 手册文件读退回 `COORDINATOR.md`

插件只写/读 `LEADER.md`，但 `LEADER.md` 缺失时退回读 `COORDINATOR.md` 并记一条改名提示。选读退回而不是 fail loud：手册是增量信息、不是必需品（既有约定是缺失就静默），fail loud 会让只有旧文件的正常项目在每轮 turn 报错；而不退回则是升级后静默失去手册注入——两者之间，读退回保住了内容又留下了可发现的迁移提示。

## 边界

- **历史 Agent Note 保留原文**：`.agents/notes/` 是当时的决策记录，改词会歪曲记录；指向这些笔记的链接文件名（含 `coordinator`）同样保持原样。
- **`COORDINATOR.md` 保留为兼容入口**：根目录仍放一个只指向 `LEADER.md` 的短文件，给 Telov 等仍按旧文件名找 leader 手册的外部工具用。插件优先读 `LEADER.md`，缺失时退回读它并记日志；这个文件同时受文档预算门禁管理，正文不承载规则。
- **`dsh-coordinator` 历史包名**：`docs/capability-gaps.md` 记录数据目录改名来源时保留旧包名，不属于本次术语范围。
- **`.worktrees/` 旧副本**：独立 checkout，随分支处置。
- 旧 `projects.json` 读得出来，不需要手动重建绑定；下一次写回（改名、换 leader、拖排序）会自动落成新字段。

## 验证

- `npm run check` 全绿：920 例（904 pass / 16 skip / 0 fail）；文档预算 12 篇都在天花板内，四项重算后余量 AGENTS 10.0% / `capability-gaps` 10.0% / README 5.1% / `development` 5.0%。
- `npm run build:client` 重建 `lib/client.js`。
- 替换后对全仓（排除历史笔记、`lib/`、`.dev/`、`.worktrees/`）grep `coordinator|Coordinator|COORDINATOR|协调者`，只余两处有意保留的历史专名与读取退回用的旧键/旧文件名。
- 锚点检查：`playbooks/program.md#leader-动作与工具` 修正为 GitHub 锚点格式（空格转连字符）。
- 兼容性用例（新增）：
  - `tests/projects-store.test.js`「旧字段名的注册表仍能读出 leader 与退役列表，写回只留新字段」：老格式 `projects.json` → `getByLeader` 命中、列表字段归一化、`update()` 后落盘无旧键；「新旧字段同时存在时以新字段为准」。
  - `tests/projects-service.test.js`「旧字段名的注册表仍能恢复 leader 身份与工具面」：真实 store + `loadIndex()` → `isLeaderSession=true`、`directoryOfLeader` 有值、`deniedToolsFor` 返回 leader 的禁用集（不含 `spawn_worker`）。
  - `tests/leader-context.test.js`「手册文件名写死为 LEADER.md」「两版都在时以 LEADER.md 为准」「只有旧名 COORDINATOR.md 时退回读取，并提示改名」。
- 双向验证：撤掉 `readStore()` 的旧键归一化 → store 与 service 两条用例变红（2 fail）；撤掉手册退回分支 → 旧名用例变红（1 fail）；把 `LEADER_CONTEXT_FILE` 常量改回 `COORDINATOR.md` → 3 条用例变红（改名前这一操作是 8/8 全绿）。还原后 96 例全绿（三个测试文件）。
