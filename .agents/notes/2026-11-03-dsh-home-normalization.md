# DSH_HOME 取值归一化：照抄宿主 dsh-home-paths

## 背景

PR#97 修了「进程环境没有 `HOME` 时 `resolveDshHome()` 抛 `ERR_INVALID_ARG_TYPE`」，审查同时发现范围外的问题：`resolveDshHome()` 只判空就返回 `DSH_HOME` 原值，而宿主 `@deepseek-ai/dsh-home-paths` 对同一个变量有自己的准则。两边算出的数据根不一致时，本 bundle 的文件会写到宿主不认的位置，或读不到已有数据。

`engines.dsh` 下限是 `>=0.2.1-rc.2`，所以规则要按 rc.2 与最新版各核一遍：`npm pack` 拉 rc.2 的 `lib/index.js`，与本机 rc.5 的那份逐行比对，两版 `expandHomePath` / `resolveRoot` / `resolveDshHome` 逐字相同。核对结论是宿主规则在两版之间没有漂移，本仓不需要按版本分支。

## 决策

### 逐条照抄宿主规则

| `DSH_HOME` 取值 | 宿主结果 | 本仓旧实现 | 现在 |
|---|---|---|---|
| 未设、`''`、`'   '` | `join(homedir(), '.dsh')` | 同 | 同 |
| `~` | `homedir()` | 原值 `'~'` | `homedir()` |
| `~/x`、`~\x` | `join(homedir(), 'x')` | 原值 | 同宿主 |
| `~user/x` | `resolve('<cwd>/~user/x')` | 原值 | 同宿主 |
| 相对路径 `rel/x` | `resolve('<cwd>/rel/x')` | 原值（相对串） | 同宿主 |
| 绝对路径 `/x/`、`/x/./y/..` | `resolve` 消掉末尾分隔符与 `.`、`..` | 原值 | 同宿主 |
| 带首尾空白 `' /x '` | `resolve('<cwd>/ /x ')` | 原值 | 同宿主 |
| Windows 盘符 `C:\x` | `resolve('C:\x')` | 原值 | 同宿主 |
| Windows 盘符相对 `C:x` | `resolve('C:x')`（该盘的 cwd） | 原值 | 同宿主 |

### 判空用 trim，取值不 trim

宿主 `resolveRoot` 里的 `fromEnv.trim().length > 0` 只用来判空，交给 `resolve` 的仍是未 trim 的原值。本仓照抄：`DSH_HOME='  /x  '` 时两边都落到 `<cwd>/  /x  ` 这条路径。这里若顺手 trim，两边立刻分叉——正是本卡要消灭的症状。

### 一处实现，host 与桌面脚本共用

新增 `src/host/home-paths.js`，导出与宿主同名的 `expandHomePath` 与 `resolveDshHome`；`notification-store.js` 不再自己解析，`scripts/desktop-plan.mjs` 的 `expandHomePath` 改为 re-export。桌面脚本里此前那份实现注释写着「照抄宿主同一套口径」，是同一规则的第二次实现；留两份迟早漂移，而它算错的是 desktop profile 的路径。

## 边界

- 不 import 宿主包：`engines.dsh` 只承诺版本范围，内部包会随宿主发版漂移（理由见 `src/host/message.js` 头注释）。
- `env.DSH_HOME` 不是字符串（手写的假 env）时按未设处理，宿主那边会抛 `TypeError`。真实 `process.env` 永远是字符串，这条差异不可观测。
- 桌面脚本的 `planDshHomeEnv` 保留自己的拒绝层（相对路径、`~user` 直接报错）：应用由 `open` 启动、不继承这个 shell 的 cwd，`resolve` 出来的绝对路径会和 CLI 不同。脚本算出的绝对路径通过 `--env DSH_HOME=` 显式传给应用，应用侧不再吃原始值。
- 不做 `realpath` 与大小写归一化：宿主也不做，做了反而会和宿主不同。
- 默认根仍是 `join(homedir(), '.dsh')`（PR#97），与 `~` 展开用同一个 `homedir()`，两边不会各自为政。

## 验证

- 新增 `tests/home-paths.test.js` 8 条用例，覆盖上表每一行；`tests/notification-store.test.js` 删掉 `DSH_HOME 优先于默认家目录`（它断言的「原样返回」正是被修掉的行为）。
- 双向验证（Windows）：
  - 撤销归一化（`return configured`）：4 条红——绝对路径归一化、`~` 系列、`~user`、首尾空白。盘符用例在 Windows 上原值即正确，故未红（POSIX 上会红）。
  - 撤销空白判空（`configured === ''`）：1 条红（空白回落）。
  - 还原后 8 条全绿。
- `npm run check`：笔记格式、工具名、文档预算、语法检查通过；覆盖率门禁因存量单测失败未执行（见下）。
- 单测 1036 / 通过 1027 / 失败 6，失败集合与干净 `origin/main` 基线（1029 / 1020 / 6）逐条相同：4 条是 Windows 下 POSIX 路径断言的 desktop-plan 存量失败，2 条是 CRLF 与扫描面环境相关。本机走不到覆盖率判定，`home-paths.js` 的 per-file 100% 要在 CI（Linux）上取读数。
