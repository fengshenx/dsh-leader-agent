# Agent Note: dev 的稳定端口与 web profile

Status: implemented

## Problem

`npm run dev` 有两个只在开发链路出现的问题：

- 它按 `DSH_PROFILE` 派生源 profile，但 `dsh web` 固定用 web profile，不读这个变量。在 DSH 的 agent shell 里 `DSH_PROFILE=desktop`，派生出来的是 desktop profile，web 侧拿到的却是空 profile——插件静默不挂，页面看起来正常。
- 默认 `--port 0` 每次换一个 authority。宿主按 authority 发 `dsh-auth-<hash>` cookie，浏览器对 `127.0.0.1` 的 cookie 不分端口，开发实例跑多了，Cookie 请求头会超过 Node 默认 16KB 上限，请求在进应用之前就返回 431。实测 45 份约 13.5KB 时是 401，80 份约 23.8KB 时是 431。

## Decision

- `dev.mjs` 派生 profile 与子进程环境都钉死 `web`，和 `dsh web` 一致，不再读 `DSH_PROFILE`。
- 默认端口改成按工作树路径哈希的稳定值（30000–39999）：同一工作树反复启动复用同一 authority，只保留一份 cookie；不同工作树路径不同，仍可并行。`DEV_PORT` 仍可覆盖，`DEV_PORT=0` 回到系统随机。
- 文档写明 431 的成因与清理方式：已有 cookie 要清一次，补丁只防止继续增长。

## Alternatives considered

- **保留随机端口，只在文档写清理**：每次 dev 都新增一份 cookie，问题会周期性复发。
- **全局固定一个端口**：多个 worktree 并行时互相撞端口；按工作树哈希保留并行的同时稳定 authority。
- **改用 `localhost` 打开**：只是换一个 cookie 桶，跑多了同样会满。
- **改宿主的 cookie 策略**：宿主按 authority 隔离 cookie 是有意的安全边界，本仓不修改宿主。

## Consequences

- 从同一工作树并行起两个 dev 实例会撞默认端口，需要显式 `DEV_PORT`；工作树哈希也可能与别的本地服务撞端口，同样用 `DEV_PORT` 覆盖。
- 已经积累的 `dsh-auth-*` cookie 不会自动消失，升级后第一次仍要在浏览器里清掉 `127.0.0.1` 的这组 cookie；清掉后各本地 DSH 实例需要重新打开带 token 的 URL。
- 收益：dev 实例和 e2e 一样真正加载当前工作树的插件；反复开发不再累积 auth cookie，431 不再复发。

## Testing

- `tests/dev-plan.test.js` 钉住 `devPortFor` 的稳定性、范围和路径区分。
- 手动：dev 启动日志落到 `profiles/web`，用 Playwright 打开 dev URL 能看到左栏项目区块；同一服务下 80 份模拟 cookie 复现 431，45 份返回 401。
