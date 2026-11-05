# 看板已完成区的分页与行字号

**范围**：`src/client/board.js`、`src/client/board-projection.js`、`src/client/board-styles.js`、`src/client/session-watermark.js`、`tests/board-projection.test.js`、`tests/session-watermark.test.js`、`tests/e2e/board-done-paging.e2e.js`

## 背景

已完成卡累积后，展开「已完成」一次渲染全部历史卡：历史区比进行中的卡片还长，滚动条要拉很久才到下一块交付物；每 2 秒轮询也会重建整棵列表。行标题用 13px，比卡号（11px）更抢眼——历史浏览的视觉重量压过了进行中的卡。

## 决策

**已完成区按 30 张一页折叠**。口径照宿主工作区树的会话折叠：默认露出一页，点「展开其余」再加一页，剩余不超过一页时一次放完（水位抬到 `Infinity`），展开到最后一页后按钮变「收起」，收起回落到基线；水位只升不降。水位是组件本地状态，不落存储——宿主也不持久化会话列表的展开状态。

**页大小是 30，不是宿主的 5**。已完成卡是历史浏览，30 张一页比会话列表的 5 条更省点击；两边共用同一套折叠口径，页大小各自成常量（`DONE_PAGE_SIZE` 对 `SESSION_WATERMARK_BASE`）。

**折叠逻辑收口到 `session-watermark.js`，页大小参数化**。共享实现是 `foldRows(rows, watermark, { pageSize, baseline, noun })` 与 `nextRowWatermark(hiddenCount, visibleCount, pageSize)`；`foldSessions` / `foldDoneCards` 只负责各自的基线与量词——会话侧把运行中 / 完成未读 / 当前会话抬高的注意力水位当基线，已完成卡没有注意力状态，基线就是一页。第二参统一收「当前可见数」，不再一边叫水位、一边叫可见数。`foldDoneCards` / `nextDoneWatermark` 的导出名保留，`board.js` 调用点不动。

**翻页判定抽成纯函数**（共享层的 `foldRows` / `nextRowWatermark`，两端的 `foldDoneCards` / `nextDoneWatermark` 是薄封装）。组件不可单测，「剩余不超过一页是否一次放完」「展开完是否变收起」这类边界要能直接断言，所以不进 JSX。

**已完成行标题降到 11px，与卡号同字号**。完成区行内四段（勾选图标 / 卡号 / 标题 / 完成时长）同一档位；13px 只留给 active 卡标题。

## 边界

- **水位不持久化**：面板重挂载（切会话、切 tab）后回到一页。
- **没有注意力抬升**：宿主会为运行中、等你输入的会话抬高水位；已完成卡没有对应状态，只有分页。
- **收起只回基线**：不回到上一次展开的页码。
- **按钮文案说「卡片」不说「会话」**：看板里会话另有所指（槽位 chip 打开的才是会话），沿用宿主会话列表的「会话」文案会指错对象。

## 验证

- `tests/board-projection.test.js` 新增 1 例：不足一页不给按钮、超过一页默认 30 张且文案带剩余数、剩余不超过一页一次放完、展开完 `expanded`、收起回基线、三页时一次只加一页；另补一例钉住 `DONE_PAGE_SIZE === 30`。
- `tests/session-watermark.test.js` 补三例：页面大小 `SESSION_WATERMARK_BASE === 5`、`foldRows` 的页大小与基线语义（基线高于一页时全露也不算展开完）、`foldSessions` 的页大小可参数化（页大小 3 时按 3 条翻页，`nextRowWatermark` 同口径）。
- 共享层双向验证：把 `foldRows` 的 `expanded` 判定改回「只看是否超过一页」（忽略基线）、把 `nextRowWatermark` 的 `<=` 改成 `<`，会话与看板两侧的对应断言都红（会话注意力基线与两边的「剩余正好一页一次放完」）；还原后全绿。证明两端真的走共享实现，不是各留一份复制。
- **常驻 e2e `tests/e2e/board-done-paging.e2e.js`**：seed 31 张 done 卡，从右栏 guide 页的「看板」入口打开面板——默认 30 行、按钮「展开其余 1 个卡片」、`aria-expanded=false`；点击后 31 行、按钮「收起」、`aria-expanded=true`；再点回 30 行。`.dsh-leader-agent-board-done-title` 与 `.dsh-leader-agent-board-card-number` 的 computed `font-size` 同为 `11px`。面板走 guide 入口而不是「建卡自动弹出」，避开监视器首轮基线的时间竞态；自动弹出由 `project-board-monitor.test.js` 的单测守着。单跑连跑 3 次全绿。
- **双向验证**：把 `board.js` 的 `doneFold.rows.map` 改回 `done.map`（等于关掉 UI 分页）→ 新场景变红（`默认应渲染 30 行`，实际 31）；还原后全绿。补上「纯函数有测、接线没测」的缺口。
- `npm run check` 与 `npm run e2e` 全绿。
