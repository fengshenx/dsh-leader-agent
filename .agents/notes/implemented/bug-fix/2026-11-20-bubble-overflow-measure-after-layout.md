# Agent Note: 气泡溢出测量挪出 layout 阶段

Status: implemented

## Problem

打开 leader 会话时，宿主那次 905ms 的点击里插件占 163ms：`AgentBubble` 在 layout effect 里同步读 `scrollHeight`，一次提交挂 28 条气泡就是 28 次强制样式重算 + 布局（trace 里 56 个样式/布局事件）。宿主自己的整窗重算才是大头，但这一份是每次挂载、每帧气泡重排都白付的。

## Decision

读尺寸不再在 layout effect 里做，那里只保留样式注入。`ResizeObserver.observe()` 会先投递一次初始尺寸，这次回调排在布局之后，读 `scrollHeight` 不会再触发排版；窗口缩放与字体档位仍靠同一条观察器。没有 `ResizeObserver` 的引擎保留一次同步读——本仓只支持 Chromium 宿主，那条路径实际走不到。

## Alternatives considered

- **共享微任务队列批量读**（先写过一版）：能把 N 次读压成一次，但仍要在提交后强制一次全窗布局；观察器的首次回调本来就把这些量掉，多一个模块与调度只为重做浏览器已经做的事。
- **保留同步读、按帧节流**：只是把 28 次摊到多帧，按钮出现被推迟，总工作量没变。
- **用 CSS 判溢出**（`max-height` 截断 + `:has`）：拿不到内容真实高度，判不出「有没有两行以上」，只能一律显示开关。

## Consequences

- 折叠水位在 observe 之后的首次回调里得出（同帧、布局后、绘制前）；首帧的 clamp 仍由 CSS 负责，不会先铺开全文再收起。
- 组件不再有可在 Node 里断言的测量逻辑：本仓不引 React/jsdom，这一层由 e2e 守（长回报出现「展示更多」、展开、收回）。
- 收益：挂载长会话时插件不再贡献 28 次强制排版，溢出判定与点击行为不变。

## Testing

`tests/e2e/avatar.e2e.js` 的场景多了一条长回报，断言「展示更多」出现、`data-collapsed` 由 `true` 变 `null`、展开后高度增长、再点收回。双向验证：把观察器整个去掉 → 用例红在「展示更多」超时（`count:0`）；还原 → 全绿。
