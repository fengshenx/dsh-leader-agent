# Agent Note: e2e 清理阶段的有界等待

**范围**：`scripts/dev-instance.mjs`、`tests/e2e/{harness,mock-llm,guide-card,project-workspace,plugin,session}`、`package.json`、`tests/e2e-mock-stop.test.js`

## 背景

反馈是「e2e 还是这么慢」。实测把「慢」分成了两件事：

- **正常不慢**：4 个场景并行 8–12 秒，单场景 3.5–8.5 秒。单实例启动 2.3 秒、4 个并发 3.0 秒；chromium 启动 0.25 秒/个、4 个并发仍是 0.3 秒。热路径上没有可压缩的余量——6 次 `dsh web` 启动是主要成本，来自「黑盒 spawn 真实宿主」这条设计，不能换成宿主那样的进程内组合。
- **偶发卡死**：全量 3 次里 2 次卡住，分别 90 秒与 5 分钟以上。卡住时测试进程 0% CPU、`dsh web` 仍在监听、没有 chromium 子进程、没有任何报错输出——是清理阶段在等一个不会到来的事件，不是慢。

## 决策

### 三处无限等待都加上限

1. `spawnDshWeb().stop()`：SIGKILL 之后又挂了一次无上限的 `child.once('exit')`。`exit` 只发一次，监听器挂上去时事件可能已经发过，子进程若已退出就永久等下去。改成两次 `waitForExit(5s)`（TERM → KILL），第二次仍未退出则抛错。
2. `mock.stop()`：`server.close()` 会等所有连接结束，而 SSE 是 keep-alive。先发起关闭，再 `closeAllConnections()`，最后 await。
3. 浏览器关闭：Playwright 的 `browser.close()` 在进程没干净退出时既不 resolve 也不 reject，`await close().catch(...)` 只处理拒绝。新增 `closeBrowser()`：10 秒上限，超时告警后继续清理。

### 迟到的断言改成轮询

`firstSession()` 在「输入框可编辑」之后立刻断言会话已落盘。建会话是宿主的异步动作，两者没有先后保证——全量偶发「宿主启动后应有一个落盘的空会话」即此。改成 `waitFor()` 轮询 5 秒。

### 卡死的上限从 300 秒收到 90 秒

测试级 timeout 统一 90 秒（正常 3.5–8.5 秒，十倍余量），`npm run e2e` 加 `--test-force-exit`：测试结束后不等事件循环清空，避免残留句柄把文件进程拖住。

## 边界

- 不引入重试：重试只会把竞态藏起来（沿用宿主的确定性规则）。
- 不改并发度：试过 `--test-concurrency=2`，每轮 12 秒（比默认慢 3 秒）且仍偶发失败，没有收益。
- **不消除宿主侧的 `Session reference "…" is released`**：它发生在宿主的 `SidebarSessionView.dispose` 访问已释放的 session reference 时，栈里没有插件帧，属宿主 client 竞态。保留「console.error 即失败」的纪律，不为它加白名单；这类偶发失败仍会红，需要在报告里如实标出。
- 计时来自本机（10 核 macOS）；慢机仍走 `E2E_BUDGET_SCALE`，本次不动它。

## 验证

- `npm run check`：1044 个用例通过（17 跳过），新增 `tests/e2e-mock-stop.test.js` 两例；13 篇 standing docs 在限内。
- 双向验证（mock）：还原成 `await new Promise((resolve) => server.close(resolve))` → `stop 不等未结束的请求` 2110ms 变红（2 秒预算用尽）；恢复后 108ms 绿。
- 卡死：改前全量连跑 3 次、2 次卡住（90s / 5min+）；改后连跑 5 次，全部 8–9 秒结束，0 次卡死。
- 失败率：改后 5 轮 4 绿 1 红，红的是宿主的 `Session reference is released`（`project-workspace`），与本次改动无关；改前同样跑法 5 轮 2 红（含上述错误与「没有落盘的空会话」，后者已由轮询修掉）。
