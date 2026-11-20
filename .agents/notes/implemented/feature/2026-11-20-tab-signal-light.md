# Agent Note: 标签栏信号灯改用静态点

Status: implemented

## Problem

项目会话标签栏最初直接复用宿主的 `StateDot`（见[项目会话标签栏](2026-11-16-project-session-tabs.md)）：运行中画周期性转圈的 spinner，完成未读画绿点。看板卡面的同一档状态用的是静态信号灯——运行中琥珀色呼吸点、未读蓝点、空闲弱化灰点。标签栏的 spinner 在密集标签里被读成「正在加载」，与卡面表达的不是同一件事；同一档状态在两个位置有两套图形，扫视时还要重新解释。

## Decision

- worker 标签的信号灯改用与看板卡面同一套静态点：运行中琥珀、完成未读蓝、空闲弱化灰。运行中保留卡面的透明度呼吸，不做旋转；`prefers-reduced-motion` 下停掉呼吸。
- 档位名跟着卡面收敛成 `running` / `unread` / `idle`（原先的 `ongoing` / `done` 是宿主 `StateDot` 的词汇）。判定不变：运行中盖过完成未读，都没有就是空闲。
- 档位文案复用看板的 `board.state.*` 字典键，标签栏不再另养一套。
- 只换呈现，不扩状态：宿主会话快照仍只给运行中与完成未读两档事实，「等你输入」「失败」属于卡片侧的会话状态投影，标签栏不借这次改动去取 `useSessionStatus`。
- **样式只有一份**：common 三档（基础点、running、unread、idle）、呼吸动画与 reduced-motion 由 `src/client/signal-styles.js` 的 `signalStyleText(prefix)` 生成，标签栏与看板各自把选择器前缀传进去拼进自己的样式表；看板独有的 waiting / attention / unknown / none / hollow 仍留在看板样式表。呼吸动画名统一成 `dsh-leader-agent-signal-pulse`，两处引用同一条 keyframes——改周期只改共享模块，另一边不会静默漂移。

## Alternatives considered

- **继续用 `StateDot`，只把 ongoing 换成别的档**：三档里只有 ongoing 是转圈，换档就只能谎报运行态；而且绿点与卡面的未读蓝仍对不上。
- **改宿主的 `StateDot`**：仓外插件不能改宿主组件；`StateDot` 在项目树会话行里仍是正确的加载语义，那里要的就是 spinner。
- **信号灯 CSS 各写一份**：首版就是两份逐值相同的样式（各一条 keyframes），只靠人工对齐；看板的呼吸周期一改，标签栏那条就静默留在旧值。共享模块的代价只有一个新文件与一次前缀参数化，换来结构上不可能漂移。
- **标签栏补齐卡面的 waiting / attention 档**：要拿到宿主的会话状态 hook（`useSessionStatus`），而标签栏挂在 `shell.overlay`，这个座位不注入它；扩状态是另一件事，不该跟「去掉 spinner」混在一起。

## Consequences

- 标签的信号灯与项目树会话行不再长得一样：那边继续用 `StateDot` 的加载圈，表达「会话在跑」；标签这边与看板卡面对齐，表达「这一档状态」。两处语义不同，是有意分开的。
- 标签的信号灯比原先的宿主点更小，视觉重量更接近卡面；完成未读由绿转蓝，与卡面的未读同色。
- 收益：同一档状态在标签栏与看板卡面上是同一个图形，扫标签时不再把运行中误读成加载中。

## Testing

- `tests/session-tabs-logic.test.js` 钉住三档命名与优先级。
- `tests/signal-styles.test.js` 钉住共享样式的关键值（8px、`.4`、`1.6s`、唯一 keyframes、reduced-motion），防止共享模块本身被改坏；同时断言两种前缀生成的结构逐字一致。
- `tests/e2e/session-tabs.e2e.js` 断言 worker 标签有 `.dsh-leader-agent-tab-signal[data-signal]`、class 带对应档位、`aria-label` 等于 `board.state.*` 的档位文案，并且标签里不再有宿主 `StateDot` 的 `[data-state]`（反向钉住 spinner 不会回来）。
