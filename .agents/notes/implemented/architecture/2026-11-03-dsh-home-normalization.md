# Agent Note: DSH_HOME 取值归一化：照抄宿主 dsh-home-paths

Status: implemented

## Problem

`resolveDshHome()` 曾只判空就返回 `DSH_HOME` 原值，而宿主 `dsh-home-paths` 对同一个变量有自己的准则；两边算出的数据根不一致时，本 bundle 的文件会写到宿主不认的位置，或读不到已有数据。本仓支持 `engines.dsh >= 0.2.1-rc.2`，规则按 rc.2 与最新版各核一遍，两版实现逐字相同，因此不需要按版本分支。

## Decision

- **逐条照抄宿主规则**：未设、`''`、`'   '` 落 `join(homedir(), '.dsh')`；`~` 落 `homedir()`；`~/x`、`~\x` 落 `join(homedir(), 'x')`；`~user/x`、相对路径、带首尾空白的值都走 `resolve`（相对 cwd）；绝对路径与 Windows 盘符路径由 `resolve` 消掉末尾分隔符与 `.`、`..`。
- **判空用 trim，取值不 trim**：宿主只拿 `trim().length > 0` 判空，交给 `resolve` 的仍是原值；这里若顺手 trim，两边立刻分叉——正是这条归一化要消灭的症状。
- **一处实现，host 与桌面脚本共用**：导出与宿主同名的 `expandHomePath` / `resolveDshHome`，通知队列不再自己解析、桌面脚本改为 re-export。同一规则的第二次实现迟早漂移，而它算错的是 desktop profile 的路径。
- **默认根可注入，归一化只有一份**：`resolveHomeFromEnv(rawHome, fallback, resolveHome)`——有值走宿主口径，没值用调用方的默认根（宿主的 `~/.dsh` 与开发实例的工作树内 `.dev/home` 不能写死进同一个函数）。
- **归一化贯彻到脚本调用点**：数据根与源根只要拿来互相比较或当实际路径用，就必须是同一套归一化的产物；否则 `assertSeparateHome` 比不出同一个目录、守卫沉默，派生逻辑会把日常 profile 改写成自指死链。
- **桌面脚本保留 trim，差异记入 limitations**：桌面脚本算出的绝对路径经 `--env DSH_HOME=` 交给 `open` 启动的应用，应用不再读原始值；首尾空白按手写笔误处理。代价是同一个值在桌面侧与 CLI 侧有两套路径，记在 `docs/limitations.md`，不留在笔记里。
- **回归守卫显式删 `HOME`**：测试里 `delete process.env.HOME` 再断言，否则 Linux CI 上 `HOME` 与 `os.homedir()` 相同，「回退到 `process.env.HOME`」也能通过，守不住 Windows 桌面端的回归。守卫跟着实现搬到 `tests/home-paths.test.js`。

## Alternatives considered

- **import 宿主 `dsh-home-paths`**：`engines.dsh` 只承诺版本范围，内部包会随发版漂移；逐条照抄规则、零依赖。
- **保留原来的「只判空就返回」**：与宿主算出的数据根不一致，文件会写到宿主不认的位置；这正是要消灭的症状。
- **顺手 trim 取值**：宿主只 trim 判空、不 trim 取值；两边会立刻分叉。
- **按宿主版本分支**：rc.2 与最新版的实现逐字相同，分支没有收益。

## Consequences

- **不 import 宿主包**：`engines.dsh` 只承诺版本范围，内部包会随宿主发版漂移。
- **`env.DSH_HOME` 不是字符串时按未设处理**（宿主那边会抛 `TypeError`）；真实 `process.env` 永远是字符串，差异不可观测。
- **桌面脚本保留自己的拒绝层**（相对路径、`~user` 直接报错）：应用由 `open` 启动、不继承该 shell 的 cwd，算出的绝对路径经 `--env` 显式传给应用。
- **不做 `realpath` 与大小写归一化**：宿主也不做，做了反而会和宿主不同。
- **默认根仍是 `join(homedir(), '.dsh')`**，与 `~` 展开用同一个 `homedir()`。

收益：本 bundle 与宿主、桌面脚本算出同一个数据根，`DSH_HOME` 不会再分叉。

## Testing

`tests/home-paths.test.js` 与 `tests/dev-plan.test.js` 钉住逐值口径与守卫。与宿主实现逐值对照（含空白、`~user`、Windows 盘符等 18 个取值）diff=0；双向读数：撤销归一化，`~/.dsh` 守卫用例变红，撤销 `os.homedir()` 回退并把 `HOME` 设成与它相同仍红——证明守卫不靠环境巧合通过。
