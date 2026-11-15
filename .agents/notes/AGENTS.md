# AGENTS.md — Agent Notes

本文件是**写笔记时的操作清单**；双轴取值、类目口径、头部/Status、归档与删除判据的完整定义见 [README.md](README.md)，何时写笔记见根 [AGENTS.md](../AGENTS.md)。

**动笔前先做取代检查。** 检索活跃树里覆盖同一决策、机制或备选的笔记，逐篇定级：

- 已有主人 → 改那一篇，不新增重复记录；
- 整篇被取代 → 同一个 PR 里删掉；仍值得留存的历史决策按 README 移入 `archived/`；
- 部分被取代 → 留在原 lifecycle，在被推翻的节前加 `> **已被 [标题](…) 取代**：…`，写明取代者与仍然成立的部分，两篇互链。

**`implemented/` 对代码现状负责。** 路径、符号、默认值、机制变了就同 PR 改事实；决策被推翻要新开一篇并链接旧篇，不能把旧篇改写成相反结论。

**每篇都按宿主骨架写：**

- 第 1 行 `# Agent Note: <非空标题>`，第 2、4 行空行，第 3 行是唯一的 `Status:`；
- `Status:` 与路径双写：`proposed` / `implemented` / `rejected — <理由>`；`archived` 写 `implemented`；
- 首节 `## Problem`；`implemented` 用 `## Decision` / `## Consequences`，`proposed` 用 `## Proposal` / `## Acceptance criteria` / `## Risks`，`rejected` 用 `## Proposal`；
- `## Alternatives considered` 每个 lifecycle 都写：真实被否的选项与它为什么输；确实没有记录的，写一条默认替代并标注「（原文未记录，本次补记）」；
- `implemented` / `archived` 不写提案期节名（`## Proposal` / `## Plan` / `## Migration plan` / `## Acceptance criteria`），内容折进 Decision / Consequences / Testing；
- `## Testing` 可选：哪个用例文件钉住它，双向验证的关键读数一句话；`implemented` 在 `## Consequences` 末尾写一句「收益：…」。

**不写流水账。** 不写文件清单（`**范围**`）、宿主源码行号与实现路径、CSS/数值细节、PR 编号与复审过程、逐条复现命令与读数表、测试总数。实现看代码，机制地图看 `docs/`，过程看 PR。多数笔记控制在 40 行以内；超出时先问「这条细节一年后还会改变一个决定吗」。

**`Status:` 只写第 3 行。** 正文其它位置（包括代码块外的行首）不再出现 `Status:`；门禁会判全文件唯一与形态，lifecycle 表见 README。
