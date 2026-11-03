# Agent Notes

非平凡改动的决策记忆：记**为什么这样定**、放弃了什么、怎么验证。代码与 `docs/` 讲事实，这里讲取舍。

## 路径即状态

`.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-english-slug.md`，文件名日期是**首次提出**那天。

路径是状态的唯一来源：**不写 `Status:` / `**状态**` 行**。写了就多出一处必须与目录同步、又没有门禁比对的风险。

| lifecycle | 含义 |
|---|---|
| `proposed` | 提案，尚未实现（或只实现一部分）。正文要 `## 提案` 与 `## 验收标准`。 |
| `implemented` | 已落地，与代码现状一致：代码搬迁、改名、换默认值时同步这些事实，决策本身不改。 |
| `rejected` | 提案被否决，冻结原样。正文要 `## 提案` 与 `## 否决理由`。 |
| `archived` | 曾落地、现已整篇不再指导当前行为。只作历史，不再修改。 |

部分被取代的笔记留在 `implemented`，在被推翻的那一节前加一行
`> **已被 [标题](../<class>/<文件名>.md) 取代**：…`，写明取代者与仍然成立的部分。

## 类目

| class | 管什么 |
|---|---|
| `feature` | 新的用户可见或模型可见能力、呈现与交互 |
| `bug-fix` | 修缺陷，含「在某个平台上不工作」 |
| `simplification` | 删代码、删行为、收窄面，不新增能力 |
| `architecture` | 已发布源码的结构与运行时语义：模块关系、会话形态、存储域、数据流 |
| `process` | 代码**周围**的工具与流程：门禁、构建、发版、worktree、文档分层、命名 |
| `testing` | 测试基建与策略 |

口径：**改运行时行为 → feature / bug-fix / simplification / architecture；改围绕代码的工具与流程 → process / testing。**

## 门禁

`npm run check` 里的 `scripts/verify-agent-note-format.mjs`（判定在 `scripts/agent-note-format.mjs`，
读盘遍历在 `scripts/agent-note-audit.mjs`）
校验：路径双轴与闭集、文件名、唯一 H1 在首行、首节 `## 背景`、按 lifecycle 的必需节、节名不重复、
行首不出现 `**状态**` 行、笔记间相对链接可达。根层的 `README.md` 与 `AGENTS.md` 是目录说明，不参与判定。
