# 槽位圆点的状态来源与保留失败的处理

**状态**：implemented（2026-10-28）
**范围**：`src/client/board.js`、`src/client/slot-retain.js`、`tests/slot-retain.test.js`、`README.md`、`docs/e2e-testing.md`

## 背景

用户反馈「Card 上无法展示 sub agent 正在 running 的状态——槽位小圆点不亮」。

查下来是三件事叠在一起：

1. 面板所在的 `sidebar.right.pane.tab` 座只注入 `tabInfo`，**不提供 `useSessionStatus`**（宿主 `packages/client/ui-sidebar-right/src/client/index.ts:219`）。运行态的唯一来源因此只剩保留会话的快照，而 README 与 JSDoc 写的是「运行态取宿主的会话状态存储」，文档超前于实现。
2. `SlotRetention` 里两处 `catch` 是空的：`retain()` 抛错直接 `return`，`reference.ready` reject 是 `.catch(() => {})`。宿主对不认识的会话同步抛 `sessions.retain: unknown session <id>`，界面上只表现为一个空心虚线圈（`-unknown` 档是 `background: transparent; border: 1px dashed`），没有日志就无从定位。
3. 同步效果的依赖里带着 `getSessions`，而它是槽位注入的 `() => ctx.sessions`，每次渲染都是新函数。失败条目不写入 `entries`，于是每次渲染都重试一次保留，形成抛错循环——实测每 2–4 秒一条，与 `BOARD_REFRESH_MS = 2000` 的轮询重渲染对得上。

## 决策

**子代理会话用地址形式保留**。`SubagentAddress = { parentSessionId, childSessionId, mode }`。worker 的子会话 id 是裸 uuid，在客户端会话目录里没有独立条目，`sessions.retain(id)` 认不出来。`retainTargetOf()` 先问 `sessions.subagentAddress(id)`，宿主不给就用建卡会话补一个 `mode: 'unknown'` 的地址。模式只影响宿主怎么配置子代理，不影响能否认出会话。

**父会话取卡片自己的 `createdBy`，不猜看板所属会话**。worker 由建卡的会话派出，`store.js` 建卡时就把 `exec.agent.id` 写进 `createdBy` 了，只是之前没人读。看板所属会话在跨项目聚合时是错的，用它当父会把地址挂错地方。卡片没记建卡会话时才退回看板所属会话。

**保留失败必须报告，且同一会话只报一次**。失败条目仍不写入 `entries`（语义是该槽位状态未知），但经 `onError` 报一条带会话 id 与原始错误的日志。`reported` 集合去重——不去重的话，每次 `needed` 变化都会重报一遍，日志同样被淹没。

**同步效果的依赖只留 `needed`**。取值本来就走 `latest` 这个 ref，`getSessions` 进依赖没有任何作用，只会把重试风暴放大。

**「等你输入」「未读」两档在这条路径上无从表达，就如实收窄**。不去伪造一个能表达的来源；README 与模块 JSDoc 都改成「执行中与上次执行失败成立，等你输入与未读无从表达」。

## 验证

- `npm run check`：333 例全绿（原 328 + 5 新增）。
- 回归有效性双向验证：撤掉 `report()` 的去重 → 两条「只报一次」用例变红；把兜底地址的 `mode` 改成 `'one-shot'` → 地址用例变红；还原后全绿。
- 真机取证（隔离实例 + mock provider，流程见 `docs/e2e-testing.md`）：
  - 槽位绑一个裸 uuid 子会话（历史 worker `280b838a-…`）时，修复后圆点从 `unknown`（透明虚线圈）变成 `idle`（实心 `rgb(129, 133, 140)`），控制台无失败报告——地址回退生效。
  - 槽位绑一个正在跑的会话时，圆点从 `idle` 推到 `running`（琥珀 `rgb(245, 158, 11)`），持续整个 40 秒运行窗口，无失败日志——快照 `running` → 圆点档位的链路成立。
  - 宿主侧依据：`agent/status` 事件用 `agent.id` 广播 `api-session/status`（`packages/api/session-controller/src/index.ts:225-227`），子代理的 agent 走同一条广播，不区分主会话与子会话。

## 未覆盖

「子代理槽位 + 子代理同时在跑」这一组合没有同框实测：子代理会话在侧栏被官方树隐藏，没法从 UI 打开它去触发运行；而要用协调者工具唤醒 worker，必须让整个派工流程在一个新会话里重跑一遍。上述两段分别证明了地址回退成功、以及快照运行态能推亮圆点，宿主源码证明了广播不分主次。
