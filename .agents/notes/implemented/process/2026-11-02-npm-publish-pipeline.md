# 发布到 npm 的基建与包内容门禁

## 背景

本仓要发到 npm，装法是 `dsh plugin --profile web add dsh-leader-kit`。发布前已有的只有半套：`files` 白名单、`prepublishOnly: npm run build:client`、LICENSE 与 README。缺的是发布链路本身——仓库元数据（`repository` / `homepage` / `bugs`）、`engines.node`、`publishConfig`、CI、以及一个能拦住「发出去的包缺文件」的机械门禁。

现状里有两个具体的坑：

- 包内容只能靠人记得跑 `npm pack --dry-run` 肉眼看。`tests/skills.test.js` 守的是 `files` 与 `SKILLS_DIR` 的对齐，不是 tarball 本身：改 `exports` 加新入口却忘了写进 `files`、`.agents/skills/**` 被误删，测试全绿而发出去的包是残的。
- `dependencies` 里的 `minidenticons` 是构建期依赖。`lib/client.js` 里没有 `require("minidenticons")`（esbuild 已把实现内联），这条运行期依赖只会在每个用户的 `node_modules` 里多装一份。

## 决策

### 门禁打真实的包，不复刻 npm 的收录规则

`scripts/verify-pack.mjs` 打一次真实的包（`npm pack` 落盘到临时目录），用它的文件清单比对。不复刻 npm-packlist：`files` 前缀匹配、dot 目录（`.agents/skills`）的收录、`.gitignore` 忽略 `lib/` 之后 `files` 仍能带上它的行为，都是 npm 内部的语义，复刻一份就会随 npm 版本漂移，而且复刻错了比没有门禁更糟——它给人「已经校验过」的错觉。tarball 落在 `mkdtemp` 的临时目录，跑完即删，仓库里不留 `.tgz`。

判定拆成纯函数 `scripts/pack-manifest.mjs`：`requiredPackFiles` 从 `package.json` 的 `main` / `exports` / `dsh.bundle.patch` 推导必需集，`checkPackEntries` 比对 tarball 清单并拦开发残留。纯逻辑抽出来是为了能在没有 npm 的进程里单测，也是为了改入口时门禁跟着改——必需集只有 `package.json` 一个来源，门禁里不抄第二份清单。

### 清单全绿不等于包能用：装机 smoke

必需集只能验「声明的入口在包里」。`files` 从 `"src/**"` 收窄成 `["src/host/**"]`（整理白名单时最容易这么写）时，入口、skill、locale、客户端产物全在，清单检查 42 个文件全绿——而 `src/host/*` 依赖的 `src/shared/*` 一个都没进包，用户装上后第一次加载就是 `ERR_MODULE_NOT_FOUND`。这正是这条门禁声称要拦的那类事故。

所以清单之后还有一步：把 tarball `npm install --omit=dev` 进干净的临时目录，再按包名 `import` 一遍——包入口（`name` / `inject` / `apply` 三个导出）、`<包>/src/host`，以及 `src/host/**` 与 `src/shared/**` 下的每个文件。逐文件加载是必要的：只 import 包入口只能覆盖静态 import 链当下覆盖到的模块，逐文件加载能一并抓住 `src/shared` 漏进包与将来新增的兄弟目录。跑完再检查装好的包里 `lib/client.js` 在不在、是不是 closure-factory 产物，以及 `dsh.bundle.patch` 指向的文件在不在。

这一步跑的是装机方的解析路径（`exports` 映射、`main`、相对 import），不是仓库里的源码；本包零运行时依赖，`npm install` 只装本地 tarball、不碰 registry。代价是每次 `verify:pack` 多一次安装（本机约 0.8 秒）。

### `.agents/` 按「只允许 skills 前缀」正向判定

`.agents/` 是唯一一个既有该发布内容（协议层 skill）又有严禁外发内容的目录：`notes/` 是决策记忆，将来的 `prompts/` 之类同样会带仓内上下文进用户的 `node_modules`。逐条禁止在这里不稳——`files` 只要写成 `.agents/**`，新目录的文件就静默进包，而「记得同步加一条禁用规则」正是会忘的那一步。

