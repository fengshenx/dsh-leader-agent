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
- `--apply` 全程持有 `.worktrees/.prune.lock`（`wx` 创建）：两个 prune 同时处理同一个 worktree 时，失败方会在恢复分支重建 junction，而成功方还在 `git worktree remove` 的递归里，会跟穿删掉共享依赖。第二个进程检测到锁就报「另一个 prune 正在运行」并退出。stale 判定把 PID 存活放在 TTL 之前：活着的持有者超过 10 分钟也绝不回收（远端 push 挂起、超大 worktree、休眠都可能拖长），只有没有可用 PID 时才按 TTL 回收。
- remove 失败后先查 `git worktree list --porcelain`：仍登记才恢复链接，且用删除前 `readlinkSync` 记下的原 target（相对路径按工作树解析）；git 已注销则只恢复 `.dev`、不重建链接，明确提示重跑 prune 不会处理、需手工删目录，并说明残留分支可用 `git branch -D` 处理，避免制造无人管理的 junction。

### 回归用例钉住调用点

只测 helper 守不住脚本调用点：把 prune 的 `teardown(...)` 换回直接 `git worktree remove`，helper 用例仍然全绿。`tests/worktree-prune.integration.test.js` 在临时 git 仓库里建 junction 与 `.dev`，直接 spawn `worktree-prune.mjs --apply`，覆盖成功删除、活 PID+旧 TTL 持锁退出、stale 锁回收、`.dev` 暂存接管、remove 失败按原 target 恢复链接、remove 失败且 git 已注销、`.dev` 与暂存同时存在时拒绝；调用点一改就会红。

S2 用例用「子进程把 worktree 作为 cwd」稳定制造删除失败：Windows 删不掉仍被当作 cwd 的目录，git 先注销登记、再在删目录时返回非零，正好走到已注销分支；之后断言目录保留、`.dev` 回位、链接不重建、分支保留且提示可 `git branch -D`。

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
- prune 锁是仓库级 advisory，只约束本脚本：手工 `git worktree remove` 或旧版本脚本不受它约束。PID 活着的锁绝不回收；只有没有可用 PID 时才走 TTL，并用文件内容比对缩小误删新锁的窗口。
- `.dev` 与 `.dev-stash-<任务名>` 同时存在时安全拒绝并给出路径；stash 删除失败只警告、数据不丢；隐藏 stash 同名碰撞待确认（任务名不允许以 `.` 开头）；跨卷/UNC 的 `renameSync` EXDEV 未实测。
- 看板所在右栏的默认宽度由宿主决定（首次打开 `max(300, round(视口宽 × 45%))`），本插件没有设置入口；缺口见 `docs/capability-gaps.md` 第 42 条。
- 复现与探针都在 C:\Temp 临时仓库里做，没有拿本仓的 `node_modules` 当靶子。

## 验证

`tests/worktree-common.test.js` 新增 7 条用例：链接判定（不存在 / 真实目录 / win32 rmdir / POSIX unlink）四条，`teardownWorktree` 的拆除顺序、真实目录不拆、detach 失败后不 remove 三条。`tests/worktree-prune.integration.test.js` 7 条临时仓库集成用例（win32 执行，其它平台跳过）：成功删除、活 PID + 旧 TTL 持锁退出、stale 锁回收、`.dev` 暂存接管、remove 失败按原 target 恢复链接、remove 失败且 git 已注销、`.dev` 与暂存同时存在时拒绝。

### B1 并发锁

C:\Temp 探针：同一临时仓库、同一 worktree，每次同时起 10 个 prune 进程，重复 20 次。

| 版本 | 读数 |
|---|---|
| 本 PR（加锁） | 20/20 次共享 marker 保留，**0 次丢失**；共 179 条「另一个 prune 正在运行」（预期 180 条，少数进程在成功方删完后才扫描，直接 exit 0） |
| 4b47f39（去锁） | 20 次里 **1 次丢失**（iter 9，共享目录 marker 消失）；另加跑 5 次为 0 次，合计 25 次中 1 次 |

### 锁 TTL 顺序

把 `lockIsStale` 的 TTL 判断改回 PID 之前：活 PID + 一小时前 `startedAt` 的锁被回收，prune 继续执行，用例 `win32 上活 PID + 旧 startedAt 的锁不会被回收` 红。读数：集成 **7 tests / 6 pass / 1 fail**（`持锁时没有退出`）；改回 PID 优先后 7/7 pass。

### S1 原 target 恢复

集成用例把 worktree 的 `node_modules` 指向临时共享目录（不是主 checkout 的 `node_modules`），再用 `git worktree lock` 让 remove 失败：脚本恢复后的链接 target 仍是原共享目录，`.dev` 与 marker 都在。把恢复目标改回 `join(root, 'node_modules')` 时，同一用例 **6 tests / 5 pass / 1 fail**：`链接 target 被改写`；还原后 6/6 pass。

