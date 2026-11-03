# 开发

本文件是开发环境、开发/日常实例与构建契约的唯一归属：一个任务一个 worktree、实例怎么起、数据落在哪儿、客户端产物为什么必须原子替换。命令速查在 [AGENTS.md 的常用命令](../AGENTS.md#常用命令)，浏览器侧取证流程见 [e2e-testing.md](e2e-testing.md)，架构侧的接缝见[架构文档](architecture.md)。

## 多 worktree 并发

每个任务一个 worktree、一个独立 dsh 实例，是这个仓库的开发形态——它同时也是本 bundle 玩法成立的前提（见 README 的[前提](../README_ZH.md#前提先跑通多-worktree-并发)）。`npm run worktree:spawn <任务名>` 建目录与分支（base 取最新 `origin/main`），进去后 `npm run dev` 起实例。

`npm run dev` 不碰你日常的 `~/.dsh`：数据根落在工作树内的 `.dev/home`（会话、项目、卡片都在那里，删掉即重置），profile 从 `~/.dsh/profiles/web` 派生，`node_modules` 逐条符号链接到源 profile、只有 `dsh-leader-kit` 指向当前工作树。所以几个工作树可以同时跑，各自的插件版本与数据互不干扰；源 profile 升级 dsh 或改插件组合时，开发实例跟着走。

- 凭据文件跟着数据根独立，新工作树第一次起实例本来要在界面上重填 API key：启动前会把源 HOME `.credentials.yaml` 的 `refs` 并进开发实例那一份。只搬 `refs`（按环境变量名存的密钥），不搬 `records`——账号授权的刷新令牌两个实例各持一份会互相踢掉登录。目标里已有的条目不动，界面里改过的值优先；要重新跟随源就删掉 `.dev/home/.credentials.yaml` 里那一条。块式与行内（`refs: {}`）两种 `refs` 节形态都认，写回替换该节；认不出、重复 `refs:`、锁超时都直接报错，不猜拼接位置。目标凭据文档不是 version 1 布局时不动——pre-release 扁平布局由宿主启动时自行迁移，先追加 `refs:` 会让它两种布局都不成立。写入走临时文件 + rename、权限 600，并与运行中的实例共用宿主的写者锁。没走 `DEEPSEEK_API_KEY` 启动环境那条路：它在 dsh 的凭据解析顺序里排在存储文件之后本来就能用，但 key 会留在 agent 工具进程的环境里。
- 端口默认交给系统分配，启动日志里打印带 token 的 URL；要固定就 `DEV_PORT=3210 npm run dev`。
- 改客户端代码（`src/client/`）由 `npm run dev` 挂的 esbuild watch 自动重建，宿主 web 组合默认挂着 `client-hmr`：它每 500ms 轮询插件产物的 `mtime/ctime/size`，变化就把运行中的插件换掉（拆旧 fiber、重新 `apply`），页面不刷新、插件内 React 状态重置、会话与连接数据保留。构建失败时正式产物保持上一份，watch 打印错误后继续监听；单独重建用 `npm run build:client`。宿主侧（`src/host/`）由 Node 直接加载，重启实例即可。
- 依赖共享主 checkout 的 `node_modules`（本仓库只有 esbuild 与 minidenticons），改 `package.json` 请在主 checkout 安装。
- 覆盖项：`DSH_HOME`（数据根，**不能等于 `DSH_HOME_SOURCE`**——那条路径会把日常 profile 改写成自指死链，脚本直接拒绝）、`DSH_HOME_SOURCE`（源 HOME，默认 `~/.dsh`）、`DSH_PROFILE`（源 profile 名，默认 `web`；那个 profile 的 bundles 里必须有 `@deepseek-ai/dsh-web-app`，否则脚本拒绝——缺它的 profile 跑 `dsh web` 不监听、不打印、也不报错）、`DEV_PORT`、`DEV_NO_OPEN=1`（不自动开浏览器）。

## 日常实例

`npm start` 起的是日常实例：数据根 `~/.dsh`（`DSH_HOME` 可换），profile 固定 `profiles/web`（`dsh web` 读的就是它），插件取该 profile 链接的版本。起之前依次检查——`dsh` 可执行文件（未装或不在 PATH 时给中文提示，`DSH_DSH` 可指定路径）、profile 存在、bundles 里有 web-app bundle 与本插件、`node_modules/dsh-leader-kit` 链接存在；全部通过后，若链接指的就是当前目录则先 `npm run build:client`（`lib/client.js` 不入库，没构建过时实例照常起来、右栏却没有看板）。从 worktree 里跑时链接指的是主 checkout，脚本跳过构建并提示那是另一个目录的代码——本目录的改动要在本目录里验证请用 `npm run dev`。额外参数原样转给 `dsh web`：`npm start -- --no-open --port 3210`。

桌面版：`npm run desktop` 把当前工作树挂进 `$DSH_HOME/profiles/desktop`（该 profile 归 Electron 独占，CLI 起不了它），改 manifest、建链接、重建产物后用 `open --env` 传数据根拉起；`--remove` 摘除，应用运行中或 profile 有锁时拒绝写入（锁与顺序见对应 Agent Note）。多工作树并行仍用 `npm run dev`。

## 收尾清理

清掉已合并的 worktree：

```sh
npm run worktree:prune                 # 只打印结论（dry-run）
npm run worktree:prune -- --apply      # 真删：worktree 目录 + 本地分支
npm run worktree:prune -- --apply --delete-remote   # 连远端分支一起删（--remote 指定远端，默认 origin）
```

守卫：有未提交改动的、当前所在的、分支没进 `main` 且 PR 未合并的，一律拒绝（合并判据：`merge-base --is-ancestor main` 或 PR 状态）。删 worktree 前先挪 `.dev` 到 `.worktrees/.dev-stash-<任务名>`、拆掉 `node_modules` 链接再 `git worktree remove`——Windows 上不先拆时 git 会跟随 junction 删掉主 checkout / 源 profile 的依赖；失败按原 target 恢复链接并把 `.dev` 挪回，git 已注销登记时只恢复 `.dev` 并提示手工清理。`--apply` 持有 `.worktrees/.prune.lock`（活 PID 不回收）。细节见[笔记](../.agents/notes/2026-11-02-win32-worktree-node-modules-teardown.md)。

也可以不用脚本、手工把插件装进某个 profile：`dsh plugin --profile web add ../dsh-leader-kit`（改代码即生效，但会与装进同一 profile 的其他工作树互相覆盖）。

## 测试与构建

只有 `node:test`，没有 lint：未使用的 import、死代码、拼写错误抓不到，改完要手扫。可判定逻辑抽成纯函数模块再测；IO 与 React 组件不硬测，判据在宿主 UI 里的行为用 `npm run e2e` 证明——真实 `dsh` 实例 + 本地 Messages mock + chromium，无密钥、不进 `npm run check`，场景写法与断言纪律见 [e2e-testing.md](e2e-testing.md)。能进 `tests/*.test.js` 的纯函数不要塞进 e2e。e2e 实例与 `npm run dev` 共用 `scripts/dev-instance.mjs` 的 profile 派生：两边组合必须一致，否则 e2e 测到的不是用户实际拿到的实例。

覆盖率门禁 `npm run test:coverage`（`npm run check` 末尾跑的就是它）判 `src` 下 per-file 行覆盖：没登记门槛的文件要求 100%，存量欠账按整数记在 `scripts/coverage-manifest.json` 的 `thresholds`，掉到门槛以下变红，涨出门槛会提示抬高。Node 只统计被加载过的文件，单测 import 不到的必须登记在 `unmeasured` 并写明理由（客户端组件由 e2e 覆盖）——新增 `src` 文件既不进报告也不登记同样变红。只判行覆盖：分支与函数覆盖率既不设门槛，也不进门禁输出。

浏览器侧产物不入库（`.gitignore` 忽略 `lib/`），发布时由 `prepublishOnly` 重建。构建入口 `build/client.mjs` 是薄壳，配置与原子写在 `build/client-bundle.mjs`：esbuild 先写 `<产物>.<pid>.<随机>.staging`，成功后才 rename 到正式路径——宿主按文件 stat 轮询产物，读到半截文件会替换失败且没有回滚，这条契约由 `tests/client-build.test.js` 守住（banner/footer 外壳、基线模块 external、构建失败保留上一份）。staging 带进程标识，同树的 watch 与手动构建并存时不会共写临时文件；两个进程仍会竞争最终产物，后完成 rename 的赢，但不保证内容新旧顺序。协议层的相对链接完整性由测试守住——搬动文件后链接断裂会直接测试失败。

## 发布与打包

`release:check = check + build:client + verify:pack`，`prepublishOnly` 挂的就是它：手动 `npm publish` 与 CI 走同一条链路，漏构建产物、漏 skill、混进测试都在上传前失败。顺序不能倒——`verify:pack` 要求 `lib/client.js` 已存在；只从无参发布的理由见[已知限制](limitations.md#发布)。

包内容判定不复刻 npm 的收录规则（`files` 前缀、dot 目录、`.gitignore` 都在 npm 里）：`npm pack` 打真实 tarball，用它的清单与 `scripts/pack-manifest.mjs` 的判定比对——必需集从 `main` / `exports` / `dsh.bundle.patch` 与 `files` 里的固定路径推导，skill 与 locale 由磁盘枚举，`.agents/` 只放行 `skills/` 前缀。清单过后把 tarball 装进临时目录按包名加载一遍（包入口导出、`src/host/**` 与 `src/shared/**` 逐文件 import、`lib/client.js` 外壳与 patch 文件）：`files` 收窄成 `["src/host/**"]` 时 `src/shared/*` 没进包、装上即 `ERR_MODULE_NOT_FOUND`。

发版走 tag：改 `package.json` 的 `version` → 提交 → 打 `v<version>` 并 push。`.github/workflows/publish.yml` 校验 tag 与 version 一致、提交在 `origin/main` 上（`git merge-base --is-ancestor`），再以 trusted publishing（OIDC）发布并建 GitHub Release；`ci.yml` 跑同一条 `release:check`（node 取 `24.9.0` 与最新 `24` 两档），发布 job 握着 OIDC 身份与 `contents: write`，所以 `actions/*` 都 pin 到 commit SHA。预发布走 `next` dist-tag，Release 标 prerelease。步骤与失败处理见 [release skill](../.telov/skills/release/SKILL.md)。

认证不落 secret：Trusted Publisher 登记本仓与 `publish.yml`，勾选允许 `npm publish`（预发布再勾 `npm dist-tag`），登记后 2 天内要有新版本真走 OIDC，否则过期。**首次发布是例外**：包不存在时无法登记，须本机交互式 `npm publish`（2FA OTP，无 provenance），随后 bump 新版本打 tag——首发版本已在 registry，推它的 tag 会被幂等守卫跳过。步骤见 [release skill](../.telov/skills/release/SKILL.md)。
