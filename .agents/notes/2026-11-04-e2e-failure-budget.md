# e2e 失败预算与页面读数

**状态**：implemented（2026-11-04）
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

### 失败时附页面读数，读数只做证据

`waitForLocator()` 超时时打印 locator 与 `describePage()` 的结果：当前 `data-row-key` 集合、输入框是否可编辑、插件的容器/项目行/引导卡/排除行计数。

- 读数用来区分「数据没到」与「渲染错了」：例如选择器写错时 `leaderKit.sections` 仍是 1，直接说明插件已经挂载。
- 读数不参与断言：断言仍落在 DOM class、计算样式与落盘文件上。
- `describePage()` 单独导出，供自定义诊断使用；页面已关闭时返回 `{ unavailable }`，不盖住真正的失败原因。

### 文档补三处

- 车道节：单跑也要先构建，缺 `lib/client.js` 的症状是全线超时。
- 断言纪律：预算按正常耗时给（20 秒首次启动 / 15 秒元素状态），失败走 `waitForLocator()` 带读数。
- 失败诊断：先看耗时，单场景正常 3–8 秒；一分钟没结束先怀疑等待错了元素，而不是机器慢；别用 `grep` / `head` 过滤测试输出。

## 边界

- 不引入重试：重试只会把竞态藏起来（沿用宿主的确定性规则）。
- 不把预算压到秒级：CI 慢机上冷启动需要余量，20 秒是折中值。
- 不把页面读数做成通用快照或 golden：它只是失败时的附加证据，不承诺结构稳定。
- 不改 `t.after` 的清理顺序与 `problems` 断言。

## 验证

- `npm run check`：1025 个用例通过，13 篇 standing docs 在天花板内（`docs/e2e-testing.md` 4398 / 4400）。
- `npm run e2e`：4 个场景全绿，全量 8.8 秒（改前 9.4 秒，差异在计时波动）。
- 双向验证：把 `plugin.e2e.js` 的选择器改坏 → 22.2 秒失败（原 60 秒 + 启动），报错为
  `等待超时（20000ms）：插件项目区块在左栏挂载；locator locator('.dsh-leader-kit-project-section-missing')；页面读数 {"rowKeys":[...],"composer":true,"leaderKit":{"sections":1,...}}`
  → 还原后 2.6 秒绿。读数里的 `sections: 1` 正是「插件挂载了、选择器写错」的证据。
