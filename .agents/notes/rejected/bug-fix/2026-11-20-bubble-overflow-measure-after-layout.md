# Agent Note: 气泡溢出测量改由观察器首次回调（已否决）

Status: rejected — CDP 实测同步读没有多出布局：React 的 layout effect 在同一次 commit 的 DOM 变更之后执行，第一条 `scrollHeight` 已经让整文档排好版，后 27 条读命中的是干净布局；两条路径的指标差在噪声内。

## Problem

打开 leader 会话时，宿主那次 905ms 的点击里插件占 163ms：`AgentBubble` 在 layout effect 里同步读 `scrollHeight`。最初的判断是「一次提交挂 28 条气泡 = 28 次强制样式重算 + 布局」（trace 里 56 个样式/布局事件），据此认为这份开销是每次挂载、每帧气泡重排都白付的。

审查用 CDP `Performance.getMetrics` 复测后，这个前提不成立：56 个事件只能说明「28 条气泡这次提交本身要布局」，不能证明 28 次读各触发一次。同一次 commit 里的强制布局是共享的。

## Proposal

把读尺寸从 layout effect 挪到 `ResizeObserver` 的首个回调（`observe()` 会先投递一次初始尺寸，回调排在布局之后），没有观察器的引擎保留一次同步读；样式注入仍留在 layout 阶段，保证 clamp 规则先于测量生效。

否决理由：同步读并没有多出布局，改法拿不到可测量的收益，却引入一个新依赖路径（首帧异步量水位、无观察器分支）与一套 e2e 才能守住的行为变化。收益为负。

## Alternatives considered

- **共享微任务队列批量读**（先写过一版）：想把 N 次读压成一次；实测表明浏览器在 React 的这次 commit 里已经只排一次版，这个模块在重做浏览器已经做过的事。
- **保留同步读、按帧节流**：只是把同步读摊到多帧，按钮出现被推迟，总工作量没变。
- **用 CSS 判溢出**（`max-height` 截断 + `:has`）：拿不到内容真实高度，判不出「有没有两行以上」，只能一律显示开关。
- **观察器首次回调（本提案）**：被实测否决，见上。

## Testing

测量方法：真实宿主 + 本地 mock，往 leader 会话日志追加 **28 条长 worker 回报**；打开会话前后各取一次 CDP `Performance.getMetrics`，算增量。同机交替跑两条路径各 5 轮：一条是当时的观察器版本，另一条用 `git checkout 70c701e -- src/client/agent-bubble-view.js` 临时还原同步 `measure()` 并重建 `lib/client.js`。

| 路径 | LayoutCount | RecalcStyleCount | LayoutDuration | RecalcStyleDuration |
|---|---|---|---|---|
| 观察器首次回调 | 13.0（8–16） | 35.0（26–42） | 7ms | 29ms |
| 临时加回同步 `measure()` | 13.4（9–15） | 37.0（25–43） | 7ms | 29ms |

- 空白页校准：循环 28 次 `append + scrollHeight`，`LayoutCount` / `RecalcStyleCount` 精确 **+28**，说明指标抓得到强制布局，上面的「没有差异」不是测不到。
- 结论：两条路径的差异（+0.4 次布局、+2 次样式重算、时长相同）落在噪声内；同步读没有多出 28 次布局。
- 保留的产物：`tests/e2e/avatar.e2e.js` 的长回报折叠用例（该用例与测量路径无关，继续守住折叠行为）。
