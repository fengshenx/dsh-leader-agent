# 测试临时目录用后即删

## 背景

测试用 `mkdtemp` 造临时目录却从不 `rm`，每跑一次就在系统 temp 里堆一批 `dsh-leader-agent-*`；逐个用例手写清理可行，但漏一次算一次，也没人会回头数 temp 里剩了多少。

## 决策

**临时目录统一登记、测试结束统一删**：`makeTempDir(prefix)` 建目录即登记，`cleanupTempDirs()` 挂在测试文件的 `after` 钩子上；漏删的可能性从「每个用例记得写」降到「文件里写一行钩子」。

**逐个删，不删父目录**：这些目录同级，删父目录会连带别的进程建立的临时目录。

**不引入测试框架**：`node:test` 原生有 `after`，不为清理换 runner。

## 边界

- 只管测试目录；运行时的项目目录（`add_project` 建的工作区）由项目注册表自己管。
- 进程崩溃时 `after` 不跑，目录仍会残留——不为此加补偿逻辑。

## 验证

`tests/projects-store.test.js`、`tests/projects-service.test.js`、`tests/project-session-index.test.js` 走 `tests/helpers/temp-dir.js` 的登记与清理；双向读数：撤掉 `after` 钩子后全量跑一遍 temp 净增非零，还原后净增 0。
