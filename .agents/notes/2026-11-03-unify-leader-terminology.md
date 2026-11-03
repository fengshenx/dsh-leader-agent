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

### 不迁移持久化数据

项目注册表落盘的 `coordinatorSessionId` / `retiredCoordinatorSessionIds` 一并改名，旧 `projects.json` 不再被读取。项目未发布，旧字段只可能是本地 `npm run dev` 的调试数据；README 已写明删掉数据目录即重置，因此不做字段读取退回，避免在代码里留下旧的 coordinator 标识。

## 边界

- **历史 Agent Note 保留原文**：`.agents/notes/` 是当时的决策记录，改词会歪曲记录；指向这些笔记的链接文件名（含 `coordinator`）同样保持原样。
- **`COORDINATOR.md` 保留为兼容入口**：根目录仍放一个只指向 `LEADER.md` 的短文件，给 Telov 等仍按旧文件名找协调者手册的外部工具用。插件只读 `LEADER.md`，这个文件不参与注入；它受文档预算门禁管理，正文不承载规则。
- **`dsh-coordinator` 历史包名**：`docs/capability-gaps.md` 记录数据目录改名来源时保留旧包名，不属于本次术语范围。
- **`.worktrees/` 旧副本**：独立 checkout，随分支处置。
- 旧 `projects.json` 里的项目与 leader 绑定不会自动迁移；需要时在左栏项目区块重新绑定。

## 验证

- `npm run check` 全绿，914 例（898 pass / 16 skip）。
- `npm run build:client` 重建 `lib/client.js`。
- 替换后对全仓（排除历史笔记、`lib/`、`.dev/`、`.worktrees/`）grep `coordinator|Coordinator|COORDINATOR|协调者`，只余两处有意保留的历史专名。
- 锚点检查：`playbooks/program.md#leader-动作与工具` 修正为 GitHub 锚点格式（空格转连字符）。
