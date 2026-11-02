# win32 上删 worktree 前先拆 node_modules 链接

## 背景

`npm run worktree:spawn` 用 junction 把 worktree 的 `node_modules` 指到主 checkout，省掉一次安装。清理（`worktree:prune --apply`）与建失败回滚都直接调 `git worktree remove --force`。

Windows 上 git 的递归删除会跟随 junction。C:\Temp 临时仓库实测：worktree 里 `mklink /J node_modules shared\node_modules`，remove 之后 `shared\node_modules\esbuild\marker.txt` 消失，只剩空的 `node_modules`——真实流程里就是主 checkout 的依赖被清空。同一机制对子目录里的 junction 也成立：`.dev/home/profiles/web/node_modules/esbuild` 指向共享目录时，`git worktree remove` 同样把目标清空。建 worktree 本身正常，不能因此停用链接共享。

## 决策

### 删除顺序由共享函数固定

- `classifyNodeModulesLink({ stats, platform })` 只认 `isSymbolicLink()`：不存在或真实目录都不拆。真实目录可能是有人在 worktree 里自己 `npm install` 的那份，拆错等于删别人的依赖。Windows 的 junction / 目录符号链接用 `rmdir`，POSIX 符号链接用 `unlink`。
- `teardownWorktree({ dir, platform, stat, detach, remove })` 把顺序写死：先 detach，再调 remove；detach 抛错就不调 remove。拆不掉时宁可留下 worktree，也不能让 git 跟穿链接删共享依赖。IO 由调用方注入，判定本身可单测。
- spawn 的 rollback 与 prune 的正常删除共用这条路径；prune 在 `git worktree remove` 成功后的 `rmSync` 空壳兜底也先走同一套拆除流程。
- `.dev` 里 dev 实例建的逐条链接指向源 profile，同样会被 git 跟穿。prune 在 remove 前把 `.dev` 整体挪到 `.worktrees/.dev-stash-<任务名>`（隐藏目录，不参与扫描），remove 成功后才删；remove 失败则挪回并恢复 node_modules 链接。挪不动（例如开发实例占用文件）就停在「什么都没改」的状态，不会先拆链接再失败。
- prune 的空壳兜底也包 try/catch：清理残留目录抛错时打印 `[失败] <任务名>` 后继续处理后面的 worktree，不再中断整批 `--apply`。
- 已进 main 的分支不再问 gh：`classifyWorktree` 在 `mergedIntoMain` 时不会用到 PR 状态；顺带让临时仓库集成用例不依赖 gh。

### 回归用例钉住调用点

只测 helper 守不住脚本调用点：把 prune 的 `teardown(...)` 换回直接 `git worktree remove`，helper 用例仍然全绿。`tests/worktree-prune.integration.test.js` 在临时 git 仓库里建 junction 与 `.dev`，直接 spawn `worktree-prune.mjs --apply`，断言共享目录 marker 仍在、worktree 已删、`.dev` 暂存已清；调用点一改就会红。

### 建链接失败给可读错误

`symlinkSync` 失败时抛出带「链接路径 → 目标」的错误，再由 rollback 走同一条拆除路径；worktree 删不掉时保留分支并说明，若链接已拆也在错误信息里写明。

### 文档同步

architecture 开发一节与 `worktree-prune.mjs` 头注释不再说「删的只是链接本身」，改成「先挪 `.dev`、再拆链接、最后 `git worktree remove`」，并写明 Windows 上不拆的后果与失败时的恢复动作。

## 边界

- 只处理本仓约定位置：worktree 根的 `node_modules` 与 `.dev` 整棵目录。worktree 里其他位置的链接不在拆除范围。
- `.dev` 先挪到暂存，`git worktree remove` 失败时挪回；只有挪回也失败时数据留在 `.worktrees/.dev-stash-<任务名>`，错误信息会带路径。成功删除后暂存也会清掉，清不掉时打印警告与残留路径。
- 拆链接只动链接本身，链接目标（主 checkout 与源 profile 的依赖）不碰；真实目录一律保留。
- 不改变依赖共享方式，也不处理 POSIX 上 git 不跟穿链接的差异——两条平台统一走同一条拆除顺序。
- Windows 目录符号链接未实测（本机没有 `SeCreateSymbolicLinkPrivilege`），只验证了 junction；POSIX 实机未跑，`unlink` 分支由单测覆盖。
- `classifyNodeModulesLink` 的 `reason` 固定写「指向主 checkout」，只被测试使用，无功能影响。
- 复现与探针都在 C:\Temp 临时仓库里做，没有拿本仓的 `node_modules` 当靶子。