所以这里不做补集，而是一个允许面：`.agents/skills/` 下的路径放行（结构另由 `tests/skills.test.js` 约束），`.agents/` 下其余一律拦。前缀带尾斜杠，`.agents/skills-extra/x.md` 也拦得住。其余目录（`tests/`、`scripts/`、`build/`、`docs/`、仓根文档）保持逐条禁止：它们是固定的开发目录，新增一个不会悄悄带上仓内上下文。

### 必需集从 manifest 推导，skill 与 locale 靠磁盘枚举

`exports` 里的 `./locale/*.json` 是通配，取不到具体文件名；skill 目录也不在 manifest 里。这两类由调用方枚举磁盘补齐。`locale/*.json` 不是死文件：宿主的 `packages/boot/app-boot/src/package-meta.ts` 会读 `<包名>/locale/<lang>.json` 的 `meta.title` / `meta.description` 做插件显示名，`en.json` 还是其他语言的回落基准。`README.md` 与 `LICENSE` 不在 manifest 里，但它们与 `package.json` 一样是 npm 强制随包发布的文件，直接硬编码——它们不存在时包本身就不该发。

`files` 里的固定路径（不带通配的条目，如 `README_ZH.md`、`lib/client.js`）同样并进必需集。方向是「白名单声明了就必须真的在包里」：文件改名后 `files` 还留着旧名时 npm 不报错、只是不带它，门禁照绿——这正是假绿的另一个方向。通配条目（`src/**`）不展开，覆盖面由 `exports` 推导加装机 smoke 兜住。

黑名单（`FORBIDDEN_PATTERNS`）是 `files` 白名单的补集，覆盖 `tests/`、`.dev/`、`.worktrees/`、`.github/`、`AGENTS.md` / `CLAUDE.md` / `SLOTS.md` / `LEADER.md` / `COORDINATOR.md`、`docs/`、`scripts/`、`build/`、`node_modules/` 与 `.tgz` / `.DS_Store` 残留（`.agents/` 由上一个子节的允许面管）。它的作用不是复述白名单，而是白名单被放宽时兜底——`files` 里一旦出现 `"docs/**"` 或 `"*.md"`，`AGENTS.md`（写本机凭据布局）与决策笔记就会随包装进用户的 `node_modules`。`scripts/` 与 `build/` 进黑名单是当前事实：它们是开发工具，装机后没有任何加载路径会用到。

### 客户端产物要验形状，不只看在不在

`lib/client.js` 出现在 tarball 里不代表能用。空的、或没走 closure-factory 外壳的产物会让插件客户端半边整个起不来，而装机时没有任何报错（宿主按文件 stat 轮询产物，读到就下发）。`verify-pack.mjs` 因此额外检查产物开头 200 个字符里有 `window.__ModuleLoader__.load`。

### release:check 是唯一门禁入口，prepublishOnly 挂在它上面

`release:check = check + build:client + verify:pack`。`prepublishOnly` 指向它，CI 的 PR 检查也跑它。手动 `npm publish` 与 CI 因此走同一条链路：漏构建产物、`files` 漏 skill、包里混进测试，三者都在上传前失败。顺序不能倒：`verify:pack` 要求 `lib/client.js` 已存在，所以 `build:client` 在它前面。

### 门禁不继承调用方的 npm 开关

门禁里的 `npm pack` 与 `npm install` 是子进程，而 `prepublishOnly` 自己跑在外层 npm 里：npm 把解析好的配置导出成 `npm_config_*`，于是 `npm publish --dry-run` 会让内层 `npm pack` 也进 dry-run——不落 tarball，装机 smoke 随即 `ENOENT`。单独跑 `npm run verify:pack` 不复现，只有发布会踩，而发布正是它要拦的场合。

所以 `runNpm` 起子进程前删掉全部 `npm_config_*`：门禁按自己的参数打包与安装。没有逐个覆盖（`--no-dry-run` 之类）——`ignore_scripts`、`tag`、`otp` 同源继承，白名单会漏，而漏掉一个就等于门禁按调用方的开关跑。

