# Agent Note: e2e 清理阶段的有界等待

Status: implemented

## Problem

反馈的「e2e 还是这么慢」实测是两件事：正常场景并行 8–12 秒，热路径没有可压缩的余量（黑盒 spawn 真实宿主这条设计的成本）；偶发卡死时测试进程 0% CPU、`dsh web` 仍在监听、没有任何报错——是清理阶段在等一个不会到来的事件。

## Decision

- **三处无限等待都加上限**：`spawnDshWeb().stop()` 的 `exit` 只发一次，监听器挂上时事件可能已经发过，改成两次 `waitForExit(5s)`（TERM → KILL），第二次仍未退出则抛错；`mock.stop()` 先发起 `server.close()` 再 `closeAllConnections()`，SSE 是 keep-alive，等连接自然结束等于无限等；`closeBrowser()` 限 10 秒，超时告警后继续清理，但**拒绝照样往上抛**进「e2e 清理失败」——浏览器非正常关闭正是最需要看见的一类。
- **清理失败只有一条出口**：`launchE2E().stop()` 与场景自己的 `t.after` 都走 `runCleanup()`，逐条跑、互不短路，失败合并成一条「e2e 清理失败」；`instance.stop()` 的 `stopped` 改为杀成功后才置位，不把孤儿留到重启。
- **迟到的断言改成轮询**：`firstSession()` 在「输入框可编辑」之后立刻断言会话已落盘，建会话是宿主的异步动作，两者没有先后保证；改成 `waitFor()` 轮询 5 秒。
- **测试级上限 90 秒，且不加 `--test-force-exit`**：测试级 timeout 走 `scenarioTimeout()` 并随 `E2E_BUDGET_SCALE` 放大，让内部等待先撞上限、保住带读数的失败；`--test-force-exit` 会把漏清理从「挂住变红」变成「绿着通过 + 孤儿进程」，有界清理已覆盖已知三处，漏清理应该继续暴露。
- **预期取消的放行按宿主模板的形状匹配**：宿主视图在 ready 之前被销毁必然打出 `Sidebar Session opening failed: … Session reference "…" is released`，它是取消不是故障；放行正则锚定这个模板，尾部不锚 `$`（真实 text 首行后跟着栈）。旧写法 `.*is released` 会连聚合错误、`buffer is released`、`retry after timeout, session is released` 一起放行。

## Alternatives considered

- **清理阶段继续无限等 `exit` / `server.close` / 浏览器关闭**：事件可能已经发过，测试进程会 0% CPU 挂住；三处都加上限。
- **多个清理出口各自收尾**：一条失败会短路其余；统一走 `runCleanup()`，逐条跑、合并报错。
- **加 `--test-force-exit`**：会把漏清理从「挂住变红」变成「绿着通过 + 孤儿进程」；不加，靠有界清理。
- **用 `.*is released` 放行预期取消**：会连聚合错误、`buffer is released`、`retry after timeout` 一起放行；锚定宿主模板。
- **引入重试或降并发**：试过 `--test-concurrency=2`，更慢且仍偶发；不改。

## Consequences

- 不引入重试；不改并发度（试过 `--test-concurrency=2`，更慢且仍偶发失败）。
- 只放行上述一条 `console.error`，其余 `console.error` 与全部 `pageerror` 仍是失败；放行依赖宿主文案，宿主改措辞时会失配、e2e 偶发红回来，方向是 Fail Loud。
- 计时来自本机（10 核 macOS）；2 核 CI 与 1.5 倍预算下的测试级余量未实测。

收益：e2e 清理阶段不会再无限挂住，浏览器异常关闭与真正的清理失败仍会带着读数变红。

## Testing

`tests/e2e-harness.test.js`、`tests/e2e-problems.test.js`、`tests/e2e-mock-stop.test.js`；双向读数：正则退回 `.*is released` → 反例集用例红，`closeBrowser` 退回吞掉拒绝 → 「关闭被拒绝要原样抛出」红，还原后全绿。
