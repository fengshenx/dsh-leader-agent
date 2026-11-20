# Agent Note: 气泡溢出测量改由观察器首次回调

Status: implemented

## Problem

打开 leader 会话时，宿主那次 905ms 的点击里插件占 163ms：`AgentBubble` 在 layout effect 里同步读 `scrollHeight`，真机 trace 里 28 条气泡各触发一次样式重算 + 布局（56 个事件）。

用本仓 e2e 夹具（往日志追加 28 条回报、没有真实 turn）复测却量不出差异：那种会话在一次 commit 里把气泡全挂上，第一条读就把整文档排好版，后面读的是干净布局。所以「一次 commit 共享一次布局」只在宿主没有逐节点写入时成立，不能拿它否定真机 trace。

## Decision

读尺寸挪到 `ResizeObserver` 的首次回调：`observe()` 会先投递一次初始尺寸，回调排在布局之后，读 `scrollHeight` 不再触发排版。layout effect 只保留样式注入（clamp 规则必须先于测量生效），没有观察器的引擎保留一次同步读。

真机快照（真实 leader 会话、含 turn）上 A/B 各 3 轮：同步读 `LayoutCount` 20 / `RecalcStyleCount` 39，观察器 11 / 30——正好各少 9 次，等于 9 条气泡。原因是宿主的逐节点 layout effect 会在两条气泡的读之间写样式，后一条读到的仍是脏布局。

## Alternatives considered

- **共享微任务队列批量读**（先写过一版）：能把 N 次读压成一次，但仍要在提交后强制一次全窗布局；观察器首次回调本来就把这些量掉。
- **保留同步读、按帧节流**：只是摊到多帧，总工作量不变。
- **用 CSS 判溢出**（`max-height` 截断 + `:has`）：拿不到内容真实高度，判不出「有没有两行以上」，只能一律显示开关。
- **依据合成夹具的零差异回退**：夹具没有 turn，宿主不在气泡之间写样式，因此复现不了真机现象；回退会把真机上可测的收益一起丢掉。
- **只量可见气泡（IntersectionObserver + ResizeObserver）**：在 7 条气泡全在视口外的页上实测，IO 版、纯 RO 版、完全不测量三者都是 `LayoutCount` 8 / `RecalcStyleCount` 23–24——离屏气泡的读本来就不额外触发布局，加 IO 拿不到收益；尾页 21 条气泡可见时更没得跳。未采用。

## Consequences

- 折叠水位在 observe 之后的首次回调里得出（同帧、布局后、绘制前）；首帧的 clamp 仍由 CSS 负责，不会先铺开全文再收起。
- 组件层没有可进 Node 的测量逻辑（本仓不引 React/jsdom），行为由 e2e 守；用例只覆盖单条长回报，不覆盖虚拟滚动下的大量气泡。
- **开关与累积（实测）**：同一真实长会话（339 个 turn、209 条回报）在隔离 home 里开关 5 次，每次打开 DOM 节点 4,480、样式表 170、插件注入的 `<style>` 6、挂载气泡 7；关闭后节点 1,306、气泡 0——没有单调上涨，插件侧无节点 / observer / 样式泄漏。宿主只渲染尾页：`session.ts` 的 `bufferOlder()` 把更早条目移出快照（`eventSource.replace(entries.slice(start), true)`），向上翻页时才重新挂载（7→16 个气泡、4,484→8,014 个节点）。已挂载气泡数被宿主页窗口封顶，插件成本不随会话长度增长。
- 收益：挂载含 turn 的真实会话时，插件不再为每条气泡强制一次样式重算 + 布局。

## Testing

`tests/e2e/avatar.e2e.js` 的场景加一条长回报，断言「展示更多」出现、`data-collapsed` 由 `true` 变 `null`、展开后高度增长、再点收回。双向验证：去掉观察器 → 用例红在「展示更多」超时；还原 → 全绿。真机 A/B（9 条气泡）：`LayoutCount` 20→11、`RecalcStyleCount` 39→30、`TaskDuration` 0.34→0.31s。
