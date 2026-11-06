# 仓库合并方式固定为 merge commit

## 背景

- 2026-11-04 至 2026-11-06 本仓的 PR 全部落成 rebase 合并：#115 / #117 / #118 / #119 / #120 / #121 / #122 的 head 提交在 main 上被重写成新 SHA（patch-id 相同），committer 被改成合并人；这段时间 `git rev-list --merges --count origin/main` 一直是 0。
- 不是仓库没设：ruleset `main-protection` 的 `allowed_merge_methods` 早已是 `["merge"]`，但 `bypass_actors` 给 Repository admin 配了 `always`；合并人（仓库 owner）是 admin，API 返回 `current_user_can_bypass: always`，这条限制对本人不起作用。同时 repo 级 `allow_rebase_merge=true` 一直开着。
- 结论：想固定合并方式必须以仓库级设置为准，ruleset 的 merge-method 限制对 admin 不可靠。

## 决策

- 仓库设置只开 merge commit：`allow_merge_commit=true`、`allow_squash_merge=false`、`allow_rebase_merge=false`（2026-11-06 用 `gh api -X PATCH` 改）。
- ruleset 保留 `allowed_merge_methods: ["merge"]` 作第二道；但 `bypass_mode: "always"` 是 ruleset 级的——admin 跳过的是全部规则（含 `allowed_merge_methods`），所以 11-04 那几次 rebase 才没被拦住。第二道防线只对非 bypass 身份有效。
- 在 `AGENTS.md` 的「提交与 PR」记一条：PR 合入 main 一律 `Create a merge commit`。

## 边界

- 不改写历史：squash（#114 及以前）与 rebase（#115–#122）的提交原样保留，merge commit 从 #123 起出现。
- 只约束「PR 合入 main」；本地 `git merge main` 进分支、向功能分支 push 快进都不受影响。
- 代价是 main 不再线性：每个 PR 多一个合并点；回滚整个 PR 用 `git revert -m 1 <merge>`。

## 验证

- 设置读数（2026-11-12 复核）：`gh api repos/fengshenx/dsh-leader-agent` → `{"allow_merge_commit":true,"allow_squash_merge":false,"allow_rebase_merge":false,"allow_auto_merge":false}`。
- 规则读数：ruleset `main-protection` 的 `allowed_merge_methods: ["merge"]`，无 `required_linear_history`，未启用 merge queue。
- 实际读数（2026-11-12）：`git rev-list --merges --count origin/main` = 5，`git log --merges --reverse --oneline origin/main` 从旧到新依次是 #123 `c7cee44`、#127 `bc4122c`、#128 `3fb2a63`、#129 `0f50c99`、#131 `43d3692`（0.4.0 发版）；设置已生效，main 上已是一串 merge commit。