### minidenticons 移进 devDependencies

`src/client/worker-report-avatar.js` 的 `import { minidenticon } from 'minidenticons'` 由 esbuild 打进 `lib/client.js`（构建配置只把 React 与宿主基线包留 external）。运行期没有任何一方 import 它，放在 `dependencies` 是多余的安装面与供应链面。移到 `devDependencies` 后本包零运行时依赖；`package-lock.json` 同步标记 `"dev": true`（顺带把 root 的 `engines.dsh` 从落后的 `rc.0` 修正到 `rc.2`）。

### 内联第三方代码的许可声明进产物 banner

`src/client/worker-report-avatar.js` 用 `minidenticons` 画 worker 头像，构建把它打进 `lib/client.js`；发布包里没有 `node_modules`，产物是用户唯一能拿到版权信息的位置。该包源码头部不带声明、MIT 文本只在它自己的 LICENSE 文件里，所以内联之后产物里原本一句版权都没有——MIT 要求许可随每一份副本走。在 `build/client-bundle.mjs` 的 banner 里补完整 MIT 文本，`tests/client-build.test.js` 断言产物含 `Copyright (c) 2021 Laurent Payot`，以后谁删掉 banner 都会红。声明放在 `window.__ModuleLoader__.load(...)` 之后、`var module` 之前，closure-factory 的 `startsWith` 契约不用改。

### tag 触发发布，带 provenance

`.github/workflows/publish.yml` 在 `v*` tag 上跑：先比 tag 与 `package.json` 版本（不一致就退 1——npm 会把新版本发在错误的 tag 上，之后只能靠 deprecated 收场），再验 tag 指向的提交在 `origin/main` 上（`git merge-base --is-ancestor`，`fetch-depth: 0` 已具备，显式 fetch 一次 `main` 不依赖 checkout 的 refspec 细节），然后 `npm ci`、`npm publish --provenance --access public`，最后建 GitHub Release。只比版本不验位置的话，从 feature 分支打的 tag 也一致，而那次提交没经过 `main` 上的 `release:check`——发出去不可回收。`repository` 字段是 provenance 的前提：npm 用它确认来源仓库与 workflow 一致。PR 与 `main` 上的 `.github/workflows/ci.yml` 跑 `release:check`。

发布 job 同时握着 `NODE_AUTH_TOKEN`、`contents: write` 与 `id-token: write`，所以 `actions/checkout` 与 `actions/setup-node` 都 pin 到完整 commit SHA（注释里写版本号）：浮动 major tag 被上游 retag 后，新代码在 `npm publish` 之前就能读到 token。`ci.yml` 声明 `permissions: contents: read`（仓库默认 token 权限设成 write 时，不声明就等于把写权限交给任何改脚本的 PR），并按 matrix 跑 `24.9.0` 与最新 `24` 两档——下限与 `engines.node` 同一来源，只跑最新版时用了更高版本才有的 API 也发现不了。

发布这一步本身也要幂等：先 `npm view <name>@<version>` 探一次，已发布就跳过。缺了它，「发布成功但建 Release 失败」之后重跑会停在 `E403 cannot publish over`，Release 永远补不上；而 Release 那一步是幂等的，两步不对称就是坑。版本号带预发布段时走 `next` dist-tag（不指定时 rc 可能顶到 `latest`），Release 也标 prerelease。

### engines.node 跟宿主一致

宿主仓库的 root `engines.node` 是 `>=24.9.0`，本包跑在宿主进程里，声明同一个下限比抄一个更宽的区间更准确。代价要说清：本包自身没有用 24.9 专属 API（`Promise.withResolvers`、`import.meta.dirname` 等一处都没有），所以这个下限是跟随宿主的取舍——Node 22 用户会看到 `EBADENGINE`，`engine-strict` 打开时直接装不上。

## 边界

