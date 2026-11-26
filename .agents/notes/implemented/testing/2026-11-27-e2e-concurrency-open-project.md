# Agent Note: e2e 点击竞态与并发等待

Status: implemented

## Problem

`board-cinema` 在全量车道偶发失败，根因是测试只点一次项目行：宿主侧栏刷新时点击丢失，后面再等看板/选中态只能超时。`guide-card` / `project-workspace` 同形，`avatar` 更差——用 `getByText('avatar')` 点文本而不是项目行。`board-cinema` 还靠「侧栏连续 500ms 没 DOM 变化」的墙钟窗口；加等待预算救不了没发生的点击（`E2E_BUDGET_SCALE=1.5` 对 `board-done-paging` 就无效）。

## Decision

- 新增 `openProject()`：先等项目行出现，每一轮确认 `data-dead` 为空再点，点到 `data-selected === 'true'` 为止；失败读数带 `dead` / `selected` / `aria-current`。未就绪时连点都不点，避免把「行没就绪」误归因成「重渲染吃掉点击」。
- 收口 `guide-card` / `project-workspace` / `board-cinema` / `board-done-paging`；`avatar` 单独处理——先把 `getByText('avatar')` 换成 `.project-row` 再走同一 helper，不是把文本点击硬套成项目行。
- 删除 `board-cinema` 的 `waitForSidebarStable(500ms)`；就绪锚是 `data-dead`，成功锚是 `data-selected`，不再用「一段时间没变化」。
- 预算倍率改为 `min(4, max(1, loadavg / ncpu))`；`resolveBudgetScale()` 可注入 load / cores / 覆盖值，`processBudgetScale()` 每进程只解析一次，`waitFor` / `waitForLocator` / `scenarioTimeout` 共用。`E2E_BUDGET_SCALE` 仍显式覆盖；自动值首次使用时打印。
- flake 表与等待预算说明同步：并发允许「全量 + 子集」或两条子集，不再要求错峰；`sessions.retain: unknown session` 仍归宿主 #200，不吞掉。

## Alternatives considered

- **只加等待预算**：点击没发生，等多久都不会选中；mutation 已证明。
- **只重试 click**：行还没就绪时点击会弹「leader 已被删除」，会把未就绪误归因成重渲染；helper 每轮先看 `data-dead`。
- **保留 500ms 静默窗口**：仍是墙钟判据，慢机器上窗口本身不可信；语义就绪更强。
- **继续串行**：用户明确要求 e2e 并发可信，串行规避不算修复。
- **把 `sessions.retain` 当已知错误过滤**：会掩盖 #200 的宿主 bug，破坏 `watchProblems` 的 fail-loud；不做。

## Consequences

- 单车道全量：load 37.38，自动倍率 3.74，**21/21，301.6s，平均 14.36s**。
- 两车道并发（全量 + `--files board-cinema guide-card project-workspace`）：load 8.26，**21/21（231.8s）+ 3/3（33.0s）**，两边都绿。
- 负载敏感四条在高 load 下各 3 次通过：`guide-card` 13.1/18.65/22.81，`project-workspace` 13.86/14.28/13.51，`board-done-paging` 13.5/12.66/11.19，`board-cinema` 29.38/40.28/36.81。
- mutation：去掉 `data-selected` 重试后，四车道并发跑 `board-cinema` 本地四条全红，读数 `{"dead":null,"selected":null,"current":null}`；review 独立复跑 3 绿 / 1 红，说明点击丢失仍偶发，不能保证每次红。还原后单跑 12.6s 绿。
- 并发不再需要错峰；两条车道同时跑时自动倍率按整机 load 放大，封顶 4，避免无限等待。
- 残余风险：`sessions.retain: unknown session` 仍可能让 `guide-card` / `board-cinema` / `avatar` 红；它来自宿主 #200，不是这次点击竞态，仍由 `watchProblems` 留红。并发全量+子集的一次尝试就命中过它，重跑后绿。
- 收益：点击丢失从「随机红」变成「失败读数可区分未就绪/未选中」，并发车道可用，不再靠单车道错峰。

## Testing

- `npm run e2e:report`：21/21（load 37.38，自动 3.74）。
- 并发：全量 + 3 场景子集，两边 21/21 与 3/3（load 8.26）。
- 负载敏感四条各 3 次通过（load 11–40）。
- mutation：把 `openProject` 从「重试到 data-selected」改成「等 data-dead 后单次点击」；本地四车道并发 4 红、review 独立复跑 3 绿 / 1 红——点击丢失是概率性的，不保证每次 mutation 都红；还原后单跑 12.6s 绿。
- `npm run check`：load 27.23 时 exit 0（1542 个用例通过，17 跳过）；低负载同样 exit 0。单测用注入的 load/cores 断言倍率，不依赖真实负载。
