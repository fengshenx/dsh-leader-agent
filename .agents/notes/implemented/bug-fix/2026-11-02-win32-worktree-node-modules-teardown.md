# win32 上删 worktree 前先拆 node_modules 链接

## 背景

Windows 上 git 的递归删除会跟随 junction：`worktree:prune` 直接 `git worktree remove --force` 时，主 checkout 共享的依赖被清空，只剩空目录。建 worktree 本身正常，不能因此停用链接共享。

## 决策

### 拆除顺序由共享函数固定

只拆符号链接：不存在或真实目录都不动（真实目录可能是有人在 worktree 里自己装的那份）。Windows 的 junction / 目录符号链接用 `rmdir`，POSIX 符号链接用 `unlink`。删除流程把顺序写死：先拆链接再删除，拆不掉就留下 worktree，不能让 git 跟穿链接删共享依赖。spawn 的回滚、prune 的正常删除与空壳兜底共用它；空壳清理抛错时打印 `[失败]` 并继续处理后面的 worktree。

### `.dev` 先挪走再删

dev 实例建在 `.dev` 里的链接同样会被跟穿，所以 remove 前把 `.dev` 整体挪到 `.worktrees/.dev-stash-<任务名>`（隐藏、不参与扫描），成功后才删，失败则挪回并恢复链接；挪不动就停在「什么都没改」。remove 失败后查 `git worktree list --porcelain`：仍登记才按删除前记下的原 target 恢复链接；git 已注销则只恢复 `.dev`、不重建链接，并提示需手工删目录、残留分支可用 `git branch -D`。

### 并发与状态

`--apply` 全程持有 `.worktrees/.prune.lock`（`wx` 创建）：两个 prune 同时处理同一 worktree 时，失败方的恢复会重建 junction，而成功方还在递归删除里，会跟穿删掉共享依赖；检测到锁就报「另一个 prune 正在运行」并退出。stale 判定把 PID 存活放在 TTL 之前，活着的持有者超时也绝不回收，只有没有可用 PID 时才按 TTL 回收。已进 main 的分支不再查 PR 状态。

### 错误信息与跨平台门禁

建链接失败给带「链接路径 → 目标」的可读错误再走同一条回滚。Windows 检出上跑门禁时，路径比较前把反斜杠归一成 `/`，按行匹配源码前先归一 CRLF。

## 边界

- 只处理 worktree 根的 `node_modules` 与 `.dev` 整棵目录；其他位置的链接不在范围。拆链接只动链接本身，目标不碰，真实目录保留；不改变依赖共享方式，两平台统一走同一条顺序。
- 只实测了 junction：Windows 目录符号链接与 POSIX 实机未跑，`unlink` 分支由单测覆盖；跨卷/UNC 的重命名未实测。
- prune 锁是仓库级 advisory，只约束本脚本；`.dev` 与 stash 同时存在时安全拒绝，stash 删除失败只警告。
- 回归用例必须落在脚本调用点：只测 helper 时，把 prune 换回直接 `git worktree remove` 仍然全绿。

## 验证

`tests/worktree-common.test.js` 与 `tests/worktree-prune.integration.test.js`：把 prune 调用点换回直接 `git worktree remove` 时集成用例变红，把 TTL 判定放回 PID 之前时「活 PID + 旧 startedAt 的锁不被回收」变红；还原后全绿。
