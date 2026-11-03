# Agent Note: e2e 清理阶段的有界等待

**范围**：`scripts/dev-instance.mjs`、`tests/e2e/{harness,instance,mock-llm,guide-card,project-workspace,plugin,session}`、`package.json`、`docs/e2e-testing.md`、`tests/e2e-{mock-stop,problems,harness}.test.js`

## 背景

反馈是「e2e 还是这么慢」。实测把「慢」分成了两件事：

- **正常不慢**：4 个场景并行 8–12 秒，单场景 3.5–8.5 秒。单实例启动 2.3 秒、4 个并发 3.0 秒；chromium 启动 0.25 秒/个。热路径上没有可压缩的余量——6 次 `dsh web` 启动是主要成本，来自「黑盒 spawn 真实宿主」这条设计，不能换成宿主那样的进程内组合。
- **偶发卡死**：全量 3 次里 2 次卡住，分别 90 秒与 5 分钟以上。卡住时测试进程 0% CPU、`dsh web` 仍在监听、没有 chromium 子进程、没有任何报错输出——是清理阶段在等一个不会到来的事件，不是慢。

## 决策

### 三处无限等待都加上限

1. `spawnDshWeb().stop()`：SIGKILL 之后又挂了一次无上限的 `child.once('exit')`。`exit` 只发一次，监听器挂上去时事件可能已经发过，子进程若已退出就永久等下去。改成两次 `waitForExit(5s)`（TERM → KILL），第二次仍未退出则抛错。
2. `mock.stop()`：`server.close()` 会等所有连接结束，而 SSE 是 keep-alive。先发起关闭，再 `closeAllConnections()`，最后 await。
3. 浏览器关闭：Playwright 的 `browser.close()` 在进程没干净退出时既不 resolve 也不 reject，`await close().catch(...)` 只处理拒绝。新增 `closeBrowser()`：10 秒上限，超时告警后继续清理；**拒绝照样往上抛**，进「e2e 清理失败」——浏览器非正常关闭（页面崩、连接断）恰是最需要看见的一类，吞成成功等于丢掉这条线索。

### 清理失败只有一条出口

`launchE2E().stop()` 与场景自己的 `t.after` 都走 `stopScenario()` → `runCleanup()`：逐条跑、互不短路（前一环挂了，后面的资源仍要收掉），失败合并成一条 `e2e 清理失败`。只在一条链上记、另一条链上吞，同一条 Fail Loud 就变成看运气落在哪条链上。`instance.stop()` 的 `stopped` 改为杀成功后才置位：抛错后还能重试杀进程，不把孤儿留到重启。

### 迟到的断言改成轮询

`firstSession()` 在「输入框可编辑」之后立刻断言会话已落盘。建会话是宿主的异步动作，两者没有先后保证——全量偶发「宿主启动后应有一个落盘的空会话」即此。改成 `waitFor()` 轮询 5 秒。

### 测试级上限 90 秒，且不加 `--test-force-exit`

测试级 timeout 统一走 `scenarioTimeout()`（默认 90 秒，随 `E2E_BUDGET_SCALE` 放大）。内部每个等待都乘倍率，测试级不乘会让慢机先撞它，把带读数的「等待失败」换成一句「测试超时」——正是 #104 想避免的形态。

**不加 `--test-force-exit`**：对抗探针实测，同一个「只 spawn 子进程、不 kill」的用例，无 force-exit 时退出码 124（挂住被抓到），加上之后退出码 0（绿）且留下孤儿 `dsh web`。它把「漏清理」从「挂住/变红」变成「绿着通过 + 孤儿进程」，而本 PR 要修的正是无声挂住。有界清理已覆盖已知三处，漏清理应该继续暴露；单跑命令与 `npm run e2e` 因此等价。

### 预期取消的放行按宿主模板的形状匹配

`ui-sidebar-right/src/client/session-view.ts` 在构造时订阅 `reference.ready`，失败就打 `console.error('Sidebar Session opening failed:')`；而 `release()` 必然让 readiness 以 `is released` reject。视图在 ready 之前被销毁（快速切换会话）因此必然打出这条——它是取消，不是故障。

放行正则锚定到宿主模板：`^Sidebar Session opening failed: (?:Error: )?Session reference "[^"]*" is released(?:\n|$)`。旧写法 `.*is released` 会把聚合错误里的释放、`buffer is released`、`retry after timeout, session is released` 一起放行。尾部不锚 `$`：真实 text 首行之后跟着栈。

## 边界

- 不引入重试：重试只会把竞态藏起来（沿用宿主的确定性规则）。
- 不改并发度：试过 `--test-concurrency=2`，每轮 12 秒（比默认慢 3 秒）且仍偶发失败，没有收益。
- **按宿主口径收窄 `console.error`，不是全放行**：只放行上述一条，其余 `console.error` 与全部 `pageerror` 仍是失败。放行依赖宿主文案，宿主改措辞时这里会失配、e2e 偶发红回来——方向是 Fail Loud，先看 `EXPECTED_SESSION_RELEASE`。
- 计时来自本机（10 核 macOS）；2 核 CI 与 1.5 倍预算下的测试级余量未实测。

## 验证

- `npm run check`：1056 个用例通过（17 跳过），71 个源文件里 55 个被加载、47 个行覆盖 100%；笔记 78 篇、文档工具名 14 篇、文档预算 13 篇全在限内（`docs/e2e-testing.md` 天花板 4650 → 4750，见 PR 说明）。
- 新增用例：`tests/e2e-harness.test.js` 七例（关闭拒绝要抛出、超时只告警、迟到的拒绝不成未处理 rejection、清理失败合并且后续仍跑与删根、`scenarioTimeout()` 倍率）、`tests/e2e-problems.test.js` 一条反例集（三条旧正则误放行的消息）、`tests/e2e-mock-stop.test.js` 两例。
- 双向验证：
  - 正则退回 `.*is released` → 「同前缀 + 真实错误里夹着 `is released`」变红（4 pass / 1 fail），还原后绿；
  - `closeBrowser` 退回 `then(() => true, () => true)` → 「关闭被拒绝要原样抛出去」变红（6 pass / 1 fail），还原后绿；
  - `mock-llm.mjs` 退回 `await new Promise((resolve) => server.close(resolve))` → 「stop 不等未结束的请求」2 秒预算用尽变红（2110ms），恢复后 108ms 绿。
- 卡死：改前全量连跑 3 次、2 次卡住（90s / 5min+）。改后不带 `--test-force-exit` 连跑 3 轮，每轮 9 秒、4/4 绿、退出码 0、跑后 0 个残留 `dsh web`——套件自己就能退干净，不需要强制退出。
- 漏清理探针（本机复跑审查者的对抗用例）：同一个「只 spawn 子进程、不 kill、不 unref」的用例，不带 `--test-force-exit` 时 25 秒后进程仍挂住（漏清理被抓到）；带上之后 `exit=0`、全部通过，并留下孤儿进程（实测 pid 60502，手动清理）。
- 失败率：放行该文案前 5 轮 4 绿 1 红，红的是宿主的 `Session reference is released`（`project-workspace`）。
