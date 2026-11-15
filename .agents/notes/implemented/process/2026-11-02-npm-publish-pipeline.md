# 发布到 npm 的基建与包内容门禁

## 背景

装法是 `dsh plugin --profile web add dsh-leader-agent`，而发布前只有半套：`files` 白名单、`prepublishOnly`、LICENSE 与 README，缺发布链路本身与「发出去的包缺文件」的机械门禁——`tests/skills.test.js` 守的是 `files` 与 skill 目录对齐，不是 tarball。

## 决策

> **发布链路的现行操作归 [docs/release.md](../../../../docs/release.md)**：tag 触发、provenance、幂等与 SHA pin 的步骤在那里维护；本节保留当时的选型理由与取舍。

- **门禁打真实的包**：`npm pack` 落临时目录、跑完即删，用它自己的清单比对；不复刻 npm-packlist（`files` 前缀匹配、dot 目录、被 gitignore 的 `lib/` 仍能带上，都是 npm 内部语义，复刻会随版本漂移）。必需集由 `scripts/pack-manifest.mjs` 从 `package.json` 的 `main` / `exports` / `dsh.bundle.patch` 推导，门禁里不抄第二份。
- **清单全绿不等于包能用**：再 `npm install --omit=dev` 进干净临时目录，按包名 import 入口、`<包>/src/host` 与 `src/host/**`、`src/shared/**` 的每个文件，再验 `lib/client.js` 是 closure-factory 产物、`dsh.bundle.patch` 指向的文件在包里。逐文件加载才能抓住「`files` 收窄到 `src/host/**`、`src/shared` 漏进包」这类清单全绿的事故。
- **`.agents/` 只放行 `skills/` 前缀**：这是唯一既该发布又严禁外发的目录，逐条禁止挡不住 `files` 写成 `.agents/**`；前缀带尾斜杠，`.agents/skills-extra/` 也拦。其余开发目录逐条禁止（`tests/`、`scripts/`、`build/`、`docs/`、仓根文档），新增一个不会悄悄带上仓内上下文。
- **必需集补齐磁盘枚举**：`exports` 的 `./locale/*.json` 是通配、skill 目录不在 manifest 里，由调用方枚举；`README.md` / `LICENSE` 是 npm 强制随包的文件，硬编码。`files` 里的固定路径并进必需集——白名单声明了就必须真的在包里，改名后 npm 不报错、只是不带它。
- **客户端产物验形状**：`lib/client.js` 在 tarball 里不代表能用，检查开头有 `window.__ModuleLoader__.load`（宿主按 stat 轮询，坏产物装机时没有任何报错）。
- **`release:check` 是唯一入口**：`check + build:client + verify:pack`，`prepublishOnly` 与 CI 都指向它，顺序不能倒（`verify:pack` 要求产物已存在）。门禁不继承调用方 npm 开关：起子进程前删掉全部 `npm_config_*`，否则 `npm publish --dry-run` 会让内层 `npm pack` 也不落 tarball。
- **零运行时依赖**：`minidenticons` 只在构建期内联进产物，放 `devDependencies`；内联的第三方代码要在产物 banner 里带完整 MIT 文本——发布包没有 `node_modules`，产物是用户唯一能拿到版权信息的位置。
- **发布只在 CI 的 tag 上跑，且必须带 provenance**：tag 要指向 `origin/main` 上的提交、版本与 `package.json` 一致；操作细节归 [docs/release.md](../../../../docs/release.md)。
- **`engines.node` 跟宿主一致**（`>=24.9.0`）：本包跑在宿主进程里，本身没用 24.9 专属 API，这是跟随宿主的取舍。

## 边界

- `NPM_TOKEN` 路线已废弃，见 [2026-11-03-npm-oidc-publishing.md](2026-11-03-npm-oidc-publishing.md)；provenance 只在 CI 生成且要求仓库公开。
- 只从无参 `npm publish` 发布：带路径参数不跑生命周期脚本，`release:check` 整段被跳过。
- 不自动改版本号、不预检 registry 版本占用；幂等跳过不比对 digest。
- git 直装拿不到客户端产物（`lib/client.js` 不入库，没有 `prepare` 钩子）。
- 黑名单是 `files` 白名单的补集，白名单放宽时兜底；`.agents/` 是例外方向——新增目录要改允许面。
- 装机 smoke 只覆盖宿主侧加载（`src/client/**` 依赖宿主基线模块，装出来没有），客户端只验形状；带 `--ignore-scripts`，将来加 `postinstall` 要同步改；`verify:pack` 用磁盘已有的 `lib/client.js`，单跑前先构建。
- `verify:pack` 依赖本机 npm（经 `scripts/spawn-command.mjs`，Windows 上 npm 是 shim），但不需要网络：装的是本地 tarball。
- 发布说明按文档分层落位：流程在 [development 的发布与打包](../../../../docs/development.md#发布与打包)，限制在 [limitations 的发布](../../../../docs/limitations.md#发布)。

## 验证

`tests/pack-manifest.test.js` 与 `tests/client-build.test.js`；双向读数：`files` 收窄成 `["src/host/**"]` → 清单全绿而 `verify:pack` 报 `src/shared` 漏包，`.agents/skills/**` 改成 `.agents/**` 并造 `.agents/prompts/hidden.md` → 撤销允许面时该文件被放行，还原成允许面后全拦。
