# 测试临时目录用后即删

**范围**：`tests/helpers/temp-dir.js`、`tests/projects-store.test.js`、`tests/projects-service.test.js`、`tests/project-session-index.test.js`

## 背景

macOS 的系统 temp 里堆了 **4107 个** `dsh-leader-kit-*` 目录（本仓前缀，最早的建于 10 月 26 日）。逐个查下来，来源是三个测试文件：`projects-store.test.js`、`projects-service.test.js`、`project-session-index.test.js`——它们用 `mkdtemp` 造临时目录，但一个 `rm` 都没有。目录数与用例数成正比，跑一次测试涨一批，跑了多少遍就堆多少个。

其余测试文件各自在用例末尾 `await rm(...)`，是逐个用例手动清理。这条路可行，但漏一次就漏一次，且没人会回去数 temp 里剩了多少。

## 决策

**临时目录统一登记，测试结束统一删**。新增 `tests/helpers/temp-dir.js`：`makeTempDir(prefix)` 建目录并登记，`cleanupTempDirs()` 逐个删除。用例只管建目录，清理挂在测试文件的 `after` 钩子上——漏删的可能性从「每个用例记得写」降到「文件里写一行钩子」。

**逐个删，不删父目录**。这些目录同级，删父目录会连同别的进程建的临时目录一起删掉。

**不引入测试框架**。仓库用 Node 内置 `node:test`，`after` 钩子原生可用，无需为清理换 runner。

## 边界

- **只管测试目录**。运行时的项目目录（`add_project` 建的工作区）不在此列，由项目注册表自己管。
- **进程崩溃时仍会残留**。`after` 钩子不跑，目录就留在 temp 里——这是所有测试临时目录的共性，不为它加补偿逻辑。

## 证据

清理前：系统 temp 里 7092 个 `dsh-leader-kit-*` 目录（前缀分布 `projects-` 3651、`work-` 2520、`dir-` 456、`index-` 456，其余为其他测试文件的历史残留）。

修复后跑全量 209 例（`npm run check`），temp 目录数**净增 0**；从零残留状态再跑一遍，仍是 0。