### S2 git 已注销

集成用例用子进程把 worktree 当作 cwd：Windows 删不掉仍被当作 cwd 的目录，`git worktree remove` 会先注销登记、再在删目录时返回非零，稳定走到已注销分支。断言输出含：

```
git 已注销该 worktree，重跑 prune 不会处理，请手工删除目录；
分支 feature/int 仍在，确认不需要后可 git branch -D feature/int
```

删后 worktree 目录仍在、`.dev/home/session.json` 已挪回、根链接**没有**被重建、共享 marker 在、分支仍保留、锁已释放。

### S3 集成用例

- 手动把 `.dev` 挪成 `.dev-stash-wt-int` 后跑 prune：输出 `[已删] wt-int`，worktree 与 stash 都清掉，共享 marker 在。
- `.dev` 与 stash 同时存在：输出 `[失败] wt-int … 同时存在`，两边数据都在、根链接未拆、marker 未丢。

### 其余双向读数

| 撤销的修复 | 读数 |
|---|---|
| `teardownWorktree` 恢复成直接 `remove`，不拆链接 | `worktree-common.test.js` 16 tests / 14 pass / **2 fail**：`先拆 node_modules 链接再执行删除`、`拆链接失败时不再执行删除，避免 git 跟穿链接` |
| prune 调用点换回直接 `git worktree remove` | 集成用例 **7 tests / 2 pass / 5 fail**：成功删除、stale 锁回收、暂存接管、按原 target 恢复链接、已注销分支提示五条红；持锁退出与 `.dev`+stash 拒绝两条绿（它们本来就不走 remove） |
| 还原 | 集成 7/7 pass；整条 `npm run check` **798 tests / 795 pass / 0 fail / 3 skipped**，exit 0 |

C:\Temp 临时仓库复现（修复前）：`git worktree remove --force` 后共享目录只剩空 `node_modules`，`esbuild\marker.txt` 消失；worktree 根部的 junction 与 `.dev/home` 里的嵌套 junction 都会跟穿。修复前探针另确认：Node 的 `rmdirSync(junction)` / `rmSync` 都只删链接、目标保留，`unlinkSync` 在 Node 24 上对 junction 也能成功。

`.dev` 被占用（rename EPERM）时脚本在拆链接之前停下：链接、数据、共享 marker 均在，无暂存；解除占用后重跑输出 `[已删]`，收敛。

win32 真机成功路径（Windows 11 / node 24.13.0，全部用本 PR 的脚本，cwd 在主 checkout）：

1. `node .worktrees/win32-worktree/scripts/worktree-spawn.mjs wt-demo3` → 建出 `.worktrees/wt-demo3`，`node_modules` 是 Junction，Target 指向主 checkout 的 `node_modules`。
2. 主 checkout 的 `node_modules` 放 marker；在 `wt-demo3/.dev` 放会话数据，并在其 profile 的 `node_modules/esbuild` 建 Junction 指向 `C:\Temp\wt-demo3-shared\node_modules\esbuild`，目标里放 marker。
3. `node .worktrees/win32-worktree/scripts/worktree-prune.mjs wt-demo3 --apply` → 输出 `[已删] wt-demo3（feature/wt-demo3）`。
4. 删后读数：worktree 目录不存在；主 checkout 的 marker 与 `esbuild` 依赖仍在；`C:\Temp\wt-demo3-shared` 的 marker 仍在；没有 `.dev-stash-*` 残留、`.prune.lock` 已释放；`feature/wt-demo3` 本地分支已删；主 checkout `git status --porcelain` 为空。

`npm run check` 整条：Agent Note 51 篇格式合规、文档工具名 11 篇、语法检查 84 文件、单测 798 用例 / 795 通过 / **0 失败** / 3 跳过，exit 0（改动前基线 784 / 781 / 3 / 0）。

### 追加项（2026-11-03）

- **测试夹具噪声**：`makeFixture` 的 git 调用统一显式 `-c core.autocrlf=false`，并用 `stdio: ['ignore', 'pipe', 'pipe']` 捕获 stderr。修复前集成用例每轮往父进程 stderr 打印 7 次 `warning: ... LF will be replaced by CRLF` 与 7 次 `Preparing worktree`；修复后同一文件 7/7 pass，`npm run check 2>&1` 过滤 `warning|Preparing worktree` **0 行**；合并 `origin/main` 后整条 817 / 814 / 0 / 3、exit 0。
- **右栏默认宽度**：看板自动打开时跟随宿主 AppFrame 的默认值 `max(300, round(视口宽 × 45%))`；`ctx.layout` 没有宽度入口，sidebar-right 的 localStorage 也不存列宽。本仓不改宿主，只做缺口记录，见 `docs/capability-gaps.md` 第 42 条。
