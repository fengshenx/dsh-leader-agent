# 发布到 npm 的基建与包内容门禁

## 背景

本仓要发到 npm，装法是 `dsh plugin --profile web add dsh-leader-kit`。发布前已有的只有半套：`files` 白名单、`prepublishOnly: npm run build:client`、LICENSE 与 README。缺的是发布链路本身——仓库元数据（`repository` / `homepage` / `bugs`）、`engines.node`、`publishConfig`、CI、以及一个能拦住「发出去的包缺文件」的机械门禁。

现状里有两个具体的坑：

- 包内容只能靠人记得跑 `npm pack --dry-run` 肉眼看。`tests/skills.test.js` 守的是 `files` 与 `SKILLS_DIR` 的对齐，不是 tarball 本身：改 `exports` 加新入口却忘了写进 `files`、`.agents/skills/**` 被误删，测试全绿而发出去的包是残的。
- `dependencies` 里的 `minidenticons` 是构建期依赖。`lib/client.js` 里没有 `require("minidenticons")`（esbuild 已把实现内联），这条运行期依赖只会在每个用户的 `node_modules` 里多装一份。

## 决策

### 门禁打真实的包，不复刻 npm 的收录规则

`scripts/verify-pack.mjs` 跑一次 `npm pack --dry-run --json`，用真实文件清单比对。不复刻 npm-packlist：`files` 前缀匹配、dot 目录（`.agents/skills`）的收录、`.gitignore` 忽略 `lib/` 之后 `files` 仍能带上它的行为，都是 npm 内部的语义，复刻一份就会随 npm 版本漂移，而且复刻错了比没有门禁更糟——它给人「已经校验过」的错觉。

判定拆成纯函数 `scripts/pack-manifest.mjs`：`requiredPackFiles` 从 `package.json` 的 `main` / `exports` / `dsh.bundle.patch` 推导必需集，`checkPackEntries` 比对 tarball 清单并拦开发残留。纯逻辑抽出来是为了能在没有 npm 的进程里单测，也是为了改入口时门禁跟着改——必需集只有 `package.json` 一个来源，门禁里不抄第二份清单。

### 必需集从 manifest 推导，skill 与 locale 靠磁盘枚举

`exports` 里的 `./locale/*.json` 是通配，取不到具体文件名；skill 目录也不在 manifest 里。这两类由调用方枚举磁盘补齐。`locale/*.json` 不是死文件：宿主的 `packages/boot/app-boot/src/package-meta.ts` 会读 `<包名>/locale/<lang>.json` 的 `meta.title` / `meta.description` 做插件显示名，`en.json` 还是其他语言的回落基准。`README.md` 与 `LICENSE` 不在 manifest 里，但它们与 `package.json` 一样是 npm 强制随包发布的文件，直接硬编码——它们不存在时包本身就不该发。

黑名单（`FORBIDDEN_PATTERNS`）是 `files` 白名单的补集，覆盖 `tests/`、`.agents/notes/`、`.agents/` 根下的散装 Markdown、`.dev/`、`.worktrees/`、`.github/`、`AGENTS.md` / `CLAUDE.md` / `SLOTS.md` / `COORDINATOR.md`、`docs/`、`scripts/`、`build/`、`node_modules/` 与 `.tgz` / `.DS_Store` 残留。它的作用不是复述白名单，而是白名单被放宽时兜底——`files` 里一旦出现 `"docs/**"` 或 `"*.md"`，`AGENTS.md`（写本机凭据布局）与决策笔记就会随包装进用户的 `node_modules`。`scripts/` 与 `build/` 进黑名单是当前事实：它们是开发工具，装机后没有任何加载路径会用到。

### 客户端产物要验形状，不只看在不在

`lib/client.js` 出现在 tarball 里不代表能用。空的、或没走 closure-factory 外壳的产物会让插件客户端半边整个起不来，而装机时没有任何报错（宿主按文件 stat 轮询产物，读到就下发）。`verify-pack.mjs` 因此额外检查产物开头 200 个字符里有 `window.__ModuleLoader__.load`。

### release:check 是唯一门禁入口，prepublishOnly 挂在它上面

`release:check = check + build:client + verify:pack`。`prepublishOnly` 指向它，CI 的 PR 检查也跑它。手动 `npm publish` 与 CI 因此走同一条链路：漏构建产物、`files` 漏 skill、包里混进测试，三者都在上传前失败。顺序不能倒：`verify:pack` 要求 `lib/client.js` 已存在，所以 `build:client` 在它前面。

### minidenticons 移进 devDependencies

`src/client/worker-report-avatar.js` 的 `import { minidenticon } from 'minidenticons'` 由 esbuild 打进 `lib/client.js`（构建配置只把 React 与宿主基线包留 external）。运行期没有任何一方 import 它，放在 `dependencies` 是多余的安装面与供应链面。移到 `devDependencies` 后本包零运行时依赖；`package-lock.json` 同步标记 `"dev": true`（顺带把 root 的 `engines.dsh` 从落后的 `rc.0` 修正到 `rc.2`）。

### 内联第三方代码的许可声明进产物 banner

`src/client/worker-report-avatar.js` 用 `minidenticons` 画 worker 头像，构建把它打进 `lib/client.js`；发布包里没有 `node_modules`，产物是用户唯一能拿到版权信息的位置。该包源码头部不带声明、MIT 文本只在它自己的 LICENSE 文件里，所以内联之后产物里原本一句版权都没有——MIT 要求许可随每一份副本走。在 `build/client-bundle.mjs` 的 banner 里补完整 MIT 文本，`tests/client-build.test.js` 断言产物含 `Copyright (c) 2021 Laurent Payot`，以后谁删掉 banner 都会红。声明放在 `window.__ModuleLoader__.load(...)` 之后、`var module` 之前，closure-factory 的 `startsWith` 契约不用改。

