# Agent Note: 桌面启动补 Windows：exe 定位、tasklist 探活、detached spawn

Status: implemented

## Problem

`npm run desktop` 第一版（见 [desktop-profile-install](2026-11-03-desktop-profile-install.md)）只在 macOS 上探活与拉起应用，Windows 上只写 profile 后提示手动打开。宿主侧形态决定了补法：单实例锁让「已在运行时再启动一次」的新进程直接退出、环境变量不生效，与 macOS `open --env` 对已运行实例的静默失效同构；安装目录由 `productName` 与关闭「改安装目录」钉死为每用户安装，exe 名与 `productName` 相同；profile 位置、manifest 形状与锁协议两端同一套。

## Decision

- **三个平台分支收敛成「启动目标」+ 两处分派**：`desktopTarget` 返回 `{ kind: 'app' | 'exe' | 'unsupported', path }`，探活与启动只看 `kind`，不各自散落 `process.platform` 判断。受支持平台上找不到目标时在挂载分支报错退出——再往下会把 profile 挂好、然后无声地不启动；`--remove` 在此之前返回，不受影响。
- **Windows 定位由纯函数算候选路径，每用户安装优先**：裸名依次查 `%LOCALAPPDATA%\Programs\<名>`、`%ProgramFiles%\<名>`、`%ProgramFiles(x86)%\<名>`，各自补 `<名>.exe`；含分隔符或以 `~` 开头当路径——以 `.exe` 结尾只认那一处，否则当安装目录补 `<目录名>.exe`（`~` / `~\` 展开与 `DSH_HOME` 同一套）。不查注册表：布局已经钉死，多一次 `reg query` 只给每个会话加启动延迟；写不进候选的位置由人用 `DSH_DESKTOP_APP` 指定。
- **探活用 `tasklist` 的 CSV 输出**：默认表格把 Image Name 截到 25 字符，改个长名就漏判。没有匹配时 tasklist 打的是**本地化**提示行，所以只认以引号开头的行、不按文本比对；`tasklist.exe` 走 `%SystemRoot%\system32` 绝对路径，不依赖 PATH。
- **启动用 detached `spawn`，`DSH_HOME` 放进子进程环境**：Windows 不需要 `open --env` 通道，`detached` + `unref` 必须有（`npm run` 父进程先退出，不脱离会把应用一起收走），成功判据是 `'spawn'` 事件、`ENOENT` / `EACCES` 走 `error`。它直接引 `node:child_process` 并在 `spawn-command` 的允许清单登记理由：起的是 GUI exe，不经 npm/dsh shim，也不能经 `cmd.exe`（会让 cmd 成为父进程并等应用退出）。
- **探不到运行态仍然 fail closed**：两端都只打印带 `DSH_HOME` 的手动命令、不自动启动；Windows 的单实例冲突会让新进程静默退出，探不到就无法排除，赌一次的结果是脚本报「已启动」而应用仍在读旧数据根。

## Alternatives considered

- **在各处散落 `process.platform` 判断**：探活与启动会各写一套；收敛成 `desktopTarget` + 两处分派。
- **查注册表找安装路径**：宿主布局已钉死为每用户安装，多一次 `reg query` 只加延迟；按候选目录找。
- **用 `tasklist` 默认表格**：Image Name 截到 25 字符，长名漏判；解析 CSV 的引号行。
- **经 `cmd.exe` 或 npm shim 启动**：cmd 会成为父进程并等应用退出；直接 detached `spawn` exe。
- **探不到运行态就自动启动**：单实例锁会让新进程静默退出，脚本却报「已启动」；fail closed。

## Consequences

- 探活与启动之间仍有竞态：应用在这段窗口被手动打开时新进程自行退出、脚本仍报「已启动」，Windows 没有 macOS 那种 stderr 信号；没有做 PID 复查，下次重跑会被探活拦住。
- 只认宿主当前的安装布局：绿色版或改过安装目录的实例要用 `DSH_DESKTOP_APP` 指到 exe 或安装目录。
- `tasklist` 每次全量输出：`/FI "IMAGENAME eq …"` 更快，但对超长名字不可靠，选了「解析全量、自己比对」。
- `link:` 是平台绝对路径：`$DSH_HOME` 若被跨机同步（OneDrive、网络盘），macOS 写的链接在 Windows 上无效，本次未改变。
- 候选根先 trim 再拼：空白值当未设，否则 `join` 会得到相对路径并按 cwd 解析。
- fail closed 的手动提示同时给 cmd 与 PowerShell 两种写法：唯一补救手段，粘贴失败等于没有。

收益：Windows 上 `npm run desktop` 能定位 exe、按进程名探活并独立拉起应用，不依赖 PATH 或控制台编码。

## Testing

`tests/desktop-plan.test.js` 在 Windows 上覆盖候选展开顺序、CSV 与两类本地化提示行、detached spawn 与 `DSH_HOME`；路径形态用例按平台 skip（`isAbsolute` / `resolve` 是当前平台语义）。双向验证撤掉每用户根、引号行判定、`DSH_HOME` 各自变红；Windows 真机跑通定位、启动、运行中拒绝与 `--remove`。
