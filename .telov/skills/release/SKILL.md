---
name: release
description: 本仓发版手册：定版本号、bump、跑 release:check、开 PR、合并后打 tag 触发 CI 发布；含首次发布与失败处理。当用户要求「发版」「发布 npm 包」「bump 版本」「打个 tag」时使用。
whenToUse: 需要把 dsh-leader-kit 的新版本发布到 npm，或排查发版失败时。
---

# 发版

目标：让 `npm publish` 只由 tag 触发，版本号、门禁、tag 三者严格对齐。发布不可回收，任何一步没把握就停下来问用户。

## 前提

- 改动在 worktree 里（`npm run worktree:spawn <任务名>`），主 checkout 保持干净。
- `gh` 已登录、对 `fengshenx/dsh-leader-kit` 有推 tag 权限；`main` 上的 CI 是绿的。
- 仅首次发布需要本机发布：`npm login` 完成、账号已开 2FA。

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

等 CI 绿、PR 合并。合并与 approve 需用户明确指令。

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
npm view dsh-leader-kit@<version> version
```

CI 依次：校验 → `npm ci` → OIDC 发布 → 建 Release。发布步骤幂等：版本已存在就跳过，所以 Release 失败可以直接重跑 workflow。

## 首次发布（包在 npm 上还不存在）

trusted publisher 要求包已存在，所以首个版本必须绕开 CI：

1. 本机确认 `npm run release:check` 通过。
2. `npm login`，然后 `npm publish`（不要带路径参数，否则跳过 `prepublishOnly`）。
3. `npm view dsh-leader-kit version` 确认版本上线。
4. npmjs.com → 包 → Settings → Trusted Publisher → GitHub Actions：
   - Organization or user: `fengshenx`
   - Repository: `dsh-leader-kit`
   - Workflow filename: `publish.yml`
   - Allowed actions: `npm publish`（预发布再勾 `npm dist-tag`）
5. **2 天内**推一个 `v*` tag 完成首次 OIDC 发布，否则配置过期要删掉重配。
6. 包设置 → Publishing access → 「Require two-factor authentication and disallow tokens」。

备选（不想在维护者机器上登录）：建 `Read and write (stage only)` granular token，`npm stage publish` 后由维护者 `npm stage approve`（要 OTP）；它先注册 `0.0.0-stage` 占位包。

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
