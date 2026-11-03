# 桌面版挂载：npm run desktop 直接改 desktop profile

**状态**：implemented（2026-11-03）
**范围**：`scripts/{desktop,desktop-plan}.mjs`、`package.json`、`README{,_ZH}.md`、`docs/development.md`、`AGENTS.md`、`tests/desktop-plan.test.js`

## 背景

用户问两件事：本插件能不能在 DeepSeek Harness 桌面版里用，以及能不能用 `npm run xxx` 启动。实测与宿主源码给出的边界是：

- 桌面版是 Electron 壳 + 完整 Web 应用，profile 固定为 `$DSH_HOME/profiles/desktop`（`apps/desktop/src/paths.ts`），与 CLI 的 `profiles/web` 各自一套包、激活状态与 lockfile。装进 `web` 的插件桌面版看不到。
- `dsh --profile desktop` 被宿主直接拒绝：`profile "desktop" is managed exclusively by the Electron application`。
- 桌面 App 的插件管理支持本地绝对路径，是正规入口；但开发期要在工作树里改代码即生效，靠对话框每次手填路径不够。
- `npm run dev` / `npm start` 都只启动 `dsh web`，不会拉起桌面应用。

## 决策

### 脚本直接改 manifest 与链接，不跑 pnpm

`npm run desktop` 往 desktop profile 的 `package.json` 写 `dsh-leader-kit: link:<当前目录>`、把包名追加进 `dsh.profile.bundles`，并在 `node_modules` 里建符号链接（`junction`，Windows 不需要管理员）。

