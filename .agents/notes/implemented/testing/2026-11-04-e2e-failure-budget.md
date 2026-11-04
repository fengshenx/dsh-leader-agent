# Agent Note: e2e 失败预算与页面读数

**范围**：`tests/e2e/{harness,plugin,session,guide-card,project-workspace}`、`docs/e2e-testing.md`

## 背景

排查一条 e2e 场景时，单跑 `node --test tests/e2e/ungrouped-header.e2e.js` 花了 66.5 秒才失败，看起来像「e2e 很慢」。实测正常场景是 2.6–8.8 秒（全量 4 个场景 9.4 秒），慢的部分全部是 `TimeoutError`：场景里把元素等待写成 `timeout: 60_000`，元素不出现就干等满一分钟才报错。

同一次排查还暴露了两个文档缺口：

- 直接 `node --test` 不会构建客户端产物。新 checkout / 新 worktree 里 `lib/` 为空时，插件半边不加载，症状是每个等待都超时，而不是报「没构建」。
- 场景里各写各的超时（5s / 10s / 30s / 60s / 90s），没有「预算按正常耗时给」的约定，也没有把失败时的页面读数带进报错。

## 决策

### 元素等待统一走 `waitForLocator()`，预算分两档

`tests/e2e/harness.mjs` 新增 `waitForLocator(locator, { description, state, timeoutMs })`，默认 15 秒；场景里首次启动后的元素（输入框、项目行、工作区行）给 20 秒。`locator.waitFor()` 的调用点全部改用它。

- 依据是实测：单场景 3–8 秒、元素 1–2 秒到位，20 秒已是十倍余量。写 60 秒/90 秒不会更稳，只把失败拖成一分钟。
- `waitFor()`（落盘、轮询条件）保持默认 15 秒，场景不再显式传 30 秒/60 秒。
- `E2E_BUDGET_SCALE=1.5` 整体放大（乘在 `waitFor()` 与 `waitForLocator()` 的预算上）：慢机、2 核 CI 上首屏可能超过 20 秒，届时不用改代码。非法值告警一次后按 1 处理——静默忽略会让人以为已经放宽。

### 失败时附目标与页面读数

`waitForLocator()` 失败时打印两段读数：

- **目标元素**：`count`、`visible`、`boundingBox()`、`checkVisibility()`、`display` / `visibility` / `opacity`、宽高。只数 `count` 时分不开「不在 DOM」「在 DOM 但 `display:none`」「在 DOM 但零尺寸」——三种都是同一句超时；补上这三项后两两可分（见验证节的实测读数）。
- **页面**：`data-row-key` 集合、输入框是否可编辑、插件的容器/项目行/引导卡/排除行计数，用来区分「数据没到」与「渲染错了」。

读数不参与断言：断言仍落在 DOM class、计算样式与落盘文件上。`describePage()` 单独导出，供自定义诊断使用。

### 读数自身有预算

`page.evaluate` 没有 timeout 参数（Playwright 的签名只有 `exposeFunctions`），页面主线程卡死时它会一直挂着。实测：1 秒预算的场景在页面死循环下拖成 29.7 秒——正好抵消本 PR 的目标。现在每段读数各限 2 秒（`READ_BUDGET_MS`），超时退化成 `{ unavailable: '页面 2000ms 内无响应' }` / `{ error: '目标元素 2000ms 内无响应' }`；两段并行，失败诊断最多多花 2 秒。

### 页面已关闭与「元素没出现」分开报

页面/浏览器崩掉时 `locator.waitFor()` 抛的不是 `TimeoutError`。之前一律写成「等待超时（15000ms）」，真正原因只以 `cause` 存在。现在只有 `error.name === 'TimeoutError'` 才写「等待超时（预算）」，其余写「等待失败：<首行>」——前者去查选择器，后者去查清理与崩溃。

### 文档补四处 + 抬天花板

