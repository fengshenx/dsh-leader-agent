# win32 上删 worktree 前先拆 node_modules 链接

## 背景

`npm run worktree:spawn` 用 junction 把 worktree 的 `node_modules` 指到主 checkout，省掉一次安装。清理（`worktree:prune --apply`）与建失败回滚都直接调 `git worktree remove --force`。

Windows 上 git 的递归删除会跟随 junction。C:\Temp 临时仓库实测：worktree 里 `mklink /J node_modules shared\node_modules`，remove 之后 `shared\node_modules\esbuild\marker.txt` 消失，只剩空的 `node_modules`——真实流程里就是主 checkout 的依赖被清空。同一机制对子目录里的 junction 也成立：`.dev/home/profiles/web/node_modules/esbuild` 指向共享目录时，`git worktree remove` 同样把目标清空。建 worktree 本身正常，不能因此停用链接共享。

## 决策

### 删除顺序由共享函数固定

- `classifyNodeModulesLink({ stats, platform })` 只认 `isSymbolicLink()`：不存在或真实目录都不拆。真实目录可能是有人在 worktree 里自己 `npm install` 的那份，拆错等于删别人的依赖。Windows 的 junction / 目录符号链接用 `rmdir`，POSIX 符号链接用 `unlink`。
- `teardownWorktree({ dir, platform, stat, detach, remove })` 把顺序写死：先 detach，再调 remove；detach 抛错就不调 remove。拆不掉时宁可留下 worktree，也不能让 git 跟穿链接删共享依赖。IO 由调用方注入，判定本身可单测。
- spawn 的 rollback 与 prune 的正常删除共用这条路径；prune 在 `git worktree remove` 成功后的 `rmSync` 空壳兜底也先走同一套拆除流程。
- `.dev` 里 dev 实例建的逐条链接指向源 profile，同样会被 git 跟穿；prune 在 remove 前先 `rmSync(.dev, { recursive: true })`。Node 的 rmSync 不跟随 junction（实测目标保留），而这份数据本来就随 worktree 丢弃。

### 建链接失败给可读错误

`symlinkSync` 失败时抛出带「链接路径 → 目标」的错误，再由 rollback 走同一条拆除路径；worktree 删不掉时保留分支并说明，不假装回滚成功。

### 文档同步

architecture 开发一节与 `worktree-prune.mjs` 头注释不再说「删的只是链接本身」，改成「先拆链接再 `git worktree remove`」，并写明 Windows 上不拆的后果。

## 边界

- 只处理本仓约定位置：worktree 根的 `node_modules` 与 `.dev` 整棵目录。worktree 里其他位置的链接不在拆除范围。
- `.dev` 先删意味着 `git worktree remove` 失败时开发实例数据已丢——那是 `--apply` 已承诺要删的数据。
- 拆链接只动链接本身，链接目标（主 checkout 与源 profile 的依赖）不碰；真实目录一律保留。
- 不改变依赖共享方式，也不处理 POSIX 上 git 不跟穿链接的差异——两条平台统一走同一条拆除顺序。
- 复现与探针都在 C:\Temp 临时仓库里做，没有拿本仓的 `node_modules` 当靶子。

## 验证

`tests/worktree-common.test.js` 新增 7 条用例：链接判定（不存在 / 真实目录 / win32 rmdir / POSIX unlink）四条，`teardownWorktree` 的拆除顺序、真实目录不拆、detach 失败后不 remove 三条。

双向验证（Windows 11 / node 24.13.0）：

| 撤销的修复 | 读数 |
|---|---|
| `teardownWorktree` 恢复成直接 `remove`，不拆链接 | `worktree-common.test.js` 16 tests / 14 pass / **2 fail**：`先拆 node_modules 链接再执行删除`（actual 只有 `remove`）、`拆链接失败时不再执行删除，避免 git 跟穿链接`（missing expected exception） |
| 还原 | 同一文件 16 tests / 16 pass；整条 `npm run check` 791 tests / 788 pass / 0 fail / 3 skipped，exit 0 |

C:\Temp 临时仓库复现（修复前）：`git worktree remove --force` 后共享目录只剩空 `node_modules`，`esbuild\marker.txt` 消失；worktree 根部的 junction 与 `.dev/home` 里的嵌套 junction 都会跟穿。修复前探针另确认：Node 的 `rmdirSync(junction)` / `rmSync` 都只删链接、目标保留，`unlinkSync` 在 Node 24 上对 junction 也能成功。

win32 真机（Windows 11 / node 24.13.0，全部用本 PR 的脚本，cwd 在主 checkout）：

1. `node .worktrees/win32-worktree/scripts/worktree-spawn.mjs wt-demo` → 建出 `.worktrees/wt-demo`，`node_modules` 是 Junction，Target 指向主 checkout 的 `node_modules`。
2. 在主 checkout 的 `node_modules` 放 `.win32-worktree-demo-marker`（并确认 `esbuild/package.json` 在）；在 `wt-demo/.dev/home/profiles/web/node_modules/esbuild` 建 Junction 指向 `C:\Temp\wt-demo-shared\node_modules\esbuild`，目标里放 `marker.txt`。
3. `node .worktrees/win32-worktree/scripts/worktree-prune.mjs wt-demo --apply` → 输出 `[已删] wt-demo（feature/wt-demo）`。
4. 删后读数：worktree 目录不存在；主 checkout 的 marker 与 `esbuild` 依赖仍在；`C:\Temp\wt-demo-shared` 的 marker 仍在；`feature/wt-demo` 本地分支已删；主 checkout `git status --porcelain` 为空，`git worktree list` 只剩主 checkout 与本任务 worktree。

`npm run check` 整条：Agent Note 51 篇格式合规、文档工具名 11 篇、语法检查 84 文件、单测 791 用例 / 788 通过 / **0 失败** / 3 跳过，exit 0（改动前基线 784 / 781 / 3 / 0）。
