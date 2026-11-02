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
- 无扩展名的同名文件、与命令同名的目录都不算命中——前者是 sh 脚本，后者起不来，认下来都等于谎报可用；
- `DSH_DSH` / `DEV_DSH` 给的是路径时只在那一处找，不回落 PATH（指了别处的 dsh 却被 PATH 上同名文件顶替，是最难查的那种「版本不对」）；
- PATH 条目里的引号与空条目都剥掉。

**解析不是「起得来」的前提**：`cmd.exe` 自己也能按 PATHEXT 找到 `.cmd` shim，`cmd /d /s /c "dsh --version"` 实测 exit 0。它的价值在另外两处：

1. 准确判定「找不到」——不解析时只能匹配随语言变化的 `'x' is not recognized`，或者把退出码 1 与「装坏了」混在一起（`start.mjs` 报「以退出码 1 结束」+ 空输出）；
2. 显式路径只在那一处找、不回落 PATH（见上一条规则）。

所以回归用例必须造出「只靠 cmd 找不到」的条件才守得住解析结果真的被用上：PATH 上一个 `.cmd`、一个 `.bat`，`PATHEXT` 让 `.BAT` 优先时，走解析选 `.cmd`、把命令名丢回 cmd 则选 `.bat`。

### 缺可执行文件抛 `CommandNotFoundError`，修法由调用方给

`start.mjs` 与 `dev.mjs` 的可复制修法文案不同（`DSH_DSH` / `DEV_DSH`，`npm start` / `npm run dev`），所以错误类型只回答「是不是没找到」，提示留在调用方。非 Windows 上 `spawnSync` 的 ENOENT 也归一到同一个异常——两条平台的判断只有一处。

### 自己拼命令行，不用 `shell: true`

Node 的 `shell: true` 在 Windows 上只是把 `[file, ...args].join(' ')` 整条塞进 `cmd.exe /d /s /c "…"`，不逐个转义（含空格的参数会被拆开），而且带 args 用 shell 从 20.12 起报 DEP0190。这里照 cmd 的规则自己拼（含空白或 cmd 元字符才加引号），配 `windowsVerbatimArguments: true` 交给 `%ComSpec%`。`/d` 跳过注册表 AutoRun 里的钩子，`/s` 固定引号处理规则。

引号与反斜杠按 MS C runtime 的规则写，不按 cmd 的 `""`：外层 `"${line}"` 被 `/s` 剥掉一层之后，剩下那段字符串原样进了目标程序的 argv 解析——引号前的反斜杠按 `2n` 个留 `n` 个、`2n+1` 个留 `n` 个再补一个字面引号，收尾的反斜杠翻倍。照搬 cmd 的 `""` 时 `a\"b`、`a b\\` 这类参数会丢字符（旧实现实测 10 组里 4 组不等）。

### 语法门禁改成脚本，Windows 上也能跑 `npm run check`

原来的语法检查是 `check` 里一段 POSIX shell 循环（`for f in … $(find …)`），Windows 的 cmd 下直接报 `f was unexpected at this time`，整套门禁在本地跑不起来。改成 `scripts/check-syntax.mjs`：遍历 `index.js` 与 `src` / `scripts` / `build` 下的 `.js` / `.mjs` 逐个 `node --check`，失败时打印相对路径与 `node` 的输出并以 1 退出；门禁顺序不变。

## 边界

- **只管 start / dev 起的 `npm` 与 `dsh`**：`worktree:spawn` / `worktree:prune` 起的是 `git`，各平台都是 `.exe`，不动。
- **不认 `dsh.ps1`，也不退回落 sh 脚本**：两条都要宿主 shell 参与，属于「能用但换了一套执行模型」，真需要时由 `DSH_DSH` 指到具体入口。
- **不读 `PATHEXT` 环境变量**：固定 `.exe` / `.cmd` / `.bat` / `.com` 的默认顺序。改过 PATHEXT 的机器按默认顺序也仍然能找到 npm 的 shim。
- **只管 cmd 层的引号，`%VAR%` 会被展开**：cmd 在双引号内同样做变量替换，加引号也拦不住，所以 `quoteForCmd` 不试图拦——参数来自用户自己的命令行，不是外部输入。用例把展开行为固化成已知边界，`start.mjs` 头注释提示参数含 `%` 会被改写。
- **PATH 顺序决定用哪个 dsh**：npm 会把祖先目录的 `node_modules/.bin` 插到 PATH 前面，那里有 `dsh.cmd` 时它赢过全局安装的那一份。这是 npm 脚本的既有语义，不特殊处理；排查「版本不对」时先看 `node_modules/.bin`。

