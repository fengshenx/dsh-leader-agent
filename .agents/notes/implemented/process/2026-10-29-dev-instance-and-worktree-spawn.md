# 开发实例与 worktree 封装

**范围**：`scripts/dev.mjs`、`scripts/dev-plan.mjs`、`scripts/worktree-spawn.mjs`、`scripts/worktree-prune.mjs`、`scripts/worktree-common.mjs`、`package.json`、`.gitignore`、`README.md`、`AGENTS.md`

## 背景

原来的 `dev` 脚本是 `npm run build:client && dsh plugin --profile web add "$PWD" && dsh web`。它做对了一件事——让插件指向当前目录——但有两处会在并行开发时出事：

- `plugin add` 改的是 `~/.dsh/profiles/web`，也就是**用户日常的那个 profile**。几个 worktree 先后跑 `npm run dev`，后跑的把先前那个覆盖掉；worktree 删了还留下悬空链接。
- `dsh web` 用默认 `DSH_HOME`，开发实例与日常实例共用会话、项目、卡片。协调者插件在这些数据上写（`projects.json`、`cards.json`、`workers.json`），混用会互相干扰，也会把调试产生的脏数据留在用户的项目里。

## 决策

**数据根落在工作树内**：`.dev/home`（gitignore 忽略）。会话、项目、卡片都在里面，删掉即重置，worktree 删掉时一起消失。

**profile 从源 HOME 派生，不重新安装**。`package.json` 照抄源 profile 的依赖与 `dsh.profile.bundles`（复现日常组合，否则「本地跑得起来、装进 profile 就坏」这类问题测不出来），只把 `dsh-leader-kit` 的依赖换成 `link:<工作树>`，`bundles` 缺它就补上（源里没装过本插件时也能起）。

**`node_modules` 逐条符号链接到源 profile，只有插件本体指工作树**。依赖仍由源里那一份承担：源里升级 dsh 或增删插件，开发实例自动跟随。`dsh` 启动不校验 `package.json` 的 `link:` 路径与磁盘链接是否一致，所以这样造出来的 profile 能正常加载——实测过（见验证）。

**端口默认交给系统分配**（`--port 0`），启动日志打印带 token 的 URL；要固定就 `DEV_PORT`。不按 worktree 名算固定端口：算出来撞车时只能重试或报错，而自动分配没有失败路径。

**`worktree-spawn` 对齐仓库既有约定**：目录 `.worktrees/<任务名>`、分支 `feature/<任务名>`、base 取最新 `origin/main`（取不到降级本地 main）、幂等守卫（目录或分支已存在就拒绝）、失败回滚（`worktree remove --force` + 删本次建的分支）。依赖不重装，符号链接主 checkout 的 `node_modules`——本仓依赖只有 esbuild 与 minidenticons，代价是改 `package.json` 要在主 checkout 安装。

**数据根不能等于源 HOME，脚本拒绝**。`DSH_HOME=~/.dsh` 是个很自然的「想复用日常数据」写法，但那时 `profileDir` 与 `sourceProfileDir` 是同一个目录：派生逻辑会把源 `package.json` 的插件依赖换成工作树链接，再把 `node_modules` 里每个真实依赖目录删掉、换成指向自己的死链——跑一次就把日常 dsh 装好的 profile 毁了，只能重装。守卫 `assertSeparateHome` 在任何写操作之前比较两边的真实路径（符号链接或 `..` 绕一圈指到同一处也拦），路径不存在时退回字面量比较。

**profile 名固定 `web`，不引入 `dev`**。插件 manifest 声明 `platform: web`；更要紧的是 `dev` 不在宿主 `PROFILE_TEMPLATES` 里，`dsh plugin --profile dev add` 会按只含 `@deepseek-ai/dsh-base` 的默认模板建 profile——没有 web-app bundle，插件客户端半边不加载。源 profile 名可用 `DSH_PROFILE` 覆盖（比如日常用 `headless` 的人），但校验的不是名字而是**源 profile 的 bundles 里有没有 `@deepseek-ai/dsh-web-app`**：名字白名单要抄宿主的模板表、会随版本漂移，而缺 web app bundle 的 profile 跑 `dsh web` 实测是不监听端口、不打印 URL、也不报错——静默空转，看起来像成功。这类误配在写操作之前拒绝。

**`npm run check` 的语法检查扩到 `scripts/` 与 `build/`**。原来只查 `index.js` 与 `src/**/*.js`，新增的 `.mjs` 脚本就落在门禁外面。

**AGENTS.md 存在，是为了让这些宿主约束在下一个会话里可见**。「宿主 API 按 `engines.dsh` 下限挑」这条规则是靠一次 `TypeError`（`definitions()` 在 0.2.1-rc.2 上不存在，落在 `agent/created` 上）换来的；它必须写在新会话一定会读的地方，而不是埋在 `/tmp` 或某次对话里。结构参照 Telov 的 AGENTS.md：核心铁律 → 按任务查阅 → 目录 → 常用命令 → 测试 → 风格 → 宿主契约 → 提交与 PR，每条自包含或一行断言加链接。