- 桌面应用执行包操作时用的是它自带的 pnpm 与 Electron Node 模式（`ELECTRON_RUN_AS_NODE`、私有 launcher 环境）。脚本复刻那套环境容易随宿主版本漂移而失效；而宿主启动时只按 `bundles` 列表解析包，不校验 `link:` 与磁盘链接是否一致——`npm run dev` 的派生 profile 已经用同一机制跑通。
- 代价是 `pnpm-lock.yaml` 与 manifest 短暂不一致；link 依赖不需要网络，下次在桌面应用的插件管理里做安装/卸载时由 pnpm 自己补齐。这个代价写进 README 的一句话里。
- `DSH_HOME` 按宿主的 `expandHomePath` 语义归一化：先展开 `~`（`~/` 与 `~\` 两种写法都认，Windows 上两种都有人用）再 `resolve`。原实现直接拿字面量拼 `profiles/desktop`，`~/x` 会变成 `<cwd>/~/x`、相对路径也找错 profile。
- **相对 `DSH_HOME` 直接拒绝**：脚本能按自己的 cwd 算出绝对路径，但桌面应用由 `open` 经 LaunchServices 启动、cwd 不是这个 shell 的——应用拿相对值会算成另一个数据根。与其写一半，不如让人改成绝对路径或 `~/` 写法。
- **数据根用 `open --env` 显式传给应用**：拉起的应用是独立进程，不保证按本终端的环境解析，所以启动时固定带 `--env DSH_HOME=<绝对路径>`（`open` 给被启动进程注入环境变量的唯一途径，实测 macOS 27.2 接受该参数）。默认根也照传，省掉「默认值碰巧一致」的隐式依赖。
- `DSH_DESKTOP_APP` 的写法与启动用同一套解析结果：只有含分隔符或以 `~` 开头才算路径，`DeepSeek Harness.app` 这种裸包名按**名字**在常见安装位置找（按路径解析会找成 `<cwd>/DeepSeek Harness.app`）；找到的 `.app` 绝对路径既用于读 `Info.plist`，也用于 `open -a`——`open` 不做 shell 展开，把 `~/Foo.app` 原样传过去必然失败。
- **构建前置**：先 `npm run build:client`、成功后才建链接与写 manifest。原顺序是最后构建，构建失败时插件已经处于「已挂载」状态，宿主下次启动会加载一份没有客户端产物的包（右栏空白）。失败时什么都没动。

### 别人的安装不覆盖，运行中不写入

- 依赖条目已有本插件但说明符不是当前目录时直接报错：那可能是插件管理装的版本，或另一个工作树挂上去的，覆盖要由人决定。
- `node_modules/dsh-leader-kit` 已存在时只接受两种状态：不是符号链接（插件管理装的实体目录）拒绝；符号链接但指向别的工作树也拒绝。后一种是审查阶段补的——原实现对「指向别处」直接 `rm` 再重建，等于把别人的安装悄无声息顶掉，与上面那条 manifest 守卫的语义不一致。判定收敛成纯函数 `planLinkAction`（`create` / `keep` / `refuse`），IO 只执行结论。
- **先建链接、再写 manifest**：链接被别人的安装挡住时立刻失败，manifest 保持原样。反过来会留下「bundles 里声明了 `dsh-leader-kit`、`node_modules` 却是插件管理的实体目录」的坏状态（实测确认：拒绝时 manifest 已被改写）。链接成功而写 manifest 失败，只留一个没人引用的链接，下次重跑按 `kept` 处理，宿主也不会加载它。
- 桌面应用运行中拒绝写入：宿主只在启动时读 profile，写入不生效，还可能和应用自己的插件管理撞上。探活依赖 `plutil` 读 `Info.plist` 再 `pgrep -x`，只在 macOS 上做；Linux 与 Windows 都返回「探不了」，脚本照样写完 profile 并提示手动启动——不要在 Linux 上调一个不存在的 `plutil` 把整条命令卡死。
- **进程名取自 `.app` 的 `Info.plist`（`CFBundleExecutable`）**，不按包文件名猜：`Lark.app` 的进程是 `Feishu`，带版本号的快照（`DeepSeek Harness 0.2.1.app`）同理。取不到 `.app`、读不到 plist 或缺 `CFBundleExecutable` 时直接报错退出——猜一个名字会漏判运行态，进而写坏 profile。`open -a` 收的是解析后的 `.app` 绝对路径，不是 `DSH_DESKTOP_APP` 原值。
- **两把锁都要认**：`<profile>/lock` 是桌面应用自己的那把——`resolveDesktopPaths` 的 `lock` 字段，`DesktopProjectManager.withLock` 用 `openSync(..., 'wx')` 建它并写入自己的 PID，`applyRelease()` / `disableAllPlugins()` 都走它；`package.json.lock` 是宿主的 `dsh-atomic-write` 在写 manifest 时用的 `<file>.lock` 兄弟文件。第一版只查了后者，判断错了：`<profile>/lock` 平时不存在（操作完就删），不等于没有。
  - `<profile>/lock` 按持有者进程判活：PID 读不出或非法时与宿主一样当「活跃」拒绝；PID 已退出（`ESRCH`）是陈旧锁——脚本删掉它后自己接管（与宿主 `withLock` 的行为一致），只在输出里说明一句。
  - 边界：在「建锁文件」与「写入自己的 PID」之间被 `kill -9` 会留下一个空锁文件，PID 读不出 → 按活跃拒绝，需要人工删掉。宿主 `withLock` 是同一协议、同一缺口，接受它换「不需要额外锁元数据」。
- **脚本自己持锁覆盖整个读改写**：只「检查一下再写」仍然有窗口——检查与写入之间插进来的第二个写者（桌面应用的 `applyRelease`、另一个终端里的本脚本）照样会相互覆盖。所以按宿主同协议 `openSync(..., 'wx')` 建 `<profile>/lock`、写入自己的 PID、`finally` 里只删自己那把（内容不匹配就说明已被接管），把「重读 manifest → 规划 → 写 manifest → 动链接」整段包在里面。内层再叠仓里既有的 `withFileLockSync`（`scripts/atomic-write.mjs`，与 `dsh-atomic-write` 同协议）管 `package.json.lock`。`npm run build:client` 仍在锁外：它不碰 profile。
- **启动 fail closed**：`open --env` 对**已运行**的实例无效（rc 仍是 0，环境被丢掉），所以探到应用在跑就拒绝；探不到运行态（`pgrep` 缺失）时也不自动启动，只打印带 `DSH_HOME` 的手动命令；`open` 返回后 stderr 非空一律当失败——成功时它是静默的。
  - `open --env` 对已运行实例是「部分成功」：profile 已经挂好，但应用仍用启动时的旧环境。脚本不回滚挂载（那是真实写入的结果），而是报错要求先完全退出应用再重跑——下次启动才读得到新 profile 与 `DSH_HOME`。
  - 边界：「先探活、再启动」之间应用被手动打开仍会落进上面这种部分成功；拦不干净，靠 `open` 的 stderr 与下一次重跑兜住。
- `--remove` 是**包级摘除**，只摘「能判定是当前工作树挂的」那份：依赖说明符不等于 `link:<当前目录>`（别的工作树、插件管理的版本）、或只在 `bundles` 里出现而没有依赖条目时，一律拒绝并说明，不摘别人的安装。
- **实体目录占位时整单拒绝**（而不是只摘声明）：`node_modules/dsh-leader-kit` 是实体目录、而 manifest 里又有本插件的记录时，`--remove` 直接报错、manifest 一个字不改。两个可选语义（只摘声明 / 拒绝）选了后者——前者会留下「声明没了、磁盘上还挂着一份插件管理装的包」的状态，而宿主只按 `bundles` 加载，看上去「摘干净了」，实际那份目录还在且下次 `--remove` 判不出归属。目录与声明要么一起解决，要么都不动。
- `--remove` 不依赖应用是否存在：探活只在挂载分支做。应用卸载、改名之后照样要能摘除，探活失败不该拦住摘除。
- 链接拆除走仓里既有的 `detachNodeModulesLink`：Windows junction 用 `rmdir`、其余平台 `unlink`，与 `worktree-prune` 同一约定（原实现用 `rmSync`，在 Windows 上对目录链接的语义不一致）。非 macOS 平台只完成 profile 写入并提示手动启动，不再打印「桌面应用已启动」。

### 文档归属

README 的安装章节加「桌面版」小节给使用者操作（一条命令 + 撤销 + 两条限制）；机制细节在 `docs/development.md` 的一句话与本文，不重复展开。`AGENTS.md` 只在常用命令表加一行。

三份文档的天花板按合并后的当前值重算，不沿用分支上的旧数（main 期间被 #77 / #79 / #81 改过多轮）：`AGENTS.md` 3930 → 4000、`README.md` 3250 → 3400、`README_ZH.md` 4850 → 5100、`docs/development.md` 1780 → 1900。同时把合并后已低于阈值的 `docs/capability-gaps.md`（15500 → 16800，按 ≥10%）、`docs/e2e-testing.md`（4340 → 4400）一并拉回——那两项不是本 PR 压下去的，但同一条规则，留着会让下一次改动无余量。桌面版的安装入口只能放在 README 的 Quick Start 里——它是使用者会先看的那一层，塞进 docs 等于没写；development 那条同理，属于「实例怎么起」的归属层，不重复搬到别处。

## 边界

- 同一时刻只能挂一个工作树版本：desktop profile 只有一份，已挂别的工作树时会被拒绝，要换先 `--remove`。多工作树并行验证仍用 `npm run dev`。
- macOS 的进程名在 `p_comm` 里截断到 16 字符，应用名超过 16 字符时 `pgrep -x` 仍可能漏判（默认名「DeepSeek Harness」正好 16）。没改用 `pgrep -f`：它匹配整条命令行，编辑器开着同名路径就会误判，宁可漏判时靠人按 ⌘Q。
- 不支持用 `DSH_HOME` 起一个隔离的桌面实例：App 固定读该变量下的 `profiles/desktop`，而 Desktop 的更新、账号与窗口状态在 Electron userData 下，与 profile 数据根不是一回事。隔离验证继续走 web 形态的开发实例。
- Windows 上不探进程、不自动拉起应用，脚本只完成 profile 写入并提示手动启动。
- 桌面版的插件包与激活状态和 CLI 分开，但会话、项目、卡片数据在同一个 `$DSH_HOME` 下共享。

## 验证

- `tests/desktop-plan.test.js` 24 个用例：路径解析（默认、`DSH_HOME` 覆盖、空串回落）、`expandHomePath`（`~` / `~/x` / 相对 / 绝对 / 路径中间的 `~`）、首次挂载写入依赖与 bundle 末尾、幂等、已装另一来源拒绝（工作树与版本号两种）、bundle 已含时不重复、缺 bundles 列表拒绝、摘除只动本插件、未装时摘除是空操作、摘除时别的工作树与判不出归属都拒绝、`parseBundleExecutable`（含 `Lark.app → Feishu` 与三种取不到）、`planLinkAction` 四种组合、`ensureLink` 先于 `writeManifest` 的顺序断言、探活接线断言（进程名来自 plist、`args: ['-x', processName]`）、`~\` 展开、相对 `DSH_HOME` 判定、`DSH_DESKTOP_APP` 的路径/名字形态、`<profile>/lock` 的四种占用状态、摘除不依赖应用存在、两处 manifest 写入都在 `withFileLockSync` 内重读、`~user` 拒绝、`DSH_HOME` 首尾空白 trim、启动 fail closed（探不到运行态不启动、`open` 有 stderr 不当成功）、持锁覆盖整个读改写。
- 双向验证（逐条撤销 → 变红 → 还原，每次还原 24 pass）：
  - `planLinkAction` 的「指向别处」从 `refuse` 改回 `create`（即原来的静默替换）→ 1 fail（22 pass）。
  - `planDesktopDisable` 删掉归属校验 → 1 fail（22 pass）。
  - `desktop.mjs` 把 `writeManifest` 挪回 `ensureLink` 之前 → 顺序用例 1 fail（22 pass）。
  - `pgrep` 的 `args` 从 `processName` 改回 `appName` → 接线用例 1 fail（22 pass）。
  - `planProfileLockAction` 恒返回 `proceed`（等于不查 `<profile>/lock`）→ 1 fail。
  - `looksLikeAppPath` 恒 `true`（等于把裸 `.app` 名当相对路径）→ 1 fail。
  - `expandHomePath` 去掉 `~\` 分支 → 1 fail。
  - `planDshHomeEnv` 恒 `absolute`（等于放行相对 `DSH_HOME`）→ 1 fail。
  - `--remove` 分支挪到探活之后 → 顺序用例 1 fail。
  - 删掉「实体目录 + 有记录 → 拒绝」→ 同一用例 1 fail。
  - 挂载分支去掉 `withFileLockSync`（直接读改写）→ 锁包裹用例 1 fail。
  - `planDshHomeEnv` 去掉 `~user` 分支（落到相对/绝对）→ 1 fail。
  - `resolveHomePathsOrThrow` 删掉 `~user` 拒绝分支 → 行为用例 1 fail（这条不看源码正则，直接构造 `~user/x` 走真实解析）。
  - `main` 把校验改成 `if (false && …)` 短路 → 接线用例 1 fail。
  - `resolveDesktopPaths` 改回不 trim（用原始 `DSH_HOME`）→ 1 fail。
  - 删掉「darwin 且 running 为 null 不启动」→ 1 fail；`open` 后不看 stderr → 1 fail。
  - `<profile>/lock` 从「'wx' 独占持有」改回「不存在才写」→ 持锁用例 1 fail。
- 临时数据根端到端（`DSH_HOME` 指向 `/tmp` 下的假 home，全程不碰本机 `~/.dsh/profiles/desktop`）：
  - `.app` 路径探活：`/System/Library/CoreServices/Finder.app` → 报「正在运行」并拒绝，manifest 未被写；进程名经 `plutil` 转换后取自 `CFBundleExecutable`。
  - 相对 `DSH_HOME=probe-rel`：报「是相对路径」并退出；`DSH_HOME='~user/x'` 报「不支持 ~user 写法」；`DSH_HOME=' /tmp/x '` 先 trim，profile 落到 `/tmp/x/profiles/desktop`。
  - `<profile>/lock` 里写当前 shell 的 PID：报「持有者还在」并退出；改写已退出的 PID（999999）后提示「陈旧锁，继续」并正常写入。
  - `DSH_DESKTOP_APP=DeepSeek Harness.app`（裸名）：解析到 `/Applications/DeepSeek Harness.app`，挂载成功；把假 `open` 放在 `PATH` 前拦下启动，实测发出的命令是 `open --env DSH_HOME=/tmp/probe-rel -a "/Applications/DeepSeek Harness.app"`——数据根是绝对路径、`.app` 也是绝对路径，真实应用没被拉起。
  - 应用名不存在（`__no_such_app__`）：早失败「找不到桌面应用」，manifest 与 `node_modules` 都没动（修复前会先写盘、最后才在 `open -a` 失败）。
  - `--remove` 装的是别的工作树：报「不是当前目录」，manifest 保持原样。
  - `--remove` 遇到实体目录 + manifest 有记录：整单拒绝，manifest 的 sha256 前后一致（哈希不变），实体目录仍在；手工删掉目录后重跑才摘干净。
  - 并发：挂载后同时起两个 `--remove`，一个报「manifest 已更新」、另一个「本来就没有」，退出码都是 0，最终 manifest 不残留本插件——持锁让两个写者串行。
  - `--remove` 时 `DSH_DESKTOP_APP` 指向不存在的应用：摘除照常完成（探活在挂载分支，摘除不看应用在不在）。
- 探活实证（macOS 只读）：`pgrep -x Finder` 命中、`pgrep -x /System/Library/CoreServices/Finder.app` 不命中；`Lark.app` 的 `CFBundleExecutable` 是 `Feishu`（按包名推进程名必漏判）。
- 实机（macOS，桌面版 0.2.1-rc.5）：`npm run desktop` 写入 `~/.dsh/profiles/desktop/package.json`（依赖 `link:/…/.worktrees/desktop-launcher`、bundles 末尾 `dsh-leader-kit`）并建链接；应用正常启动，Host 进程以 `profiles/desktop` 为参数加载，无致命错误。
- 应用运行中重跑 `npm run desktop` 被拒绝（`DeepSeek Harness 正在运行，profile 只在启动时读入`），profile 未被改动。
- `dsh --profile desktop --help` 返回 `profile "desktop" is managed exclusively by the Electron application`，确认无法用 CLI 形态替代验证。
- 未验证：非 macOS 平台的探活与「请手动启动」分支——脚本按 `process.platform !== 'darwin'` 直接返回「探不了」，本轮只在 macOS 上跑过；Windows 的 `~\` 展开与 junction `rmdir` 拆除同样只有用例与既有约定背书，没有真机读数。
