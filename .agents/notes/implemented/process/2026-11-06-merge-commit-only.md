# Agent Note: 仓库合并方式固定为 merge commit

Status: implemented

## Problem

一段时间的 PR 全部落成 rebase 合并：head 提交在 main 上被改写成新 SHA、committer 被改成合并人，`git rev-list --merges` 一直是 0。原因不是仓库没设——ruleset 的 `allowed_merge_methods` 早已是 `["merge"]`，但 `bypass_mode: "always"` 给 Repository admin 铺了直通，合并人本身就是 admin，API 也返回可绕过；同时仓库级的 rebase 开关一直开着。结论：想固定合并方式必须以仓库级设置为准。

## Decision

- **仓库设置只开 merge commit**：`allow_merge_commit=true`、`allow_squash_merge=false`、`allow_rebase_merge=false`。
- **ruleset 保留 `allowed_merge_methods: ["merge"]` 作第二道**：admin 的 bypass 是 ruleset 级的、跳过的是全部规则（含合并方式限制），所以第二道只对非 bypass 身份有效，不能当主防线。
- **`AGENTS.md` 的「提交与 PR」记一条**：PR 合入 main 一律 `Create a merge commit`。

## Alternatives considered

- **继续用 rebase 合并**：head 提交被改写成新 SHA、committer 变成合并人，`git rev-list --merges` 一直是 0；仓库级只开 merge commit。
- **只靠 ruleset 的 `allowed_merge_methods`**：admin 的 bypass 会跳过全部规则（含合并方式限制），合并人本身就是 admin；仓库设置才是主防线。
- **用 squash 合并**：同样改写提交、丢掉分支内的提交关系；固定 merge commit。

## Consequences

- 不改写历史：squash 与 rebase 时期的提交原样保留，merge commit 从设置生效后开始出现。
- 只约束「PR 合入 main」；本地 `git merge main` 进分支、向功能分支 push 快进都不受影响。
- 代价是 main 不再线性：每个 PR 多一个合并点；回滚整个 PR 用 `git revert -m 1 <merge>`。

收益：PR 合入 main 一律留下 merge commit，提交 SHA 与作者不被改写，`--merges` 能真实反映合并历史。

## Testing

`gh api` 读仓库设置，确认三种合并方式只有 merge 开启；ruleset 无 `required_linear_history`；`git rev-list --merges --count origin/main` 从 0 变为正数，main 上已是一串 merge commit。
