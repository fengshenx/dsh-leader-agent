# npm 发布迁移到 trusted publishing（OIDC）

## 背景

npm 2026-07-08 宣布弃用 bypass-2FA 的 granular access token，分两步落地：2026-07-31 起这类 token 不能再做账户与包管理操作（建 token、改 maintainer、改 trusted publisher 配置）；2027-01（目标）起连直接发布也取消，只剩读私有包与 stage publish。2026-09-18 上线 stage-only token（`npm stage publish` + 维护者 2FA 批准），2026-10-02 起 staged publish 可以创建全新包（先注册 `0.0.0-stage` 占位）。

本仓此前的发布链路（见 [2026-11-02-npm-publish-pipeline.md](2026-11-02-npm-publish-pipeline.md)）用 `NPM_TOKEN` secret 直发。包还没发布过（`npm view` 返回 E404），secret 也没配。按旧方案走，首个版本发出后要立刻换 OIDC，而换配置那一步（在 npmjs.com 改 trusted publisher）本身已不能用 bypass token 完成，只能人工补。

## 决策

### 首发在维护者本机交互式发布

trusted publishing 要求包在 registry 上已存在才能登记（npm/cli#8544 仍开放）。首发因此只能二选一：本机 `npm login` 后 `npm publish`（真实 2FA OTP），或建 stage-only token 走 `npm stage publish` 再人工 `npm stage approve`。

选前者：一次性操作，不需要在仓库或 CI 里留任何 token，也不给自己加一道 stage 审批；代价是首个版本没有 provenance（npm 只在 OIDC/CI 下生成），从第二个版本起由 CI 补上。stage 路线写进发版 skill 作为备选，给不想在维护者机器上 `npm login` 的场合。

**登记 trusted publisher 之后必须再发一个未发布的版本**（如 0.1.1），不能把首发版本本身推成 tag。`publish.yml` 的发布步骤带「版本已存在就跳过」守卫，推 `v0.1.0` 会在打印「已发布，跳过 npm publish」后 exit 0：workflow 绿色，OIDC 一次都没跑，trusted publisher 配置 2 天后静默过期，而 CI 读数与成功发布完全一样。首发版本天然已存在，所以首发之后必须有一个新版本真走一遍 OIDC。

### 之后全部走 OIDC，仓库不留发布 secret

`publish.yml` 删掉 `NODE_AUTH_TOKEN` 与 setup-node 的 `registry-url`：后者会往 `.npmrc` 写 `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`，token 删掉后展开为空串，npm 把这个空值读成「认证已配置」而从不发起 OIDC exchange，最终报 ENEEDAUTH（actions/setup-node#1551）。保留 `id-token: write`，并显式装 `npm@11.21.0`：OIDC 发布要求 CLI ≥ 11.5.1，OIDC 下切 dist-tag 要求 ≥ 11.21 / 12.2，不依赖 setup-node 附带的那一版；钉具体版本而不是 `@latest`，理由与 actions 钉 SHA 相同——发布前不该从浮动 tag 拉到没人审阅过的代码，且 npm 版本不可回收。

包侧配置：npmjs.com → 包 → Settings → Trusted Publisher 登记 `fengshenx` / `dsh-leader-kit` / `publish.yml`，Allowed actions 勾 `npm publish`（预发布用 `--tag next`，再勾 `Allow npm dist-tag`）。首次 OIDC 发布成功后，把 Publishing access 改成「Require two-factor authentication and disallow tokens」。

### 发版操作固化为工作区 skill

版本号怎么定、bump 在哪做、tag 何时打、失败怎么处理，写成 [.telov/skills/release](../../.telov/skills/release/SKILL.md)。它放在 `.telov/skills/` 而不是 `.agents/skills/`：后者是随包发布的协议层 skill（`tests/skills.test.js` 固定名单），发版手册只服务本仓维护者。

手册不进包，但要进两道门禁。`pack-manifest.mjs` 的 `FORBIDDEN_PATTERNS` 显式拦 `.telov/`（今天靠 `files` 白名单兜住，那是白名单被放宽时的第二道防线）；`doc-tool-names.mjs` 的扫描面从单目录常量改成 `PROMPT_SKILLS_DIRS = ['.agents/skills', '.telov/skills']`——手册同样进会话提示词、同样会让模型去调工具，**只扫 `.agents/skills` 时新 skill 里写错工具名没有任何门禁会红**。

## 边界

- **顺序不能反**：先用本地发布让包在 registry 上存在，再登记 trusted publisher；登记后（2 天窗口内）要 bump 一个未发布版本并推它的 tag，不能推首发版本，否则守卫跳过、OIDC 一次不跑，配置过期只能删掉重配。
- **首发版本没有 provenance**：0.1.0 由本机发布，包页面从下一个版本起才有「Built and signed on GitHub Actions」。
- **tag 不能在分支上打**：`publish.yml` 仍校验 tag 提交在 `origin/main` 上；在 worktree 里 bump 要用 `npm version --no-git-tag-version`，否则会留下一个指向分支提交的本地 tag。
- **OIDC 仍要求仓库公开**：provenance 与 trusted publishing 的可用性都依赖这个前提，`package.json` 的 `repository` 也必须与 GitHub 仓库一致。
- **本地发布同样跑门禁**：`prepublishOnly` = `release:check`；`npm publish <tarball>` 不跑生命周期脚本，会整段跳过。
- **`AGENTS.md` 天花板 4200 → 4280，`docs/development.md` 2500 → 2550**：详细步骤搬进 skill，development 只留链路契约（补首发顺序后 2379，2500 只剩 4.84% 余量、低于本仓 5% 规矩，且门禁只判超限不判贴线，所以按 6.7% 重算到 2550）；AGENTS.md 新增两处发版入口（改后 3846），按 10% 余量重算到 4280。

## 验证

- `npm run check` 全绿：65 篇笔记格式合规、**12 篇**文档工具名全部存在（新增的一篇是 `.telov/skills/release/SKILL.md`）、13 篇 standing docs 都在天花板内（AGENTS.md 3846/4280、`docs/development.md` 2379/2550）、语法 96 个文件、977 用例通过（16 skip）、覆盖率门禁通过。
- 两处新门禁都做了双向验证：`PROMPT_SKILLS_DIRS` 回退成只含 `.agents/skills`，新增的扫描面用例变红；撤掉 `/^\.telov\//`，打包黑名单用例变红；各自还原后全绿（两个文件 22 例）。
- `npm run verify:pack`：86 个文件（未压缩 994 kB），必需项齐全、无开发残留、装机 smoke 通过。加 `.telov/` 不改变包内容——它本来就不在 `files` 白名单里。
- **OIDC 发布路径未在本仓验证**：需要包已在 npm 上存在并登记 trusted publisher，只能由首次真实 tag 发布证明。本地能验的是 workflow 语法与 tag 前置校验；首次发布后把 CI 读数回填到本文件。
