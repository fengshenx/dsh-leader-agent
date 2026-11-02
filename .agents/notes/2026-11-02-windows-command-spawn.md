# Windows 上起 dsh：shim 不可直接执行

## 背景

`npm start` 与 `npm run dev` 里的子进程都是裸名字起的：`spawnSync('dsh', …)`、`spawnSync('npm', …)`。Windows 上这两个名字在磁盘上是 npm 的 shim 三件套——给 cmd 的 `dsh.cmd`、给 PowerShell 的 `dsh.ps1`、给 git bash 的无扩展名 `dsh`——没有 `dsh.exe`：

- libuv 只按 `<名>`、`<名>.exe`、`<名>.com` 找文件，`spawnSync('dsh')` 直接 ENOENT，即使 `which dsh` 在 bash 里有输出；
- 指名 `dsh.cmd` 又会被 Node 拒掉：20.12 起 `shell: false` 下执行批处理一律 EINVAL（CVE-2024-27980 的修法）；
- 那份无扩展名的 `dsh` 是 sh 脚本，`cmd` 起不来它。

症状落在 start 的第一条检查上：报「找不到 dsh：dsh 没装，或不在 PATH 上」。这条提示是为「没装 / PATH 里没有」写的，与真实原因无关，用户按它去查 PATH 也修不好；`npm run dev` 同样在最后一步起 `dsh web` 时 ENOENT，只是没有这条提示。

## 决策

### Windows 上先按 PATHEXT 解析绝对路径，再交给 cmd

`scripts/spawn-command.mjs` 的 `spawnCommandSync` 在 win32 上先自己解析命令，再起进程；非 Windows 原样 `spawnSync`。解析规则照 cmd 的直觉来：

- 名字无扩展名时按 `.exe`、`.cmd`、`.bat`、`.com` 依次试；
- 无扩展名的同名文件不算命中——那是 sh 脚本，Windows 上起不来，认下来等于谎报可用；
- `DSH_DSH` / `DEV_DSH` 给的是路径时只在那一处找，不回落 PATH（指了别处的 dsh 却被 PATH 上同名文件顶替，是最难查的那种「版本不对」）；
- PATH 条目里的引号与空条目都剥掉。

解析出来的是绝对路径，所以「找不到」能准确判定，不用去匹配 `'x' is not recognized` 这种随语言变化的 cmd 文案。

### 缺可执行文件抛 `CommandNotFoundError`，修法由调用方给

`start.mjs` 与 `dev.mjs` 的可复制修法文案不同（`DSH_DSH` / `DEV_DSH`，`npm start` / `npm run dev`），所以错误类型只回答「是不是没找到」，提示留在调用方。非 Windows 上 `spawnSync` 的 ENOENT 也归一到同一个异常——两条平台的判断只有一处。

### 自己拼命令行，不用 `shell: true`

Node 的 `shell: true` 在 Windows 上只是把 `[file, ...args].join(' ')` 整条塞进 `cmd.exe /d /s /c "…"`，不逐个转义（含空格的参数会被拆开），而且带 args 用 shell 从 20.12 起报 DEP0190。这里照 cmd 的规则自己拼（含空白或 cmd 元字符才加引号、结尾反斜杠多补一个），配 `windowsVerbatimArguments: true` 交给 `%ComSpec%`。`/d` 跳过注册表 AutoRun 里的钩子，`/s` 固定引号处理规则。

## 边界

- **只管 start / dev 起的 `npm` 与 `dsh`**：`worktree:spawn` / `worktree:prune` 起的是 `git`，各平台都是 `.exe`，不动。
- **不认 `dsh.ps1`，也不退回落 sh 脚本**：两条都要宿主 shell 参与，属于「能用但换了一套执行模型」，真需要时由 `DSH_DSH` 指到具体入口。
- **不读 `PATHEXT` 环境变量**：固定 `.exe` / `.cmd` / `.bat` / `.com` 的默认顺序。改过 PATHEXT 的机器按默认顺序也仍然能找到 npm 的 shim。
- **只管 cmd 层的引号**：`%VAR%` 展开、`!` 延迟展开这类 cmd 语义不拦——参数来自用户自己的命令行，不是外部输入。
- **PATH 顺序决定用哪个 dsh**：npm 会把祖先目录的 `node_modules/.bin` 插到 PATH 前面，那里有 `dsh.cmd` 时它赢过全局安装的那一份。这是 npm 脚本的既有语义，不特殊处理；排查「版本不对」时先看 `node_modules/.bin`。

## 验证

新增 `tests/spawn-command.test.js` 15 条：解析（`.cmd` 优先于无扩展名、PATHEXT 顺序、多 PATH 目录、显式路径不回落 PATHEXT、带引号的 PATH 条目、空条目、PATH 大小写与精确优先）、引号（普通、含空格、空串、结尾反斜杠）、`buildCommandLine`、真实起进程（`process.execPath` 在 `C:\Program Files\…`，顺带验证带空格路径）、`CommandNotFoundError`，以及 Windows 上经 `cmd.exe` 起带空格的 `.cmd` shim 且参数原样到达（非 Windows 跳过）。

真机（Windows 11 / node 24.18.1 / dsh 0.2.1-rc.5）：

- `DSH_HOME=<临时数据根> npm start -- --help`：先打印 `版本 dsh …`、数据根与插件路径，跑完 `npm run build:client`，再打印 `dsh web --help` 全文，`exit=0`——探测器、`npm` 构建、`dsh` 启动三条都在 cmd 封装里过了一遍。
- `DSH_DSH=no-such-dsh npm start` 与 `DEV_DSH=no-such-dsh npm run dev`：各自在准备完 profile 后打出新的两行提示并以 1 退出，不再是 ENOENT 的原始形态。
- 同一份临时数据根下发现一个既有现象（不是本次引入）：`npm start` 里 `dsh --version` 报 `0.1.0-rc.7`，直接跑 `node scripts/start.mjs` 报 `0.2.1-rc.5`——npm 把 `C:\Users\…\Documents\code\node_modules\.bin` 插在 PATH 前面，那里有一份旧 dsh。见上面边界。
