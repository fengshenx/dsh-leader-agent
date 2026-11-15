# 开发实例与 worktree 封装

## 背景

旧的 `dev` 脚本把插件 `add` 进用户的 `~/.dsh/profiles/web`，又用默认 `DSH_HOME` 起实例：几个 worktree 先后跑会互相覆盖 profile，开发数据与日常数据混在一起，调试产生的脏数据会留在用户的项目里。

## 决策

- **数据根落在工作树内**：`.dev/home`（gitignore），删掉即重置，worktree 删掉时一起消失。
- **profile 从源 HOME 派生，不重新安装**：照抄源 profile 的依赖与 `dsh.profile.bundles`（复现日常组合，否则「本地跑得起来、装进 profile 就坏」测不出来），只把本插件的依赖换成 `link:<工作树>`、bundles 缺它就补上；`node_modules` 逐条符号链接到源 profile，只有插件本体指工作树——依赖仍由源里那一份承担。
- **端口默认交给系统**（`--port 0`），启动日志打印带 token 的 URL；要固定用 `DEV_PORT`。不按 worktree 名算固定端口：算出来撞车时只能重试或报错，自动分配没有失败路径。
- **数据根不能等于源 HOME**：两边是同一目录时，派生逻辑会把源 `node_modules` 换成自指死链、把源依赖换成工作树链接，跑一次就毁掉日常 profile。`assertSeparateHome` 在任何写操作之前比较真实路径（符号链接或 `..` 绕路也拦），路径不存在时退回字面量比较。
- **profile 名固定 `web`**：`dev` 不在宿主 `PROFILE_TEMPLATES` 里，`dsh plugin --profile dev add` 会建出缺 web-app bundle 的默认模板。校验的不是名字而是源 profile 的 bundles 里有没有 `@deepseek-ai/dsh-web-app`——名字白名单会随宿主版本漂移，而缺 web app bundle 的 profile 跑 `dsh web` 是不监听、不打印 URL、不报错的静默空转。这类误配在写操作之前拒绝。
- **`worktree:spawn`**：目录 `.worktrees/<任务名>`、分支 `feature/<任务名>`、base 取最新 `origin/main`（取不到降级本地 main）、幂等守卫、失败回滚（`worktree remove --force` + 删本次建的分支）；依赖不重装，符号链接主 checkout 的 `node_modules`。
- **`worktree:prune` 默认 dry-run，`--apply` 才删**；守卫顺序是「先排掉会丢东西的理由」：未提交改动 → 当前所在 worktree → 分支没进 main 且 PR 未合并。未提交改动排在当前所在之前，因为两种情况都拒绝、而前者的理由更有用。dry-run 结论会提示删 worktree 连 `.dev/home` 一起清掉。
- **「已合并」两条判据都留**：merge commit 下 `git merge-base --is-ancestor` 成立，squash 合并下不成立但 PR 状态仍是 MERGED，任一成立即可删。PR 状态查不到按拒绝处理，不猜（`JSON.parse` 失败也归到查不到，不让脚本崩在半路）；远端删除失败不算本地失败，只报 `[远端未删]`。
- **`npm run check` 的语法检查扩到 `scripts/` 与 `build/`**：新增的 `.mjs` 不能落在门禁外。
- **AGENTS.md 存在是为了让宿主约束在下一个会话里可见**：「宿主 API 按 `engines.dsh` 下限挑」这条规则是靠一次落在 `agent/created` 上的 `TypeError` 换来的，必须写在新会话一定会读的地方。

## 边界

- 源 profile 是前置条件（存在、装过本插件、bundles 里有 `@deepseek-ai/dsh-web-app`），否则脚本报错退出并给出命令。
- 依赖共享意味着写共享：在 worktree 里 `npm install` 会落到主 checkout，依赖变更回主 checkout 做；并行实例读同一份依赖，只读假设靠「没人往源 profile 装包」维持。
- Windows 未实测（符号链接用 `junction`，文件型条目未覆盖）。
- 客户端改动由常驻 watch 重建，见[客户端改动实时生效](2026-11-02-client-hmr-esbuild-watch.md)。

## 验证

`tests/dev-plan.test.js`、`tests/worktree-common.test.js`、`tests/worktree-prune.integration.test.js`；双向读数：把插件链接改指源 profile → 「node_modules 逐条链到源、只有插件本体指工作树」红，把 `assertSeparateHome` 改成恒假 → 四条边界（同路径、`..` 绕路、符号链接、不存在路径）全红，还原后全绿。
