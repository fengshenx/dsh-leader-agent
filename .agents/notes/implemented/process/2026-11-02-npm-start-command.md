# Agent Note: npm start 起日常实例

Status: implemented

## Problem

`npm run dev` 起隔离实例（数据根在 `.dev/home`、插件链到当前工作树），但不回答「本仓库装进日常 `~/.dsh` 后是什么样」。直接 `dsh web` 的失败方式是「命令成功了但结果不对」：没构建客户端产物就没看板、日常 profile 没装本插件就起一个与仓库无关的实例、`dsh` 不可用时只抛出一句 `spawnSync` 原始报错。

## Decision

- **start 是日常实例，dev 是隔离实例**：start 直接用 `~/.dsh`（`DSH_HOME` 可换）与 `profiles/web`，不派生 profile、不新建数据根；插件版本由该 profile 的链接决定。
- **起之前按顺序检查，每项都给可复制的修复命令**：`dsh` 可执行（ENOENT 时说明没装或不在 PATH，并提示 nvm 换版本会重置 PATH、`DSH_DSH` 可指定路径）、profile 的 `package.json` 存在、bundles 含 `@deepseek-ai/dsh-web-app`、含本插件、`node_modules` 里有本插件链接。缺 web-app 时 `dsh web` 会起一个不监听、不报错的空进程，这项最需要拦。
- **修复建议由调用方传入**：web-app 守卫由 dev 与 start 共用，但 dev 的 profile 名可换、start 固定 `web`，所以守卫收 `hint`；漏传即抛错，不拼出 `undefined`。
- **只在链接指向当前目录时构建**：产物是当前目录的 `lib/client.js`；链接指向别处（worktree 里常见）就跳过并 warn 指向 `npm run dev`，避免产出没人加载的产物、还让人误以为改动已验证。
- **不校验 `engines.dsh` 范围**：npm 安装与宿主启动各自会拦，start 不重复实现 semver 比较；版本只进启动横幅。
- **未预期异常只打 `错误: <message>` 与栈首帧**，整段 stack 对用户无用。profile 的 `package.json` 损坏时不建议重装（`dsh plugin` 在同一目录跑 pnpm，读同一份文件），建议先手工修好或删掉 profile 让 dsh 按 `web` 模板重建，并保留原始 JSON 解析报错；`dsh web` 非零退出时注明上面的输出是它自己的（`stdio` 继承）。
- **额外参数原样转给 `dsh web`**：`npm start -- --no-open` 透传，不带 `--` 会被 npm 当成自己的配置吃掉。

## Alternatives considered

- **让用户直接 `dsh web`**：没构建产物就没看板、日常 profile 没装插件就起一个无关实例；start 先按顺序检查并给修复命令。
- **复用 dev 的派生 profile**：start 要回答「装进日常 `~/.dsh` 后是什么样」；直接用日常 profile，不派生。
- **在 start 里再校验 `engines.dsh`**：npm 安装与宿主启动各自会拦；不重复实现 semver。
- **自动修复损坏的 profile**：`dsh plugin` 在同一目录跑 pnpm，可能再写坏；给手工修复建议并保留原始解析错误。
- **开放 `DSH_PROFILE`**：脚本查一个 profile、实例读另一个；固定 `web`。

## Consequences

- start 不碰数据根：只读 profile 的 `package.json` 与链接，不复制、不重建 profile。
- 只在仓库里跑：脚本按自身位置定位仓库根，从 npm 包目录跑没有 `build/` 可用。
- profile 名固定 `web`，不开放 `DSH_PROFILE`：否则脚本查一个 profile、实例读另一个。
- worktree 里的 start 起的是主 checkout 的代码，这是链接决定的正常结果；脚本用 warn 说清，不替换链接（改日常 profile 链接归 `dsh plugin`）。
- 不做交互式修复：任一检查失败即以 1 退出并打印命令，不替用户执行 `dsh plugin add`。

收益：`npm start` 起的是真实日常实例，缺产物 / 缺插件 / profile 损坏都在启动前说清并给出修复命令。

## Testing

`tests/dev-plan.test.js` 钉住日常 profile 的插件/bundle 守卫、两套 `hint` 文案与损坏 profile 的修复建议；逐条撤掉判据，对应用例变红。
