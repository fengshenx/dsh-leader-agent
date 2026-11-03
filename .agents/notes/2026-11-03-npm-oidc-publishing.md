# npm 发布迁移到 trusted publishing（OIDC）

## 背景

npm 2026-07-08 宣布弃用 bypass-2FA 的 granular access token，分两步落地：2026-07-31 起这类 token 不能再做账户与包管理操作（建 token、改 maintainer、改 trusted publisher 配置）；2027-01（目标）起连直接发布也取消，只剩读私有包与 stage publish。2026-09-18 上线 stage-only token（`npm stage publish` + 维护者 2FA 批准），2026-10-02 起 staged publish 可以创建全新包（先注册 `0.0.0-stage` 占位）。

本仓此前的发布链路（见 [2026-11-02-npm-publish-pipeline.md](2026-11-02-npm-publish-pipeline.md)）用 `NPM_TOKEN` secret 直发。包还没发布过（`npm view` 返回 E404），secret 也没配。按旧方案走，首个版本发出后要立刻换 OIDC，而换配置那一步（在 npmjs.com 改 trusted publisher）本身已不能用 bypass token 完成，只能人工补。

## 决策

### 首发在维护者本机交互式发布

trusted publishing 要求包在 registry 上已存在才能登记（npm/cli#8544 仍开放）。首发因此只能二选一：本机 `npm login` 后 `npm publish`（真实 2FA OTP），或建 stage-only token 走 `npm stage publish` 再人工 `npm stage approve`。

选前者：一次性操作，不需要在仓库或 CI 里留任何 token，也不给自己加一道 stage 审批；代价是首个版本没有 provenance（npm 只在 OIDC/CI 下生成），从第二个版本起由 CI 补上。stage 路线写进发版 skill 作为备选，给不想在维护者机器上 `npm login` 的场合。

### 之后全部走 OIDC，仓库不留发布 secret

`publish.yml` 删掉 `NODE_AUTH_TOKEN` 与 setup-node 的 `registry-url`（它会往 `.npmrc` 写 `_authToken=${NODE_AUTH_TOKEN}`，空值会先于 OIDC 身份被读到）。保留 `id-token: write`，并显式 `npm install -g npm@latest`：OIDC 发布要求 CLI ≥ 11.5.1，OIDC 下切 dist-tag 要求 ≥ 11.21 / 12.2，不依赖 setup-node 附带的那一版。

包侧配置：npmjs.com → 包 → Settings → Trusted Publisher 登记 `fengshenx` / `dsh-leader-kit` / `publish.yml`，Allowed actions 勾 `npm publish`（预发布用 `--tag next`，再勾 `Allow npm dist-tag`）。首次 OIDC 发布成功后，把 Publishing access 改成「Require two-factor authentication and disallow tokens」。

### 发版操作固化为工作区 skill

版本号怎么定、bump 在哪做、tag 何时打、失败怎么处理，写成 [.telov/skills/release](../../.telov/skills/release/SKILL.md)。它放在 `.telov/skills/` 而不是 `.agents/skills/`：后者是随包发布的协议层 skill（`tests/skills.test.js` 固定名单），发版手册只服务本仓维护者。

## 边界

- **顺序不能反**：先用本地发布让包在 registry 上存在，再登记 trusted publisher；登记后 2 天内要完成首次 OIDC 发布，否则配置过期，只能删掉重配。
- **首发版本没有 provenance**：0.1.0 由本机发布，包页面从下一个版本起才有「Built and signed on GitHub Actions」。
- **tag 不能在分支上打**：`publish.yml` 仍校验 tag 提交在 `origin/main` 上；在 worktree 里 bump 要用 `npm version --no-git-tag-version`，否则会留下一个指向分支提交的本地 tag。
- **OIDC 仍要求仓库公开**：provenance 与 trusted publishing 的可用性都依赖这个前提，`package.json` 的 `repository` 也必须与 GitHub 仓库一致。
- **本地发布同样跑门禁**：`prepublishOnly` = `release:check`；`npm publish <tarball>` 不跑生命周期脚本，会整段跳过。
- **`AGENTS.md` 天花板 4200 → 4280，`docs/development.md` 保持 2500**：详细步骤搬进 skill，development 只留链路契约（改后 2372，余量 5.1%）；AGENTS.md 新增两处发版入口（改后 3846），按 10% 余量重算到 4280。

## 验证

- `npm run check` 全绿（Agent Note 格式、文档工具名、文档预算、语法、覆盖率），`docs/development.md` 与 `AGENTS.md` 都在各自天花板内。
- `verify-pack` 不涉及 workflow 与 skill 内容之外的文件，包内容不受这次改动影响。
- **OIDC 发布路径未在本仓验证**：需要包已在 npm 上存在并登记 trusted publisher，只能由首次真实 tag 发布证明。本地能验的是 workflow 语法与 tag 前置校验；首次发布后把 CI 读数回填到本文件。
