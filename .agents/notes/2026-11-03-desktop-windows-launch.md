# 桌面启动补 Windows：exe 定位、tasklist 探活、detached spawn

**状态**：implemented（2026-11-03）
**范围**：`scripts/{desktop,desktop-plan}.mjs`、`tests/{desktop-plan,spawn-command-usage}.test.js`、`docs/development.md`

## 背景

`npm run desktop` 第一版（见 [desktop-profile-install](2026-11-03-desktop-profile-install.md)）只在 macOS 上探活与拉起应用；Windows 上只完成 profile 写入，然后提示手动打开。用户在 Windows 上问「为什么不从命令行启动桌面 app」，要求补上。

宿主侧形态决定了 Windows 的实现方式：

- `apps/desktop/src/single-instance.ts` 用 `requestSingleInstanceLock`，已有实例时新进程直接 `quit()`——所以「应用已在运行」时再启动一次不会报错，环境变量也不会生效，与 macOS `open --env` 对已运行实例的静默失效同构。
- `electron-builder.config.mjs`：`productName: 'DeepSeek Harness'`、Windows 目标 `nsis`、`perMachine: false`、`allowToChangeInstallationDirectory: false`。安装目录因此固定为 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，exe 名与 `productName` 相同（本机实测：该路径与注册表 `InstallLocation` 一致，exe 为 `DeepSeek Harness.exe`）。
- profile 位置、manifest 形状、`<profile>/lock` 协议都是宿主用 `join` 拼的，跨平台同一套；两端差异只在「怎么找到/探活/启动应用」这三处。

## 决策

### 三个平台分支收敛成「启动目标」+ 两处分派

`desktopTarget(appName, { homeDir, env })` 返回 `{ kind: 'app' | 'exe' | 'unsupported', path }`：macOS 解析 `.app`，Windows 解析 exe，其余平台 `path === null` 且只挂载。探活 `desktopAppRunning(target)` 与启动 `launchDesktopApp(target, …)` 只看 `kind`，不各自散落 `process.platform` 判断。

支持的平台上找不到目标时在挂载分支 `throw missingAppMessage()`：再往下走会把 profile 挂好、然后无声地不启动。`--remove` 分支在此之前返回，不受影响（应用改名、卸载后仍要能摘）。

### Windows 定位：候选路径由纯函数算，每用户安装优先

`windowsExeCandidates` 收 `DSH_DESKTOP_APP` 的三种写法，统一成候选列表，IO 层挑第一个存在的：

