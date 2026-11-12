# DSH_HOME 取值归一化：照抄宿主 dsh-home-paths

## 背景

PR#97 修了「进程环境没有 `HOME` 时 `resolveDshHome()` 抛 `ERR_INVALID_ARG_TYPE`」，审查同时发现范围外的问题：`resolveDshHome()` 只判空就返回 `DSH_HOME` 原值，而宿主 `@deepseek-ai/dsh-home-paths` 对同一个变量有自己的准则。两边算出的数据根不一致时，本 bundle 的文件会写到宿主不认的位置，或读不到已有数据。

当时 `engines.dsh` 下限是 `>=0.2.1-rc.2`，所以规则要按 rc.2 与最新版各核一遍：`npm pack` 拉 rc.2 的 `lib/index.js`，与本机 rc.5 的那份逐行比对，两版 `expandHomePath` / `resolveRoot` / `resolveDshHome` 逐字相同。核对结论是宿主规则在两版之间没有漂移，本仓不需要按版本分支。

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

### 归一化贯彻到脚本调用点

`home-paths.js` 另导出 `resolveHomeFromEnv(rawHome, fallback, resolveHome)`：有值时走宿主口径，没值时用调用方给的默认根。宿主的默认根是 `~/.dsh`、开发实例是工作树内的 `.dev/home`，默认值不能写死进一个函数，但归一化只有一份。

两个调用点此前各自拼原值：`scripts/start.mjs` 的 `process.env.DSH_HOME || join(homedir(), '.dsh')` 会把 `~/alt` 预检成 `<cwd>/~/alt`，宿主实际去 `~/alt`；`scripts/dev-plan.mjs` 的 `env.DSH_HOME ?? …` 是真 bug——`DSH_HOME=~/.dsh` 是 `assertSeparateHome` 注释里点名的「很自然」写法，不归一化时算出字面 `~` 目录，守卫沉默，派生逻辑把日常 profile 改写成自指死链。

同一个函数里的 `DSH_HOME_SOURCE` 是同一类缺口：`DSH_HOME` 归一后是 `<home>/.dsh`，而 sourceHome 若是字面 `~/.dsh`，守卫比不出同一个目录、同样沉默。两个根现在都走 `resolveHomeFromEnv`——数据根与源根只要拿来互相比较或当实际路径用，就必须是同一套归一化的产物。

### 桌面脚本保留 trim，差异进 limitations

`scripts/desktop-plan.mjs` 仍 trim 取值。它算出的绝对路径经 `--env DSH_HOME=` 交给 `open` 启动的应用，应用不再读原始值；首尾空白按手写笔误处理，比按相对路径算进 cwd 更接近本意。代价是同一个值在桌面侧与 CLI 侧有两套路径，记在 `docs/limitations.md` 的同名条目——卡 #4 要求残留差异有归属，不留在笔记里。

### 回归守卫显式删 HOME

`tests/home-paths.test.js` 的「用 `os.homedir()`」用例显式 `delete process.env.HOME` 再断言。不删的话 Linux CI 上 `HOME` 与 `os.homedir()` 相同，「回退到 `process.env.HOME`」也能通过，守不住 #97 修的 Windows 桌面端回归。

这条守卫带着 #97 的原名（`进程环境没有 HOME 时回落到 os.homedir()`）从 `tests/notification-store.test.js` 搬到 `tests/home-paths.test.js`：解析实现换了位置，回归守卫要跟着实现走，不能跟着旧文件走。

## 边界

- 不 import 宿主包：`engines.dsh` 只承诺版本范围，内部包会随宿主发版漂移（理由见 `src/host/message.js` 头注释）。
- `env.DSH_HOME` 不是字符串（手写的假 env）时按未设处理，宿主那边会抛 `TypeError`。真实 `process.env` 永远是字符串，这条差异不可观测。
- 桌面脚本的 `planDshHomeEnv` 保留自己的拒绝层（相对路径、`~user` 直接报错）：应用由 `open` 启动、不继承这个 shell 的 cwd，`resolve` 出来的绝对路径会和 CLI 不同。脚本算出的绝对路径通过 `--env DSH_HOME=` 显式传给应用，应用侧不再吃原始值。
- 不做 `realpath` 与大小写归一化：宿主也不做，做了反而会和宿主不同。
- 默认根仍是 `join(homedir(), '.dsh')`（PR#97），与 `~` 展开用同一个 `homedir()`，两边不会各自为政。

## 验证

- 用例：`tests/home-paths.test.js` 9 条（含 `resolveHomeFromEnv`、显式删 `HOME` 的回落守卫）+ `tests/dev-plan.test.js` 新增 3 条（`~/.dsh` 守卫、相对路径、空白回落）；`tests/notification-store.test.js` 删掉 `DSH_HOME 优先于默认家目录`（它断言的「原样返回」正是被修掉的行为）。
- 与宿主实现逐值对照：一次性脚本 import 本机 rc.5 的 `dsh-home-paths` 与本仓 `home-paths.js`，喂 18 个取值（`undefined`、`''`、`'   '`、`~`、`~/x`、`~\x`、`~user/x`、`rel/x`、`rel/../x`、`/x/`、`/x/./y/..`、`' /x '`、`C:\x`、`C:x`、`.`、`..`、`~/`、`~//x`），**逐条 SAME，diff=0**。脚本不入库。
- 单测 **1040 / 通过 1031 / 失败 6 / 跳过 3**，失败集合与干净 `origin/main` 基线（1029 / 1020 / 6）逐条同名：4 条 Windows 下 POSIX 路径断言的 desktop-plan 存量失败 + 2 条环境相关（CRLF 骨架、扫描面）。
- 双向验证（Windows）：
  - 撤销归一化（`return configured`）：**9 红**（home-paths 5 + dev-plan 4，含 `~/.dsh` 守卫）。
  - 撤销空白判空（`configured === ''`）：**3 红**。
  - 撤销 `os.homedir()` 回退（默认改成 `() => process.env.HOME`）：**1 红**；把 `HOME` 设成与 `os.homedir()` 相同的值（模拟 Linux CI）**仍红**——修的正是「CI 上碰巧通过」那条。
  - 还原后 66 条相关用例全绿。
- 探针（本机临时脚本，不入库，只读）：`~/.dsh`→`<homedir>\.dsh`、`~/alt`→`<homedir>\alt`、`'   '`→`<homedir>\.dsh`、`rel/dev`→`<cwd>\rel\dev`；旧写法同样输入分别得字面 `~/.dsh` 与 `'   '`。dev 脚本 `DSH_HOME=~/.dsh` 时 home 与 sourceHome 同为 `<homedir>\.dsh` 且 `assertSeparateHome` 抛错。隔离用系统临时目录，不写真实 `~/.dsh`。
- 真实 `~/.dsh` 前后一致：88 个文件，整树（路径 + 大小 + mtime）SHA256 前后同为 `5177920…`，根目录 mtime 不变，0 条变更。
- `npm run check`：笔记格式 70 篇、工具名 14 篇、文档预算（limitations 6705/6900）、语法检查 99 个文件通过；覆盖率门禁因存量单测失败未执行（与基线同）。本机 `home-paths.js` 单跑 `--experimental-test-coverage` 行覆盖 100%。
- CI（Linux，Node 24 与 24.9 两个矩阵）此前对同一实现结构两轮 `check` 全过，覆盖率门禁在那边执行。
