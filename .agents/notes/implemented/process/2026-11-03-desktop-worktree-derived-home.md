# 桌面版在 worktree 里改用派生数据根，不动别人的 desktop profile

**日期**：2026-11-03

## 背景

桌面应用的 profile 固定是 `$DSH_HOME/profiles/desktop`（`apps/desktop/src/paths.ts`），只有一份。主 checkout 装过一次之后，在 worktree 里跑 `npm run desktop` 会被 `planDesktopEnable` 拒绝——`dependencies['dsh-leader-agent']` 指着 `link:<主 checkout>`，不是当前目录。想在这个分支上验证改动，唯一出路是先把主 checkout 那份卸掉，验证完再装回来。

实际使用里这条路走不通：几个 worktree 并行开发时谁跑一次就把别人的挂载顶掉；主 checkout 的桌面版也会在下次启动时变成某个分支的代码。而「不覆盖别人的安装」本来就是这个脚本的既有语义（`planDesktopEnable` / `planDesktopDisable` / `planLinkAction` 三个守卫），不能为了跑通把它拆掉。

`npm run dev` 早就解决过同一个问题：数据根落工作树内、profile 从日常根派生、依赖链回源。桌面的差别只是 profile 名叫 `desktop`、启动走 Electron 而不是 `dsh web`。

## 决策

**按当前目录的身份选数据根，`planDesktopHome` 是唯一判定点**：

- worktree 内（`.git` 是文件）→ 派生 `<工作树>/.dev/desktop-home`：profile 从 `~/.dsh/profiles/desktop` 派生（`deriveProfilePackage` 照抄依赖与 bundle，只把本插件换成工作树链接），`node_modules` 逐条链回源 profile，日常 profile 一个字节都不动；
- 主 checkout 内（`.git` 是目录）→ 照旧写 `~/.dsh/profiles/desktop`；
- 显式 `DSH_HOME` → 两条都不走，就写那一份根。

派生与依赖链接直接调 `dev-instance.mjs` 的 `prepareProfileDir`，与 `npm run dev`、e2e 共用同一份实现：三处的组合一旦漂移，e2e 测到的就不是用户拿到的实例。

**凭据也跟着搬**：派生数据根独立，`.credentials.yaml` 也就独立，不搬 `refs` 的话派生根实例一进界面就没有 API key。`inheritCredentialRefs` 从 `dev.mjs` 挪进 `dev-instance.mjs`（两处调用、一份实现），只搬 `refs` 不搬 `records`——账号授权的刷新令牌两个实例各持一份会互相踢掉登录；目标里已有的条目优先，写入走临时文件 + rename、权限 600，并与运行中的实例共用宿主的写者锁。不改成 `DEEPSEEK_API_KEY` 启动环境注入：那样 key 会留在 agent 工具进程的环境里。

派生数据根是 `.dev/desktop-home` 而不是 `.dev/home`：`npm run dev` 与桌面实例同时开着时，共用一份数据根会让两边往同一批会话、项目、卡片里写。

顺序上，**探活放在派生之前**：应用在跑时连派生根都不碰，免得改到正在被读的 profile。

`--remove` 反方向但同样只算路径、不派生：派生带副作用（建目录、重写 manifest、把日常凭据复制进来），而「这根上没挂过」本来就该是空操作。摘除因此只用 `derivedDesktopPaths` 算出目标根，判的是**那条根上有没有挂载**：派生根没建过就打印「没有可摘的挂载」返回，不创建任何目录、不读日常凭据。它也早于「日常 profile 是否存在」的检查——日常那份被删掉时，派生根里的挂载照样摘得掉。

## 边界

- **`--remove` 不依赖日常 profile**。摘的是目标根：日常 profile 缺 `node_modules`、甚至整个不存在，都不影响摘派生根。反过来说，「派生 + 摘除」的对称性靠同一处路径计算（`derivedDesktopPaths`）保证，不靠两段各自拼路径。

