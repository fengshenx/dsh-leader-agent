# Agent Note: Windows 上起 dsh：shim 不可直接执行

Status: implemented

## Problem

`npm start` / `npm run dev` 原先用裸名字起 `dsh` 与 `npm`。Windows 上它们是 npm 的 shim（`dsh.cmd` / `dsh.ps1` / 无扩展名的 sh 脚本），没有 `.exe`：libuv 只找 `<名>`、`.exe`、`.com`，指名 `.cmd` 又被 Node 20.12 起的 EINVAL 拒掉。用户看到的是「找不到 dsh：dsh 没装，或不在 PATH 上」，按它查 PATH 修不好。

## Decision

**Windows 上先解析绝对路径，再交给 cmd。** win32 上按 `.exe`、`.cmd`、`.bat`、`.com` 的顺序自己解析，再起进程；非 Windows 原样 `spawnSync`。无扩展名的同名文件（sh 脚本）与同名目录都不算命中，认下来等于谎报可用。`DSH_DSH` / `DEV_DSH` 给的是路径时只在那一处找，不回落 PATH——指了别处的 dsh 被 PATH 上同名文件顶替是最难查的「版本不对」。解析不是为了「起得来」（cmd 自己也能找到 `.cmd`），而是为了准确判定「找不到」并让显式路径不回落。

**缺可执行文件抛 `CommandNotFoundError`，修法由调用方给。** 两个入口的可复制文案不同，错误类型只回答「是不是没找到」；非 Windows 的 ENOENT 归一为同一个异常，判断只有一处。

**自己拼命令行，不用 `shell: true`。** `shell: true` 在 Windows 上只是把参数整条塞进 `cmd.exe`，不逐个转义，还带 DEP0190。照 cmd 规则自己拼（含空白或元字符才加引号），配 `windowsVerbatimArguments: true` 交给 `%ComSpec%`；`/d` 跳过 AutoRun，`/s` 固定引号规则。引号与反斜杠按 MS C runtime 的规则写，不照搬 cmd 的 `""`，否则引号前的反斜杠与收尾反斜杠会丢字符。

**dev 用异步版，语法门禁用脚本。** dev 挂着常驻 watcher 与信号处理器，同步等待会卡住事件循环、让 watcher 成孤儿，所以用异步 `spawnCommand` 复用同一套解析与命令行构造；`build:client` 必须跑完才继续，仍用同步版。语法门禁从 POSIX shell 循环改成脚本遍历 `node --check`，Windows 上 `npm run check` 才跑得起来。

## Alternatives considered

- **继续裸名字起 `dsh` / `npm`**：Windows 只有 `.cmd` / `.ps1` / sh shim，libuv 找不到 `.exe`，报错还误导人查 PATH。
- **用 `shell: true`**：参数整条塞给 cmd、不逐个转义，还带 DEP0190；改为自己拼命令行。
- **接受 `.ps1`、无扩展名 sh 或 `PATHEXT`**：会把不可执行的文件认成可用；固定 `.exe` / `.cmd` / `.bat` / `.com` 顺序。
- **dev 也用同步 spawn**：卡住事件循环、watcher 成孤儿；dev 用异步版，构建门禁保持同步。

## Consequences

- 只管 start / dev 起的 `npm` 与 `dsh`；worktree 脚本起的是 `git`，各平台都是 `.exe`，不动。
- 不认 `dsh.ps1`，不退回落 sh 脚本，不读 `PATHEXT` 环境变量：固定默认扩展名顺序。
- 引号只对付 runtime 转义，不对抗 cmd 语义：`%VAR%` 会被展开，参数里的换行会被截断（参数被吃掉，不是注入面）。
- cmd 定位不依赖调用方给的 env（优先绝对路径的 `ComSpec`，否则 `System32` 那份）；cmd 起不来抛 `CommandShellError`，与「找不到你的命令」分开，只认 `ENOENT` / `EFTYPE`。
- 语法门禁跟随符号链接目录并按 `realpath` 去重，否则链接进来的目录静默漏检；PATH 顺序决定用哪个 dsh，不特殊处理。
- 平台差异只在测试侧处理，产品代码不为平台加分支。

收益：Windows 上 start / dev / check 都能准确找到并启动命令，找不到时报错能指向真正的修法。

## Testing

`tests/spawn-command.test.js`：`quoteForCmd` 回退时引号用例变红，命令行构造不使用解析结果时「解析结果决定起哪个文件」变红；还原后全绿。
