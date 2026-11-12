# 发版

维护者专用：不随 npm 包发布，也不进入会话提示词；入口在 `AGENTS.md` 的按任务查阅表。

目标：让 `npm publish` 只由 tag 触发，版本号、门禁、tag 三者严格对齐。发布不可回收，任何一步没把握就停下来问用户。

## 前提

- 改动在 worktree 里（`npm run worktree:spawn <任务名>`），主 checkout 保持干净。
- `gh` 已登录、对 `fengshenx/dsh-leader-agent` 有推 tag 权限；`main` 上的 CI 是绿的。
- 日常发版不需要本机 `npm login` 或 OTP：认证由 CI 的 OIDC 完成。只有首次发布（包尚不存在）需要本机发布，要求账号已开 2FA。

## 一、定版本号

`package.json` 的 `version` 是唯一来源，tag 必须是 `v<version>`。

| 变化 | 用法 | 例子 |
|---|---|---|
| 修复 | patch | 0.1.0 → 0.1.1 |
| 0.x 期间的新能力或破坏性变化 | minor | 0.1.0 → 0.2.0 |
| 预发布 | 显式写版本 | 0.2.0-rc.1 |

预发布版本带 `-`：CI 用 `next` dist-tag，GitHub Release 标 prerelease，不会顶掉 `latest`。

## 二、bump

```bash
npm version patch|minor|major|x.y.z --no-git-tag-version
git diff -- package.json package-lock.json
```

diff 只能出现在这两个文件的版本行。默认的 `npm version` 会提交并打 tag，而那个 tag 指向 worktree 分支的提交，CI 会因「不在 origin/main 上」拒绝。

## 三、门禁

```bash
npm run release:check
```

它就是 `prepublishOnly`，也是 CI 的发布门禁：`check` + `build:client` + `verify:pack`。顺序不能倒，`verify:pack` 依赖已构建的 `lib/client.js`。红了先修，不要绕过。

## 四、提交与 PR

```bash
git add -A
git commit -m "chore(release): <version>"
git push -u origin feature/<任务名>
gh pr create --fill
```

等 CI 绿后，在主 checkout 合并（在 worktree 内执行会让下一节的 `git checkout main` 因 `main` 已被 worktree 占用而失败）：

```bash
gh pr merge <n> --merge
```

合并与 approve 需用户明确指令。合并方式见 `AGENTS.md` 的「提交与 PR → 合并方式」；`--squash` 会被 GitHub 拒绝。分支删除交给收尾的 `worktree:prune --apply --delete-remote`，不要给 merge 加 `--delete-branch`。

## 五、合并后打 tag

```bash
git checkout main && git pull
git tag -a v<version> -m "v<version>"
git push origin v<version>
```

tag 必须指向 `main` 上的提交。`publish.yml` 会校验 tag 与 `package.json` 版本一致、且提交在 `origin/main` 上。

## 六、观察

```bash
gh run watch
gh release view v<version>
npm view dsh-leader-agent@<version> version
npm view dsh-leader-agent@<version> dist.attestations   # 非空 = OIDC 发布并生成 provenance
```

CI 依次：校验 → `npm ci` → OIDC 发布 → 建 Release。发布步骤幂等：版本已存在就跳过，所以 Release 失败可以直接重跑 workflow。

## 首次发布（包在 npm 上还不存在）

trusted publisher 要求包已存在，所以首个版本必须绕开 CI；但**登记完必须再发一个未发布过的版本**，否则 OIDC 一次都不会跑：

1. 本机确认 `npm run release:check` 通过。
2. `npm login`，然后 `npm publish`（不要带路径参数，否则跳过 `prepublishOnly`）。这一步发出 `package.json` 里的当前版本（如 0.1.0），没有 provenance。
3. `npm view dsh-leader-agent version` 确认版本上线。
4. npmjs.com → 包 → Settings → Trusted Publisher → GitHub Actions：
   - Organization or user: `fengshenx`
   - Repository: `dsh-leader-agent`
   - Workflow filename: `publish.yml`
   - Allowed actions: `npm publish`（预发布再勾 `npm dist-tag`）
5. **bump 到一个未发布的版本**（如 0.1.1），按第一到五节走完整流程：PR 合并后从 `main` 打 `v0.1.1` tag。这一步才是首次 OIDC 发布。
6. 看 `gh run view` 的发布步骤：必须是 `npm notice Publishing ...`，不能是「已发布，跳过 npm publish」。
7. 包设置 → Publishing access → 选带 (recommended) 的「Require two-factor authentication and disallow bypass 2fa tokens」；界面若同时提供更严格的「disallow tokens」，选它。该设置不影响 OIDC 发布。

**为什么不能直接推 `v0.1.0`**：第 2 步已经把它发到 registry，`publish.yml` 的「版本已存在就跳过」守卫会打印「已发布，跳过 npm publish」并 exit 0——workflow 整体绿色，但 OIDC 一次都没跑，trusted publisher 配置 2 天后静默过期，而 CI 读数看不出区别。首发版本天然「已存在」，所以首发之后必须有一个新版本真走一遍 OIDC。

### 包改名后：新包名等于首发

trusted publisher 绑的是「包名 + 仓库 + workflow」，**仓库改名不会把它迁移过去**。包名从 `dsh-leader-kit` 改成 `dsh-leader-agent` 后，新包在 registry 上不存在 → 整套首次发布流程重走一遍（本机交互式 `npm publish` 首发 → 登记 trusted publisher → bump 新版本打 tag 验证 OIDC）。旧包由维护者手工 `npm deprecate dsh-leader-kit "renamed to dsh-leader-agent"`：deprecate 会影响所有还在用旧包的人，时机由人决定，**不要写进 CI**。

备选（不想在维护者机器上登录）：建 `Read and write (stage only)` granular token，`npm stage publish` 后由维护者 `npm stage approve`（要 OTP）；它先注册 `0.0.0-stage` 占位包。同样要在登记 trusted publisher 后发一个新版本验证 OIDC。

## 失败处理

- **`tag ... 与 package.json 的 ... 不一致`**：版本没提交或 tag 打错。删本地 tag（`git tag -d`）并从 `main` 重打。
- **`tag 指向的提交不在 origin/main 上`**：tag 打在了 worktree 分支上。删除远端 tag（`git push origin :refs/tags/<tag>`）后从 `main` 重打。
- **版本已存在**：npm 不允许重发同一版本。确认内容后 `npm deprecate`，再发下一个版本。
- **`ENEEDAUTH` / 403**：检查 trusted publisher 的仓库、workflow 文件名、Allowed actions 是否与 `publish.yml` 一致；配置是否已过期。
- **Release 建失败**：直接重跑 workflow，发布步骤会跳过已存在版本。

## 禁止

- 在主 checkout 改版本或跑发布。
- 从分支推 tag、对 `main` force push、删除已发布版本所在的 tag。
- `npm publish <tarball>`：不跑 `prepublishOnly`，门禁整段跳过。
- 未经用户明确指令合并 PR、改包设置或发版。