- 裸名（`DeepSeek Harness` / `DeepSeek Harness.exe`）→ `%LOCALAPPDATA%\Programs\<名>`、`%ProgramFiles%\<名>`、`%ProgramFiles(x86)%\<名>`，各自补 `<名>.exe`。每用户安装是宿主当前配置，排第一。
- 含分隔符或以 `~` 开头 → 当路径：以 `.exe` 结尾就只认那一处；否则当安装目录，补 `<目录名>.exe`（展开 `~` 与 `~\`，与 `DSH_HOME` 同一套 `expandHomePath`）。

不查注册表：`perMachine: false` + 不允许改安装目录已经把位置钉死，多一次 `reg query` 只是给每个会话加启动延迟；写不进候选列表的位置由人用 `DSH_DESKTOP_APP` 指定。

### 探活用 `tasklist` 的 CSV 输出，不用默认表格

默认表格把 Image Name 截到 25 字符，`DeepSeek Harness.exe` 正好 19、能过，但改个长名就漏判；CSV（`/FO CSV /NH`）给完整名字。没有匹配时 tasklist 打的是**本地化**提示行（英文 `INFO: No tasks are running…`、中文「信息: 没有运行的任务匹配指定标准。」），因此 `parseTasklistImages` 只认以引号开头的行，不按文本内容比对。`tasklist.exe` 走 `%SystemRoot%\system32` 绝对路径，不依赖 PATH 里有没有 System32。

### 启动用 detached `spawn`，`DSH_HOME` 放进子进程环境

Windows 不需要 macOS 的 `open --env` 通道：`spawn(exe, [], { env: { ...process.env, DSH_HOME: dshHome }, detached: true, stdio: 'ignore', windowsHide: true })` 就是应用的环境。`detached` + `unref` 必须有——`npm run` 的父进程先退出，不脱离会把应用一起收走。成功判据是 `'spawn'` 事件（进程创建成功），`ENOENT` / `EACCES` 走 `error` 事件。

`desktop.mjs` 因此直接引 `node:child_process` 的 `spawn`，在 `tests/spawn-command-usage.test.js` 的允许清单里登记了理由：起的是 GUI exe，不经 Windows 的 npm/dsh shim，也不能经 `cmd.exe`（那会让 cmd 成为父进程并等应用退出）。

### 探不到运行态仍然 fail closed

两端都是「探不到就不自动启动」，只打印带 `DSH_HOME` 的手动命令：Windows 的单实例冲突会让新进程静默退出，探不到就无法排除这种情形，赌一次的结果是脚本报「已启动」而应用仍在读旧数据根。

## 边界

- **探活与启动之间仍有竞态**：应用在这段窗口里被手动打开时，新进程自行退出，脚本仍报「已启动」。macOS 由 `open` 的 stderr 兜住，Windows 没有等价信号；没有做 PID 复查（要多等一次 `tasklist`），下次重跑会被探活拦住。
- **只认宿主当前的安装布局**：`%LOCALAPPDATA%\Programs` / `%ProgramFiles%` / `%ProgramFiles(x86)%`。绿色版、改过安装目录的实例要 `DSH_DESKTOP_APP` 指到 exe 或安装目录。
- **`tasklist` 每次全量输出**：加了 `/FI "IMAGENAME eq …"` 会快一些，但 IMAGENAME 过滤对超长名字不可靠，这里选了「解析全量、自己比对」。
- **`link:` 是平台绝对路径**：`$DSH_HOME` 若被跨机同步（OneDrive、网络盘），macOS 写的 `link:/Users/…` 在 Windows 上无效。既有约束，本次未改变。
- **候选根先 trim 再拼**：`join('', 'Programs')` 得到相对路径 `Programs`，按 cwd 解析会指到另一个树形上——候选列表承诺的是绝对路径，空白值一律当未设。
- **fail closed 的手动提示给两种 shell**：`set "X=Y"` 在 PowerShell 里不是命令，粘贴即失败；这条提示是探不到运行态时唯一的补救手段，所以两种写法都列。

## 验证

- `tests/desktop-plan.test.js` 在 Windows 上 30 pass / 0 fail：新增 4 个（候选展开顺序、带 `.exe` 的裸名与缺失/空白根、exe 路径与安装目录、tasklist CSV 与两类本地化提示行），接线新增 2 个（detached spawn + `DSH_HOME` + `'spawn'` 事件、tasklist 绝对路径 + CSV + 分派）。
- **路径形态那条用例 `skip: process.platform !== 'win32'`**：`windowsExeCandidates` 的路径分支走 `expandHomePath`（`isAbsolute` / `resolve` 是当前平台语义），在 POSIX 上 `C:\Apps\…` 会被当成相对路径改写，断言只在 Windows 上有意义。裸名与 tasklist 解析的用例不依赖路径语义，两端都跑。仓库 CI 是 ubuntu，这条 skip 是必需的，不是省事。
- 顺带把 4 个在 Windows 上本来就红的路径断言改成 `resolve` / `join` 口径（`resolveDesktopPaths`、`expandHomePath`、行为级 `DSH_HOME` 用例）：它们假设 `/data/home` 原样返回，Windows 上会被 `resolve` 成 `C:\data\home`。
- 双向验证（撤销 → 变红 → 还原，每次还原全绿）：
  - `windowsExeCandidates` 删掉 `%LOCALAPPDATA%\Programs` 根 → 2 fail。
  - `parseTasklistImages` 去掉「只认引号行」→ 1 fail（本地化提示行被当成进程名）。
  - `spawnWindowsApp` 的 `env` 改成 `process.env`（丢掉 `DSH_HOME`）→ 1 fail。
- 真机（Windows 10/11，桌面版 0.2.1-rc.5，`DSH_HOME` 指向临时根，全程不碰本机 `profiles/desktop`）：
  - 裸名定位到 `%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe`；挂载写入依赖与 bundle，junction 建好，`desktopAppRunning` 判定为未运行，`spawn` 成功。
  - 启动后的 host 进程命令行含 `…\Temp\dsh-desktop-probe\profiles\desktop`，临时根下生成 `storages`、`.credentials.yaml`——`DSH_HOME` 确实交到了应用手里。
  - 应用运行中重跑：报「正在运行，profile 只在启动时读入」、退出 1、manifest 的 sha256 前后一致。
  - `DSH_DESKTOP_APP` 指向安装目录：报错行给出解析后的 exe 绝对路径并命中探活，说明目录形态能解析。
  - `DSH_DESKTOP_APP=__no_such_app__`：报「找不到桌面应用 exe」、退出 1、manifest 未变（挂载前早失败）。
  - `--remove`：manifest 里依赖与 bundle 清空、`node_modules/dsh-leader-kit` 的 junction 被删（`rmdir` 路径）。
- 未验证：
  - `tasklist` 全量输出在进程数很多的机器上的耗时（只做了功能验证）。
  - 单实例竞态（探活后、spawn 前应用被手动打开）没有构造。
  - 「探不到运行态」的 fail closed 分支没有真机构造：`tasklist.exe` 总在 `%SystemRoot%\system32`，伪造 `SystemRoot` 会先让 `spawn-command` 找不到 `cmd.exe` 而以硬错误退出（不是这条分支）。该分支只有源码断言覆盖。
  - 本机全量 `npm run test` 仍有一个既有红：`tests/skills.test.js` 的「初始化骨架默认只含 dev 与 review 两个槽位」用 `^slots:\n` 匹配 CRLF 文本，与本改动无关（干净 HEAD 上同样红）。
