# Agent Note: Leader 会话隐藏宿主的改动文件卡片

Status: implemented

## Problem

宿主的 `@deepseek-ai/dsh-client-ui-deliverables` 在每个完成轮次的收尾消息后渲染一张「已编辑 N 个文件」卡片，注册在 chat 视图的 `conversation.chat.turnTail` 列表槽里。leader 是协调者，文件改动属于 worker；它自己偶尔用文件工具改过东西时，这张卡片对看对话的人没有信息量，还会把协调者的转录撑长。

宿主的 slot 注册没有按会话过滤的参数，第三方也不能卸载别人的注册。宿主唯一的开关是通用设置里的「显示代码工作视图」——关掉会连带轨迹视图与完整 Agent 预设列表一起消失，代价远超一张卡片。

## Decision

- **走渲染层隐藏**：当前主区域会话是 leader 时，给实际主面板节点加 `data-dsh-leader-agent-hide-changed-files`，样式表按宿主的 `data-changed-files` 标记把卡片 `display: none`。数据层、组件树与普通会话都不动。
- **主面板标记按 app.asar 实测修正**：当前宿主里 `data-changed-files` 存在；主面板是 class 含 `mainPanel` 的节点，精确搜索 `data-slot="main"` 为 0 命中。定位顺序改为 `mainPanel` 优先，`data-slot="main"` 只作旧版兼容兜底；`mainPanel` 自身就是主列，不再取父 frame。
- **身份读同一份名单**：leader 会话 id 来自 `leaderSessionIndex`（`projects/list` 的 `leaderSessionId`），与标签栏、leader 视图入口同源；worker 与同目录的普通会话不在名单里。
- **挂载点与标签栏同构**：`shell.overlay` 里放一个不渲染内容的 anchor，订阅宿主的会话快照取主区域会话；宿主重渲染换掉主面板节点时用 MutationObserver 补回标记，节流口径与标签栏一致。观察器逻辑抽成 `watchLeaderChanges`，单测覆盖切会话摘旧标记、卸载 disconnect、清 timer。
- **只隐藏，不阻止渲染**：卡片仍然挂载，摘要请求照发。要连请求一起去掉只能全局关偏好或从组合里移除 `ui-deliverables`——那会一起拿走交付卡片、review tab 与行内文件链接，不接受。
- **宿主改标记即恢复显示**：`data-changed-files` 是宿主的实现细节，改版后卡片会重新出现。这是本仓期望的降级形态，不追宿主内部结构。

## Alternatives considered

- **全局关「显示代码工作视图」**：宿主官方开关，零改动，但轨迹视图与完整预设列表一起消失，影响所有会话。
- **profile patch 禁用 `ui-deliverables` 插件行**：只去掉四类表面，仍是全局，且宿主升级后要重新确认行 id。
- **让 leader 彻底不用文件工具**：改的是产品行为而不是展示；历史轮次与用户手动让 leader 写文件的场景仍会出现卡片。
- **注册同 id 的 turnTail 条目或卸载别人的注册**：slot 没有「按会话过滤」与「移除他人注册」的扩展点，替代写法只能是覆盖或伪造，比 DOM 标记更脆。

## Consequences

- **与宿主 DOM 契约耦合**：实际依赖 `mainPanel` 类名与 `data-changed-files` 标记；`data-slot="main"` 只是旧版兜底，记录在[已知限制](../../../../docs/limitations.md#客户端与宿主耦合)。
- **覆盖范围**：同页多个主面板只处理第一个；`display:none` 让卡片退出可访问树与 Tab 序，未做完整键盘序回归。
- **卡片只是不可见**：仍在 DOM 里，摘要路由仍会被调用；对看不见的卡片不做可访问性处理，也不影响搜索等按数据层工作的功能。
- **leader 自己改文件时也看不到这张卡**：那正是要隐藏的那张，不是漏网。

收益：leader 会话的收尾只剩正文与动作页脚，协调者的转录不再被自己的文件改动撑长；普通会话、交付卡片、review tab 与行内文件链接都不受影响。

## Testing

- 单测：`tests/leader-changes.test.js`（身份判定、标记加减、样式注入与幂等、切换主面板摘旧标记、observer disconnect、清 timer）与 `tests/main-panel.test.js`（`mainPanel` 优先、`data-slot` 兜底、`mainPanel` 自身为主列）。
- e2e：`tests/e2e/leader-changes.e2e.js` 用真实宿主 + 本地 mock，两段式起实例；断言 leader 会话的卡片节点在 DOM 里但 `isVisible()` 为 false、标记实际落在 `mainPanel` 节点、焦点不进入隐藏卡片；普通会话的卡片可见且不带标记。
- 双向验证：把隐藏判定强制为 false 后，e2e 红在「leader 会话的改动文件卡片应不可见」；还原后全绿。