- 车道节：单跑也要先构建，缺 `lib/client.js` 的症状是全线超时。
- 断言纪律：预算按正常耗时给，`E2E_BUDGET_SCALE` 是慢机的覆盖入口；失败读数含目标元素的可见性与尺寸、读数自身限 2 秒。
- 失败诊断：先看耗时；报错头是「等待失败」时先看页面/浏览器是否已经没了。
- `docs/e2e-testing.md` 天花板 4400 → 4650：本次净增三处纪律文字后到 4335（原天花板只剩 1.5% 余量，违反「至少 5%」）。先压掉与断言纪律重复的三条（人工取证节「状态类断言的三条硬规矩」整节删掉，指向已有条目），压不下去的是 e2e 车道前提（Node 22.15+ / zstd）与宿主方案对照，搬到 `docs/development.md` 是错层——它自己 2530/2660，余量只有 5.1%，同样贴线。

## 边界

- 不引入重试：重试只会把竞态藏起来（沿用宿主的确定性规则）。
- 不把预算压到秒级：CI 慢机上冷启动需要余量，20 秒是折中值；覆盖入口只放大默认值，默认值不动。
- 读数上限不随 `E2E_BUDGET_SCALE` 放大：它防的是页面卡死，放大只会把卡死重新变成慢失败。
- 不把页面读数做成通用快照或 golden：它只是失败时的附加证据，不承诺结构稳定。
- 不改 `t.after` 的清理顺序与 `problems` 断言；`instance.stop()` 已有 SIGTERM → 5 秒 → SIGKILL 链，本 PR 不碰。
- 归 `implemented/testing/`：改的是测试基建与断言策略，不是运行时行为（口径见 [README](../../README.md)）。

## 验证

- `npm run check`：1025 个用例通过（17 跳过），13 篇 standing docs 在限内（`docs/e2e-testing.md` 4335 / 4650）；并入 `origin/main`（#102）后 1042 个用例通过，多出的 17 例来自笔记归位门禁。
- `npm run e2e`：4 个场景全绿，全量 9.4 秒（4.1 / 4.9 / 7.8 / 9.2；上一轮 9.1 秒，差异在计时波动）。
- 三种不可见形态（临时探针场景注入 DOM，跑完删除）：
  - `display:none` → `{"count":1,"visible":false,"box":null,"checkVisibility":false,"display":"none"}`
  - 零尺寸 → `{"count":1,"visible":false,"box":{"width":0,"height":0},"checkVisibility":true,"display":"block"}`
  - `visibility:hidden` → `{"count":1,"visible":false,"box":{"width":1440,"height":18},"checkVisibility":false,"visibility":"hidden"}`
  - 不在 DOM → `{"count":0,"inDom":false}`
  - 双向验证：撤掉读数里的可见性/尺寸字段后，前三种都退化成同一个 `{"count":1}`。
- 页面卡死（页面主线程阻塞 10 秒）：`describePage()` 2002ms 返回 `{"unavailable":"页面 2000ms 内无响应"}`，`waitForLocator({ timeoutMs: 1000 })` 3002ms 失败；撤掉 `withDeadline` 后同一读数耗 10000ms。
- 页面已关闭：报「等待失败：locator.waitFor: Target page, context or browser has been closed」；撤掉 `error.name` 分支后变成「等待超时（15000ms）」，误导。
- 预算倍率：`E2E_BUDGET_SCALE=3` 时 1 秒预算的等待 3026ms 失败，消息写「等待超时（3000ms）」。
- 双向验证（失败语义）：把 `plugin.e2e.js` 的选择器改坏 → 22.2 秒失败（原 60 秒 + 启动），报错为
  `等待超时（20000ms）：插件项目区块在左栏挂载；locator locator('.dsh-leader-agent-project-section-missing')；…页面读数 {"rowKeys":[...],"composer":true,"leaderAgent":{"sections":1,...}}`
  → 还原后 2.6 秒绿。读数里的 `sections: 1` 正是「插件挂载了、选择器写错」的证据。
