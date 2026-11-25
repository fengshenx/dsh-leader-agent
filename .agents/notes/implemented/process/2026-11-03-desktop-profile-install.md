# Agent Note: 桌面版挂载：npm run desktop 直接改 desktop profile

Status: implemented

## Problem

用户问本插件能否在桌面版里用、能否用一条 `npm run` 起。实测边界是：桌面版是 Electron 壳 + 完整 Web 应用，profile 固定为 `$DSH_HOME/profiles/desktop`，与 CLI 的 `profiles/web` 各自一套包、激活状态与 lockfile；`dsh --profile desktop` 被宿主直接拒绝；应用自带的插件管理支持本地绝对路径，但开发期靠在对话框里每次手填路径不可行；`npm run dev` / `npm start` 都只起 `dsh web`。

## Decision

> **已被 [影子数据根](2026-11-24-desktop-shadow-home.md) 部分取代**：主 checkout 不再把
> `link:` 写进日常 profile，影子根只借用本文的 manifest 与链接机制；摘除、锁与启动
> 探活的判定仍按本文。

- **脚本直接改 manifest 与链接，不跑 pnpm**：往 desktop profile 写 `link:<当前目录>`、把包名追加进 `bundles`、在 `node_modules` 建符号链接（Windows 用 junction，不需要管理员）。桌面应用的包操作用自己的 pnpm 与 Electron Node 环境，复刻那套容易随宿主版本失效；宿主启动只按 `bundles` 解析包、不校验 `link:` 与磁盘是否一致。代价是 lockfile 与 manifest 短暂不一致，下次在应用里做安装/卸载由 pnpm 补齐。
- **`DSH_HOME` 按宿主语义归一化**：先展开 `~` / `~\` 再 `resolve`；**相对路径直接拒绝**——应用由 `open` 经 LaunchServices 启动、cwd 不是这个 shell，应用拿相对值会算成另一个数据根。
- **数据根显式传给应用**：启动时固定带 `--env DSH_HOME=<绝对路径>`（`open` 注入环境的唯一途径），默认根也照传，不依赖「默认值碰巧一致」。
- **`DSH_DESKTOP_APP` 两种形态**：含分隔符或以 `~` 开头才算路径，裸包名按**名字**在常见安装位置找；解析出的 `.app` 绝对路径既用于读 `Info.plist` 也用于 `open -a`。
- **构建前置**：先 `build:client`，成功后才建链接与写 manifest；反过来会在构建失败时留下「已挂载但没有客户端产物」的坏状态，右栏空白。
- **不覆盖别人的安装**：依赖说明符不是当前目录即报错（可能是插件管理装的版本或另一个工作树）；`node_modules` 里已存在时只接受「符号链接且指向当前目录」，其余（实体目录、指向别处）一律拒绝。判定收敛成纯函数 `planLinkAction`（create / keep / refuse），IO 只执行结论。
- **先建链接、再写 manifest**：链接被挡时 manifest 保持原样；链接成功而 manifest 写失败只留一个没人引用的链接，下次重跑按 kept 处理。
- **应用运行中拒绝写入**：宿主只在启动时读 profile，写入不生效还可能与应用自己的插件管理相撞。进程名取自 `.app` 的 `CFBundleExecutable`（`Lark.app` 的进程是 `Feishu`），取不到就报错退出，不猜；Linux 探不了则写完 profile 并提示手动启动，不调不存在的工具卡死。
- **两把锁都要认**：`<profile>/lock` 是桌面应用自己的锁（按持有者 PID 判活，PID 非法当活跃拒绝，已退出是陈旧锁、脚本删掉后自己接管），`package.json.lock` 是宿主原子写用的兄弟文件。脚本自己持 `<profile>/lock` 覆盖「重读 manifest → 规划 → 写 manifest → 动链接」整段，只「检查一下再写」仍会被第二个写者插进来；构建在锁外。
- **启动 fail closed**：`open --env` 对已运行实例无效（退出码仍 0、环境被丢掉），所以探到在跑就拒绝；探不到运行态时也不自动启动，只打印带 `DSH_HOME` 的手动命令；`open` 返回后 stderr 非空一律当失败。落到「profile 已挂好、应用仍用旧环境」时要求完全退出再重跑。
- **`--remove` 是包级摘除，只摘能判定归属当前工作树的那份**：依赖说明符不是当前目录、或只在 `bundles` 里出现而无依赖条目时拒绝；`node_modules` 是实体目录而 manifest 有记录时整单拒绝（目录与声明要么一起解决要么都不动）；不依赖应用存在，探活只在挂载分支做；链接拆除复用既有的 `detachNodeModulesLink`（Windows junction 用 `rmdir`，与 `worktree:prune` 同一约定）。
- **文档归属**：README 安装章节给使用者操作（一条命令 + 撤销 + 限制），机制在 `docs/development.md` 一句与本文，`AGENTS.md` 命令表一行；桌面版安装入口必须留在 README Quick Start 这一层。

## Alternatives considered

- **在 desktop profile 里跑 pnpm**：桌面应用用自己的 pnpm 与 Electron Node，复刻容易随宿主版本失效；直接写 manifest + 符号链接。
- **接受相对 `DSH_HOME`**：应用由 LaunchServices 启动、cwd 不是这个 shell，相对值会算成另一个数据根；展开后必须是绝对路径。
- **依赖「默认数据根碰巧一致」**：启动时固定带 `--env DSH_HOME=<绝对路径>`，不赌默认值。
- **覆盖别人的安装**：可能是插件管理装的版本或另一个工作树；依赖说明符不是当前目录就拒绝。
- **先写 manifest 再建链接**：构建失败会留下「已挂载但没有客户端产物」；先构建、再链接、最后写 manifest。
- **探不到运行态就自动启动**：`open --env` 对已运行实例无效，会报「已启动」而应用仍读旧环境；fail closed。

## Consequences

- 同一时刻只能挂一个工作树版本；换版本先 `--remove`。worktree 里运行改用派生数据根，见 [worktree 派生数据根](2026-11-03-desktop-worktree-derived-home.md)，Windows 探活与启动见 [desktop-windows-launch](2026-11-03-desktop-windows-launch.md)。
- macOS 的进程名在 `p_comm` 里截断到 16 字符，`pgrep -x` 对默认应用名 `DeepSeek Harness` 会漏判；已补 `pgrep -f` 按完整可执行文件与 helper 的 `Contents/Frameworks/` 路径兜底（模式都带子路径，不会命中只带 `.app` 路径的 `open -W` 等待进程；误判为在跑只会拒绝启动，方向安全）。
- 不支持用 `DSH_HOME` 起隔离的桌面实例：Electron 的 userData（更新、账号、窗口状态）与 profile 数据根不是一回事；隔离验证继续走 web 形态开发实例。
- 桌面版与 CLI 的包和激活状态分开，但会话、项目、卡片数据在同一 `$DSH_HOME` 下共享。

收益：一条 `npm run desktop` 把当前工作树挂进桌面版，构建、归属与运行态检查都在写之前，摘除也能干净还原。

## Testing

`tests/desktop-plan.test.js` 覆盖路径解析、归属守卫、锁与启动顺序；双向验证逐条撤销（链接规划、归属校验、写入顺序、进程名来源、锁）各自变红。临时数据根端到端与 macOS 实机各跑通正常、运行中拒绝、`--remove` 三条路径。