### tag 触发发布，带 provenance

`.github/workflows/publish.yml` 在 `v*` tag 上跑：先比 tag 与 `package.json` 版本（不一致就退 1——npm 会把新版本发在错误的 tag 上，之后只能靠 deprecated 收场），再 `npm ci`、`npm publish --provenance --access public`，最后建 GitHub Release。`repository` 字段是 provenance 的前提：npm 用它确认来源仓库与 workflow 一致。PR 与 `main` 上的 `.github/workflows/ci.yml` 跑 `release:check`。

发布这一步本身也要幂等：先 `npm view <name>@<version>` 探一次，已发布就跳过。缺了它，「发布成功但建 Release 失败」之后重跑会停在 `E403 cannot publish over`，Release 永远补不上；而 Release 那一步是幂等的，两步不对称就是坑。版本号带预发布段时走 `next` dist-tag（不指定时 rc 可能顶到 `latest`），Release 也标 prerelease。

### engines.node 跟宿主一致

宿主仓库的 root `engines.node` 是 `>=24.9.0`，本包跑在宿主进程里，声明同一个下限比抄一个更宽的区间更准确。代价要说清：本包自身没有用 24.9 专属 API（`Promise.withResolvers`、`import.meta.dirname` 等一处都没有），所以这个下限是跟随宿主的取舍——Node 22 用户会看到 `EBADENGINE`，`engine-strict` 打开时直接装不上。

## 边界

- **`NPM_TOKEN` 必须手工配**：仓库 secret，Automation 或 Granular access token，需要 publish 权限。首次发布时包在 npm 上还不存在、无法配 trusted publishing，只能用 token；发过一次后可以改成 OIDC 发布并删掉 secret。
- **provenance 只在 CI 里生成，且要求仓库公开**：本地 `npm publish` 没有 OIDC 身份，不会带来源证明。发布走 tag 才有；仓库已验证是 public（`gh repo view --json visibility` → `PUBLIC`）。
- **只从 `npm publish`（不带路径参数）发布**：`prepublishOnly` 只在无参发布时执行，`npm publish xxx.tgz` 不跑生命周期脚本，`release:check` 整段被跳过。README 的发版一节写了这条。
- **不自动改版本号**：版本仍在 `package.json` 里手工改，tag 由人打。自动 bump 需要与 release notes 生成策略一起定，这次不引入。
- **不预检 npm 上的版本占用**：`verify:pack` 不查 registry（dry-run 只打包），重复版本由 npm 自己拒；workflow 里的 `npm view` 探测只为跳过已发布，不改变这条。
- **git 直装拿不到客户端产物**：`lib/client.js` 不入库，仓里没有 `prepare` 钩子。`dsh plugin add git+…` 只适合验证宿主侧；要连客户端一起验证就装 npm 版本，或本地构建后用路径装。
- **黑名单与 files 白名单的方向不同**：将来若要把 `scripts/` 之类打进包（比如加 postinstall 脚本），必须同步改 `FORBIDDEN_PATTERNS`，否则门禁会挡。
- **verify:pack 依赖本机 npm**：`spawnSync` 调 `npm pack`，Windows 上经 shell 解析（`npm` 实际是 `npm.cmd`）。不需要网络：dry-run 只打包，不查询 registry。

## 验证

`npm run check` 765 用例全绿，新增 `tests/pack-manifest.test.js` 8 条（必需集从 manifest 推导、改入口即改门禁、通配子路径不进必需集、缺件逐个报、开发残留逐个拦、白名单放宽后仓内文档与决策笔记仍被拦、发布目录不被误判）；`tests/client-build.test.js` 加两条断言（产物含 minidenticons 的版权行）。

`npm run release:check` 全链路通过：`verify-agent-note-format: 50 篇笔记格式合规`、`verify-doc-tool-names: 11 篇文档的工具名全部存在`、765 用例、`verify-pack: 82 个文件（未压缩 906 kB），必需项齐全、无开发残留`。

双向验证（每次还原后重跑均全绿）：

- 从 `files` 删掉 `.agents/skills/**` → `verify:pack` 退 1，逐条报 `缺 .agents/skills/init-project/SKILL.md` 等 9 个 skill 文件。
- 从 `files` 删掉 `lib/client.js`、并加上 `tests/**` → 退 1，报 `缺 lib/client.js（先跑 npm run build:client）` 与 56 条 `不该进包：tests/...`。
- 临时加一个 `"prepack": "node -e \"console.log('noise-from-prepack')\""` → 退 1，报 `解析 npm pack --json 的输出失败（Unexpected token 'o', "noise-from-p"...）` 并打出「先查 prepare / prepack / postpack」与 stdout 前 200 字符，不再是裸的 `SyntaxError`。

`npm publish --dry-run`：`prepublishOnly` 自动跑完 `release:check` 后完成打包（82 个文件、unpacked 927.6 kB、`Publishing to https://registry.npmjs.org with tag latest and public access (dry-run)`），确认嵌套的 `npm pack` 与外层发布流程不冲突。

`npm view dsh-leader-kit version` 返回 `E404`——包名未被占用。

未验证：GitHub Actions 两个 workflow 没有在远端真跑过（需推 PR 与 tag）；`npm publish` 没有真正上传（缺 `NPM_TOKEN`）；provenance 与 npm 页面上的来源标记同样待首次发布后确认。