## 验证

`tests/worktree-common.test.js` 新增 7 条用例：链接判定（不存在 / 真实目录 / win32 rmdir / POSIX unlink）四条，`teardownWorktree` 的拆除顺序、真实目录不拆、detach 失败后不 remove 三条。`tests/worktree-prune.integration.test.js` 新增 1 条临时仓库集成用例（win32 执行，其它平台跳过）：建 junction 与 `.dev` → spawn `worktree-prune.mjs --apply` → 断言共享 marker 仍在、worktree 已删、`.dev` 暂存已清。

双向验证（Windows 11 / node 24.13.0）：

| 撤销的修复 | 读数 |
|---|---|
| `teardownWorktree` 恢复成直接 `remove`，不拆链接 | `worktree-common.test.js` 16 tests / 14 pass / **2 fail**：`先拆 node_modules 链接再执行删除`（actual 只有 `remove`）、`拆链接失败时不再执行删除，避免 git 跟穿链接`（missing expected exception） |
| prune 调用点换回直接 `git worktree remove` | 集成用例 1 test / 0 pass / **1 fail**：`共享依赖被 git 跟穿删除`（false !== true）；worktree 仍被删，共享 marker 已消失 |
| 还原 | 集成 1/1 pass；整条 `npm run check` **792 tests / 789 pass / 0 fail / 3 skipped**，exit 0 |

C:\Temp 临时仓库复现（修复前）：`git worktree remove --force` 后共享目录只剩空 `node_modules`，`esbuild\marker.txt` 消失；worktree 根部的 junction 与 `.dev/home` 里的嵌套 junction 都会跟穿。修复前探针另确认：Node 的 `rmdirSync(junction)` / `rmSync` 都只删链接、目标保留，`unlinkSync` 在 Node 24 上对 junction 也能成功。

失败路径（C:\Temp 临时仓库，均用修复后的脚本）：

- `git worktree remove` 失败：把忽略文件用 `FileShare.None` 占住。输出 `[失败] wt-fail3: git worktree remove 失败（error: failed to delete …）；worktree 保留，.dev 已挪回，node_modules 链接已恢复`。删后 worktree 仍在、`.dev/home/session.json` 在、根 junction 在、共享 marker 在、没有 `.dev-stash-*` 残留。
- `.dev` 被占用：rename 抛 `EPERM: operation not permitted, rename …`，脚本在拆链接之前停下，输出 `[失败] wt-dev: 挪走 .dev 失败，worktree 未动（…）`；链接、数据、共享 marker 均在，无暂存。解除占用后重跑输出 `[已删] wt-dev（feature/dev）`，收敛。

win32 真机成功路径（Windows 11 / node 24.13.0，全部用本 PR 的脚本，cwd 在主 checkout）：

1. `node .worktrees/win32-worktree/scripts/worktree-spawn.mjs wt-demo2` → 建出 `.worktrees/wt-demo2`，`node_modules` 是 Junction，Target 指向主 checkout 的 `node_modules`。
2. 在主 checkout 的 `node_modules` 放 `.win32-worktree-demo-marker`（并确认 `esbuild/package.json` 在）；在 `wt-demo2/.dev` 放会话数据，并在其 profile 的 `node_modules/esbuild` 建 Junction 指向 `C:\Temp\wt-demo2-shared\node_modules\esbuild`，目标里放 `marker.txt`。
3. `node .worktrees/win32-worktree/scripts/worktree-prune.mjs wt-demo2 --apply` → 输出 `[已删] wt-demo2（feature/wt-demo2）`。
4. 删后读数：worktree 目录不存在；主 checkout 的 marker 与 `esbuild` 依赖仍在；`C:\Temp\wt-demo2-shared` 的 marker 仍在；没有 `.dev-stash-*` 残留；`feature/wt-demo2` 本地分支已删；主 checkout `git status --porcelain` 为空。

`npm run check` 整条：Agent Note 51 篇格式合规、文档工具名 11 篇、语法检查 84 文件、单测 792 用例 / 789 通过 / **0 失败** / 3 跳过，exit 0（改动前基线 784 / 781 / 3 / 0）。