- **`NPM_TOKEN` 路线已废弃**：npm 已宣布 bypass-2FA token 从 2027-01 起不能直接发布；本仓改为首发本机交互式发布、之后走 OIDC，见 [2026-11-03-npm-oidc-publishing.md](2026-11-03-npm-oidc-publishing.md)。
- **provenance 只在 CI 里生成，且要求仓库公开**：本地 `npm publish` 没有 OIDC 身份，不会带来源证明。发布走 tag 才有；仓库已验证是 public（`gh repo view --json visibility` → `PUBLIC`）。
- **只从 `npm publish`（不带路径参数）发布**：`prepublishOnly` 只在无参发布时执行，`npm publish xxx.tgz` 不跑生命周期脚本，`release:check` 整段被跳过。这一条写在[发布与打包](../../../../docs/development.md#发布与打包)。
- **不自动改版本号**：版本仍在 `package.json` 里手工改，tag 由人打。自动 bump 需要与 release notes 生成策略一起定，这次不引入。
- **不预检 npm 上的版本占用**：`verify:pack` 不查 registry（打包与装本地 tarball 都不需要 registry），重复版本由 npm 自己拒；workflow 里的 `npm view` 探测只为跳过已发布，不改变这条。
- **git 直装拿不到客户端产物**：`lib/client.js` 不入库，仓里没有 `prepare` 钩子。`dsh plugin add git+…` 只适合验证宿主侧；要连客户端一起验证就装 npm 版本，或本地构建后用路径装。
- **黑名单与 files 白名单的方向不同**：将来若要把 `scripts/` 之类打进包（比如加 postinstall 脚本），必须同步改 `FORBIDDEN_PATTERNS`，否则门禁会挡。`.agents/` 是例外方向——那里只放行 `skills/` 前缀，新增目录要改的是允许面，不是禁用名单。
- **装机 smoke 只覆盖宿主侧加载**：`src/client/**` 依赖 React 与宿主基线模块，装出来的 `node_modules` 里没有它们，所以不 import；客户端侧只验产物形状（`window.__ModuleLoader__.load` 外壳）与它在包内，浏览器里的真实行为仍靠真机取证。
- **smoke 的 `npm install` 带 `--ignore-scripts`**：本包不需要安装期脚本，跳过它让每次门禁的读数只取决于包内容。将来真加了 `postinstall`，这条要同步改，否则那段脚本永远不被门禁覆盖。
- **verify:pack 依赖本机 npm**：经 `scripts/spawn-command.mjs` 的 `spawnCommandSync` 调 `npm pack` 与 `npm install`（Windows 上 npm 是 shim，直接 `spawnSync('npm')` 报 ENOENT；`tests/spawn-command-usage.test.js` 守这一条）。不需要网络：装的是本地 tarball，且本包零运行时依赖。
- **actions 的 SHA 要手工跟进**：pin 到 commit SHA 后不会自动收安全更新（未接 Dependabot）。升 action 时把 SHA 与注释里的版本号一起改，别改回浮动 tag。
- **幂等跳过不校验 registry 上的内容**：`npm view <name>@<version>` 命中就跳过发布，不比对 digest。内容一致性由「发布前同一个提交跑过 `release:check`」保证；要比对得先把 tarball 拉下来，成本高于收益。
- **`verify:pack` 用的是磁盘上已有的 `lib/client.js`**：没先 `build:client` 时，smoke 装进临时目录的就是上一次的产物。`release:check` 先构建，所以发布链路不受影响；单跑门禁时自己保证构建过。
- **发布说明按文档分层落位**：流程与命令在[发布与打包](../../../../docs/development.md#发布与打包)，限制在[发布](../../../../docs/limitations.md#发布)；README 是亮点层，不写发版步骤（合并 main 时把原本放在 README 的一节搬了过去）。这两篇因此各抬了一次天花板（`docs/development.md` 1780 → 2500、`docs/limitations.md` 6300 → 6750）：新增的是整条发布链路的操作契约与发布侧边界，放 Note 里就失去「发布怎么做」的归属，压缩空间在信息量上不划算（development 已从 2423 压到 2360，并把「只从无参发布」的事实搬到 limitations）；抬后余量分别是 5.6% 与 6.7%。

## 验证

`npm run check` 991 用例（975 通过、16 条 Windows 相关在非 Windows 上 skip）全绿，`tests/pack-manifest.test.js` 11 条（必需集从 manifest 推导、`files` 固定路径并进必需集、改入口即改门禁、通配子路径不进必需集、缺件逐个报、开发残留逐个拦、白名单放宽后仓内文档与决策笔记仍被拦、`.agents` 只放行 skills 子树、`files` 放宽到 `.agents/**` 时 notes 与新增目录仍被拦、发布路径不被误判）；`tests/client-build.test.js` 断言产物含 minidenticons 的版权行。

`npm run release:check` 全链路通过：`verify-agent-note-format: 64 篇笔记格式合规`、`verify-doc-tool-names: 11 篇文档的工具名全部存在`、13 篇 standing docs 都在天花板内、`check-syntax: 96 个文件通过`、975 用例通过（991 总数、16 skip）、`verify-pack: 86 个文件（未压缩 994 kB），必需项齐全、无开发残留，装机 smoke 通过`。

双向验证（每次还原后重跑均全绿）：

- `files` 的 `"src/**"` 收窄成 `["src/host/**"]` → 文件清单 42 个、必需项齐全（假绿复现），`verify:pack` 退 1：12 条 `smoke: 加载 src/host/... 失败：Cannot find module .../src/shared/frontmatter.js` 加一条根因 `包里没有 src/shared/（files 白名单没覆盖它）`。
- `files` 的 `.agents/skills/**` 改成 `.agents/**`，并造 `.agents/prompts/hidden.md` → 撤销修复（逐条禁止的旧规则）时 50 条 notes 被拦、`hidden.md` 放行（漏拦复现）；还原成允许面后 51 条全拦。单测同向：撤销修复 9 pass / 2 fail，还原 11 pass。
- `files` 里的 `README_ZH.md` 写成不存在的 `README_ZH_OLD.md` → 退 1，报 `缺 README_ZH_OLD.md`（白名单声明了就必须真的在包里）。
- 撤销 `npm_config_*` 清洗后跑 `npm publish --dry-run` → 退 1，报 `ENOENT … /dsh-leader-kit-pack-*/dsh-leader-kit-0.1.0.tgz`；还原后同一条命令输出 `+ dsh-leader-kit@0.1.0`。
- 从 `files` 删掉 `.agents/skills/**` → 退 1，逐条报 `缺 .agents/skills/init-project/SKILL.md` 等 9 个 skill 文件。
- 把 `lib/client.js` 挪走 → 退 1，报 `缺 lib/client.js（先跑 npm run build:client）`。
- 临时加一个 `"prepack": "node -e \"console.log('noise-from-prepack')\""` → 退 1，报 `解析 npm pack --json 的输出失败（Unexpected token 'o', "noise-from-p"...）` 并打出「先查 prepare / prepack / postpack」与 stdout 前 200 字符，不再是裸的 `SyntaxError`。

`npm publish --dry-run`：`prepublishOnly` 自动跑完 `release:check` 后完成打包（86 个文件、压缩后 319.9 kB、`Publishing to https://registry.npmjs.org with tag latest and public access (dry-run)`、`+ dsh-leader-kit@0.1.0`），确认嵌套的 `npm pack`（含 smoke 的安装）与外层发布流程不冲突。

`npm view dsh-leader-kit version` 返回 `E404`——包名未被占用。

`nvm exec 24.9.0 npm run check` 与同一版本上的 `verify:pack` 都全绿（975 pass / 991 总数 / 16 skip、86 个文件）。`ci.yml` 的 matrix 档位就是这个版本。

`git ls-remote --tags` 核实 pin 的 SHA 就是 v7 tag 当前指向：`actions/checkout@3d3c42e5…`（= v7.0.1）、`actions/setup-node@949feb24…`（= v7.1.0）。

未验证：`publish.yml` 没有远端真跑（tag 发布链路不能试跑）；`npm publish` 没有真正上传（缺 `NPM_TOKEN`）；provenance 与 npm 页面上的来源标记同样待首次发布后确认。