## 验证

- `npm run check`：430 例全绿（`tests/dev-plan.test.js` 16 例、`tests/worktree-common.test.js` 12 例）。`npm run build:client` 通过。
- 双向验证：把 `planNodeModules` 的插件链接改成指向源 profile → 「node_modules 逐条链到源，只有插件本体指工作树」红；把 `assertSeparateHome` 的条件改成恒假 → 四条边界（同路径、`..` 绕路、符号链接、不存在路径）全红；还原后全绿。
- 真机（`dsh 0.2.1-rc.2`，隔离实例）：`npm run dev` 一条命令起实例，页面项目区与输入框都在；数据根只有 `profiles/ sessions/ storages/`；`profiles/web/node_modules/dsh-leader-kit` 指向工作树，其余条目指向源 profile。
- 重复运行幂等：第二次 `npm run dev` 复用现有 profile，`DEV_PORT=5877` 生效。
- **代码即生效**：临时把 `project-section.js` 的标题改成「项目·工作树」，`npm run dev` 后页面读到新文案，确认加载的是工作树当前代码而非某个装好的旧版本；改回后 `git diff` 无残留。
- `worktree:prune` dry-run 在当前仓库实测：已合并的判为可删（走 PR 状态），当前所在的 dev-script 判为拒绝。
- **`DSH_HOME === DSH_HOME_SOURCE` 的真机取证**：隔离 HOME 里放一个真实依赖目录跑 `dev.mjs`，加守卫前该目录被删成自指死链、源 `package.json` 的插件依赖被换成工作树链接；加守卫后退出码 1，目录与 `package.json` 原样。
- 假 `gh`（stdout 输出非 JSON、退出码 0）跑 prune：加兜底前 `SyntaxError` 崩栈，加兜底后判为「查不到 PR 状态」；真 `gh` 对同一分支判为「分支没有 PR 记录」——两条路径分得开。
- `--remote nosuchremote` 配 `--apply --delete-remote`：本地删掉并打印 `[远端未删]`（说明远端分支还在），`--remote` 确实被用于 push。
- `DEV_PORT=''` 时 `--port` 收到的是 `0`；`prune ../../etc` 报任务名不合法、退出码 1。
- **缺 web app bundle 的 profile 跑 `dsh web` 是静默空转**：造一个只含 `@deepseek-ai/dsh-base` 的隔离 HOME（node_modules 全链到真实 profile），`dsh web --port 5899 --no-open` 等 20 秒后日志只有一句代理警告，`lsof -ti :5899` 无监听。加 `assertWebBundle` 后同一个 HOME 跑 `npm run dev` 退出码 1 并说明原因；真实 `~/.dsh` 照旧一路走到起实例。

## 边界

- **源 profile 是前置条件**：`~/.dsh/profiles/web` 必须已存在、装过一次本插件、且 bundles 里有 `@deepseek-ai/dsh-web-app`（或用 `DSH_HOME_SOURCE` / `DSH_PROFILE` 指向别的已备好的 profile），否则脚本报错退出并给出命令。
- **依赖共享意味着写共享**：在 worktree 里跑 `npm install` 会落到主 checkout。本仓依赖极少，约定是依赖变更回主 checkout 做。
- **并行实例共享源 `node_modules` 的只读假设**：多个 worktree 的 dev 实例同时跑时，读的是同一份依赖；只要没人往源 profile 装包就安全。
- **Windows 未实测**：符号链接用 `junction`（对目录有效），文件型条目未覆盖到。
- **客户端改动要重跑 `npm run dev` 或 `npm run build:client`**：没有 watch。

## 收尾：`worktree:prune`

默认 dry-run 打印每个 worktree 的结论，`--apply` 才删（`git worktree remove --force` + `git branch -D`，远端分支要 `--delete-remote`，远端名由 `--remote` 指定、默认 origin）。守卫顺序是「先排掉会丢东西的理由」：未提交改动 → 当前所在的 worktree → 分支没进 main 且 PR 未合并。未提交改动排在「当前所在」之前，是因为两种情况都拒绝，而前者的理由更有用——cd 出去也解决不了。

dry-run 的结论下面会提示删 worktree 会连带清掉 `.dev/home`：用户常在删「已合并」项时没意识到开发实例的会话、项目、卡片数据也一起没了。

远端删除失败不当作本地删除失败：本地已经删干净，只报 `[远端未删]` 并说明远端分支还在，`[已删]` 那行不写「含远端」。

**两条「已合并」判据都留着**，因为合并方式不设限：`git merge-base --is-ancestor <branch> main` 在 merge commit 下成立；squash 合并下不成立（提交不在 main 祖先链上），但 PR 状态仍是 MERGED。任一成立即可删。PR 状态查不到（gh 不可用/未登录/输出不是 JSON）按拒绝处理，不猜——`JSON.parse` 出错也归到「查不到」，让用户去查登录态，而不是让脚本崩在半路。

删目录时 `.dev/home` 的数据与 `node_modules` 符号链接一起清掉——链接指向主 checkout，删的只是链接本身，不会动主 checkout 的依赖。
