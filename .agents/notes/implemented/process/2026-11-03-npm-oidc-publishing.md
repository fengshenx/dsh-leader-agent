# npm 发布迁移到 trusted publishing（OIDC）

## 背景

npm 宣布分步弃用 bypass-2FA 的 granular access token：先禁其账户与包管理操作，再取消直接发布，只留 stage publish。本仓发布链路当时用 `NPM_TOKEN` secret 直发（见 [2026-11-02-npm-publish-pipeline.md](2026-11-02-npm-publish-pipeline.md)），包还没发布过、secret 也没配；按旧方案走，首个版本发出后要立刻换 OIDC，而换配置本身已不能用 bypass token 完成。

## 决策

- **首发在维护者本机交互式发布**：trusted publishing 要求包已存在于 registry 才能登记，首发只能二选一——本机 `npm login` 后 `npm publish`（真实 2FA OTP），或建 stage-only token 走 `npm stage publish` 再人工批准。选前者：一次性操作，不需在仓库或 CI 留任何 token，也不加一道 stage 审批；代价是首个版本没有 provenance。stage 路线写进发版手册作为备选。
- **登记之后必须再发一个未发布的版本**，不能把首发版本本身推成 tag：发布步骤带「版本已存在就跳过」守卫，推首发版本会让 workflow 绿色退出而 OIDC 一次都没跑，配置静默过期，CI 读数与成功发布完全一样。
- **之后全部走 OIDC，仓库不留发布 secret**：删掉 `NODE_AUTH_TOKEN` 与 setup-node 的 `registry-url`——后者往 `.npmrc` 写 `_authToken=${NODE_AUTH_TOKEN}`，token 删掉后展开为空串，npm 把空值读成「认证已配置」而从不发起 OIDC exchange，最终报 ENEEDAUTH。保留 `id-token: write`，并显式装固定版本的 npm（OIDC 发布与 OIDC 下切 dist-tag 各有 CLI 下限，不依赖 setup-node 附带那版）。钉具体版本而非 `@latest`：发布前不该从浮动 tag 拉到没人审阅过的代码，且 npm 版本不可回收，理由与 actions 钉 SHA 相同。
- **包侧配置**：在 npmjs.com 的包 Settings 登记 trusted publisher（仓库、workflow、允许 `npm publish` 与 `npm dist-tag`），首次 OIDC 发布成功后改成「要求 2FA 且禁用 token」。

> **已被 [2026-11-04 工作区耦合清理](2026-11-04-workspace-coupling-removal.md) 取代**：发版手册随后迁到 `docs/release.md`，工具名门禁改为「`.agents/skills` + `MAINTAINER_DOCS`」，打包改为「顶层点目录一律不进包」。下面这一节记的是迁移前的落点与门禁形态。

- **发版手册放本仓之外的工作区 skill 目录（迁移前落点）**：版本号、bump 位置、tag 时机与失败处理写成手册，只服务本仓维护者，所以不进包；但要进打包黑名单（白名单放宽时的第二道防线）与工具名扫描面——手册同样会指挥人去调工具，只扫 `.agents/skills` 时手册里写错工具名没有任何门禁会红。

## 边界

- 顺序不能反：先用本地发布让包在 registry 上存在，再登记 trusted publisher，再 bump 一个未发布版本并推它的 tag；推首发版本会让守卫跳过、OIDC 一次不跑，配置过期只能删掉重配。
- 首发版本没有 provenance，包页面从第二个版本起才有 CI 构建与签名标记。
- tag 不能在分支上打：发布 workflow 校验 tag 提交在 `origin/main` 上，在 worktree 里 bump 要用 `npm version --no-git-tag-version`。
- OIDC 要求仓库公开，且 `package.json` 的 `repository` 必须与 GitHub 仓库一致。
- 本地发布同样跑门禁：`prepublishOnly` 指向发版检查；但 `npm publish <tarball>` 不跑生命周期脚本，会整段跳过。

## 验证

首发版本由本机发布（`_npmUser` 为维护者、无 attestations），推它的 tag 的 CI run 只建 Release、跳过发布；之后一个版本的 tag run 真正走 OIDC（`_npmUser` 为 GitHub Actions、带 trustedPublisher、有 SLSA provenance），`latest` 随之指向新版本。