## 验证

`tests/spawn-command.test.js` 21 条：解析（`.cmd` 优先于无扩展名、PATHEXT 顺序、多 PATH 目录、显式路径不回落 PATHEXT、带引号的 PATH 条目、空条目、PATH 大小写与精确优先、同名的目录不算命中）、引号（普通、含空格、空串、结尾反斜杠翻倍、引号前反斜杠按 CRT 计数、`%` 不加处理）、`buildCommandLine`、真实起进程（`process.execPath` 在 `C:\Program Files\…`，顺带验证带空格路径）、`CommandNotFoundError`，以及 Windows 上四条（非 Windows 跳过）：经 `cmd.exe` 起带空格的 `.cmd` shim 且参数原样到达、按 PATH 解析出的 `.cmd` shim 真的被起起来、解析结果与 cmd 自行 PATHEXT 顺序不一致时起的是解析结果、参数里的 `%VAR%` 被展开（已知边界）。

双向验证（Windows 11 / node 24.18.1）：

| 撤销的修复 | 读数 |
|---|---|
| `quoteForCmd` 换回 cmd 的 `""` 实现 | 2 条引号用例红（`结尾反斜杠翻倍`、`按 C runtime 规则处理引号前的反斜杠`） |
| `buildCommandLine({ file })` 换回 `command` | `解析结果决定起哪个文件` 红：actual `from-bat` / expected `from-cmd`；只传 PATH 的那条仍绿——cmd 自己也能解析，守不住「解析结果被用上」，所以另加了 PATHEXT 顺序一条 |
| `exists` 默认换回 `existsSync` | `PATH 上与命令同名的目录不算可执行文件` 红 |
| `scripts/check-syntax.mjs` 前，把 `src/shared/frontmatter.js` 写坏 | 门禁 exit 1，打印 `src\shared\frontmatter.js` 与 `SyntaxError: Unexpected end of input`；还原后 exit 0 |

引号探针（`.telov/probe-quote.mjs` 那 10 组 `a\"b` / `a b\\` / `x\\"y` / `tail two\\` 等）：修复前 6/10 相等，修复后 10/10 相等；另补 23 组元字符与边缘形态，唯一不等是 `%OS%`（cmd 层展开，见边界）。

真机（Windows 11 / node 24.18.1 / dsh 0.2.1-rc.5）：

- `DSH_HOME=<临时数据根> npm start -- --help`：先打印 `版本 dsh …`、数据根与插件路径，跑完 `npm run build:client`，再打印 `dsh web --help` 全文，`exit=0`——探测器、`npm` 构建、`dsh` 启动三条都在 cmd 封装里过了一遍。
- `DSH_DSH=no-such-dsh npm start` 与 `DEV_DSH=no-such-dsh npm run dev`：各自在准备完 profile 后打出新的两行提示并以 1 退出，不再是 ENOENT 的原始形态。
- 本机 `Documents\code\node_modules` 里曾残留一份 pnpm 装的 dsh 0.1.0-rc.7，npm 把它挂的 `.bin` 插在 PATH 前面：清掉之前 `npm start` 打印 `版本 dsh 0.1.0-rc.7`，清掉之后同一份临时数据根下 `npm start -- --help` 打印 `版本 dsh 0.2.1-rc.5` 并以 0 退出。封装在 npm 脚本里对 PATH 顺序的处理与直接跑 `node scripts/start.mjs` 一致，见上面边界。