- **数据是两套**。派生根的会话、项目、卡片与日常实例不通；这是隔离的代价，不是缺陷。要日常那套就在主 checkout 跑。
- **同一时刻只能有一个桌面实例**。Electron 的 `requestSingleInstanceLock` 按 userData（共享的 `%APPDATA%\@deepseek-ai\dsh-desktop`）判定，日常实例在跑时派生根起的进程会自己退出。脚本在探到运行态时直接拒绝，不为隔离实例绕单实例锁（`--user-data-dir` 会把账号与更新状态一起隔离，代价更大）。
- **源 profile 必须存在**。派生根从日常 profile 抄依赖；日常 profile 不存在时报的是原来那条「先打开一次桌面应用」，不新建一个空 profile 去「派生出没有依赖的实例」。
- **worktree 判定用 `.git` 是文件还是目录**，不起 git 子进程。把仓库 clone 到别处（`.git` 是目录）仍算主 checkout 语义——那台机器上它就是日常那份。
- 派生根在 `.dev/` 下，已被 gitignore，删掉即重置；`worktree:prune` 会随 `.dev` 一起挪走。

## 验证

- 单测（`tests/desktop-plan.test.js`，Windows 上 36 pass / 0 fail）：`planDesktopHome` 覆盖 worktree 与主 checkout 两态、`installedSpec` 只作为提示；`derivedDesktopHome` 断言与 `.dev/home` 不同目录；接线断言锁住「`DSH_HOME` 未显式指定」「源固定成 `dailyPaths.home`」「派生在 `withProfileLock` 之前」「worktree 标记读 `.git` 的文件态」「派生时把日常凭据的 refs 搬进派生根」「摘除分支不调用 `prepareDerivedPaths`」。
- 真机（Windows，桌面版 0.2.1-rc.5，worktree 内 `node scripts/desktop.mjs`，日常 `~/.dsh/profiles/desktop` 只读）：
  - 输出走「分支隔离」分支，数据根 `…\.worktrees\windows-desktop-launch\.dev\desktop-home`，插件链接指向当前工作树；
  - 宿主进程命令行第 4 个参数是 `<派生根>\profiles\desktop`，派生根生成 `sessions`、`storages`、`.credentials.yaml`；
  - 插件确实激活：桌面版监听的端口上 `POST /api/projects/list`、`/api/cards/list` 返回 **401**（路由存在、要鉴权）；同机另一个监听端口返回 404——404 正是宿主半边未激活时的形态，两者能区分开；
  - 日常 profile 的 `package.json` sha256 前后一致，`node_modules/dsh-leader-agent` 始终不存在；
  - 凭据继承：派生根的 `.credentials.yaml` 从只有 `records` 变成 `version: 1` + `refs: DEEPSEEK_API_KEY`，输出打印一行「凭据引用 日常 → 派生根（DEEPSEEK_API_KEY）」；同目录的 `records`（browser-session）原样保留，`records` 不参与合并；
  - 应用运行中重跑：报「正在运行」、退出 1、派生根 manifest 哈希不变（探活在派生之前）；
  - `--remove`：摘掉派生根的依赖与链接，日常 profile 哈希仍不变。
- `inheritCredentialRefs` 搬出 `dev.mjs` 后用探针脚本验三种形态：源有 `refs` 时搬过来、目标已有同名键时不覆盖（`keys` 为空）、源不存在时不建目标文件。
- `--remove` 的对称性由 `tests/desktop-remove.integration.test.js` 钉住（真实脚本 + 临时 `USERPROFILE`/`HOME`，4 条：派生根没建过是空操作、派生根已存在时只摘它且日常根缺 `node_modules` 也不重建、显式 `DSH_HOME` 不派生、主 checkout 摘日常根不建 `.dev`）。撤销「摘除不派生」后前两条变红；两条都断言日常根文件的 sha 与 mtime 前后不变。
- 未验证：macOS 上的派生分支（本机无 macOS；两端共用同一段路径计算与 `open --env`，平台差异只在校验过的启动那一段）。
