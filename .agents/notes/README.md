# Agent Notes

非平凡改动的决策记忆：记**为什么这样定**、放弃了什么、怎么验证。代码与 `docs/` 讲事实，这里讲取舍。

写新笔记前的取代检查与写作清单见 [AGENTS.md](AGENTS.md)；本文件定义路径、类目、头部/Status、归档/删除判据。

## 路径与状态

`.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-english-slug.md`，文件名日期是**首次提出**那天。

路径与第 3 行 `Status:` 双写，门禁交叉校验；两处必须一致，正文其它地方不能再出现 `Status:`。

| lifecycle | Status 行 | 骨架（首节固定 `## Problem`） |
|---|---|---|
| `proposed` | `Status: proposed` | `## Proposal`、`## Alternatives considered`、`## Acceptance criteria`、`## Risks` |
| `implemented` | `Status: implemented` | `## Decision`、`## Alternatives considered`、`## Consequences` |
| `rejected` | `Status: rejected — <理由>` | `## Proposal`、`## Alternatives considered` |
| `archived` | `Status: implemented`（历史映射） | 同 `implemented` |

`## Testing` 可选；`## Alternatives considered` 每个 lifecycle 都必需。

## 头部与骨架

第 1 行 `# Agent Note: <非空标题>`，第 2 行空行，第 3 行 `Status:`，第 4 行空行，首节 `## Problem`。

implemented 的骨架：

```markdown
# Agent Note: <标题>

Status: implemented

## Problem

## Decision

## Alternatives considered

## Consequences

<!-- 末尾一句：收益：… -->

## Testing
```

proposed 用 `## Proposal` / `## Acceptance criteria` / `## Risks` 替换 Decision / Consequences，`## Alternatives considered` 放在 Proposal 之后。rejected 只保留 `## Proposal` 与 `## Alternatives considered`，否决理由写在 `Status: rejected — <理由>`。

`implemented` / `archived` 不能出现 `## Proposal` / `## Plan` / `## Migration plan` / `## Acceptance criteria`（大小写不敏感、按词边界）；提案期内容折进 Decision / Consequences / Testing。

## 备选与代价

`## Alternatives considered` 记真实被否的选项与它为什么输。确实没有记录过的，写一条默认替代并标注「（原文未记录，本次补记）」；不接受 HTML 注释代替，也没有祖父条款——本仓没有 2026-07-05 之前的笔记。

`## Consequences` 写代价与不覆盖的范围；implemented 另用一句「收益：…」收束这次决策换来了什么。

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

部分被取代的笔记留在 `implemented`，按 [AGENTS.md](AGENTS.md) 的取代检查加指针。

## 归档与删除

整篇被取代且仍有历史价值的 implemented 笔记移入 `archived/{class}/`；archived 沿用 implemented 骨架与 `Status: implemented`，只移动路径、不改正文，没有单独的冻结门禁（当前 0 篇）。只描述小范围 UI 调整或纯机械改动的直接删；被否决的提案移入 `rejected/` 并写明理由。删除或归档都在同一个 PR 里修好笔记间链接。

## 门禁

`npm run check` 里的 `scripts/verify-agent-note-format.mjs`（判定在 `scripts/agent-note-format.mjs`，
读盘遍历在 `scripts/agent-note-audit.mjs`）校验：路径双轴与闭集、文件名与真实日期、头部四行、
`Status:` 形态且全文件唯一、首节 `## Problem`、按 lifecycle 的必需节、implemented / archived 禁提案期节名、
`## Alternatives considered`、legacy marker、唯一 H1 在首行、节名不重复、笔记间相对链接可达。
围栏（``` / ~~~ / 最多三格缩进）里的内容不参与结构判定。根层的 `README.md` 与 `AGENTS.md` 是目录说明，不参与判定。
