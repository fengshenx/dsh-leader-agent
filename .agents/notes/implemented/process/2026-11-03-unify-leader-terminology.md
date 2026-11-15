# Agent Note: 术语统一为 leader

Status: implemented

## Problem

上一次改名把包名改成 `dsh-leader-kit`，但保留了 `COORDINATOR.md` 文件名、中文「协调者」叙述与内部领域标识。结果同一角色在仓库里有两套叫法：产品与 skill 叫 leader，提示词文件名与文档叙述叫协调者，用户可见文案、提示词与代码注释互相指代时要来回翻译，新读者也无法从文件名校准角色。包未发布、无外部用户，保留旧词的收益不成立。

## Decision

- **文案层统一**：「协调者」→ `leader`，`Coordinator` / `COORDINATOR` → `Leader` / `LEADER`；项目级提示词文件名 `COORDINATOR.md` → `LEADER.md`，常量、领域标识（`coordinatorSessionId` → `leaderSessionId` 等）与模块文件名随之改名，文档预算表与提示词文档扫描面同步换成 `LEADER.md`。
- **落盘字段只写新键，读取退回旧键**：按「已落盘的运行时用户数据可以做读取退回」这条既有例外处理，而不是一刀切换。读存储时把旧键归一化成新键（新键已有值以新键为准、旧键删掉），写回只留新字段。不退回的后果是升级即静默断链：查不到项目 → `isLeaderSession=false` → 工具面按普通会话裁剪，老的 leader 悄悄丢掉派工与卡片工具，没有任何报错。其余存储域复核过没有跟着改名的持久字段，不需要退回。
- **手册文件读退回 `COORDINATOR.md`**：插件只写/读 `LEADER.md`，缺失时退回读旧文件并记一条改名提示。选读退回而不是 fail loud：手册是增量信息、既有约定就是缺失即静默，fail loud 会让只有旧文件的正常项目每轮 turn 报错；而不退回则是升级后静默失去手册注入。
- **两类提示按「进程内目录」去重**：手册每轮 turn 重新求值，不去重会让同一项目每轮刷一条、淹没真正的问题；另一类是两版并存且内容不一致，仍报一条并说明以 `LEADER.md` 为准、旧文件不再参与注入。

## Alternatives considered

- **保留 leader / 协调者两套叫法**：用户可见文案、提示词与代码注释要来回翻译，新读者也无法从文件名校准角色；统一为 leader。
- **落盘字段一刀切、不做读取退回**：升级后查不到项目 → 工具面按普通会话裁，老 leader 静默丢掉派工与卡片工具；旧键归一化、写回只留新键。
- **只有旧 `COORDINATOR.md` 时 fail loud**：只有旧文件的正常项目每轮报错；缺失时读退回并记一条改名提示。
- **每次求值都报改名提示**：同一项目每轮刷一条、淹没真问题；按进程内目录去重。

## Consequences

- 历史 Agent Note 保留原文与指向它们的含 `coordinator` 的文件名链接：笔记是当时的决策记录，改词会歪曲记录。
- `COORDINATOR.md` 保留为兼容入口：根目录留一个只指向 `LEADER.md` 的短文件给仍按旧名找手册的外部工具，受文档预算门禁管理、正文不承载规则。
- `dsh-coordinator` 历史包名保留在能力边界文档里说明数据目录改名来源，不属于本次术语范围；`.worktrees/` 旧副本随分支处置。
- 旧 `projects.json` 读得出来，不需要手动重建绑定；下一次写回（改名、换 leader、拖排序）自动落成新字段。

收益：同一角色在文案、文件名与领域标识里只有一个叫法，老项目升级后仍保留 leader 身份与手册注入。

## Testing

`tests/projects-store.test.js` 与 `tests/projects-service.test.js` 钉住旧键归一化后身份与工具面仍正确、写回只剩新字段；`tests/leader-context.test.js` 钉住手册优先、旧名退回、两版并存与每目录只提示一次。逐条撤销归一化、退回分支与去重，对应用例变红。
