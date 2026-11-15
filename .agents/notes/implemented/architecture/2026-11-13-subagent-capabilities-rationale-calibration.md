# subagent 能力的重新校准

## 背景

用户实测后连续质疑三处论证：宿主 agent-team 的 worker 可以对话、有自动回报、leader 也能纠偏。逐条核对宿主源码与决策记录后确认文档论据已失效：rc.2 的只读判据只认 `address.mode === 'one-shot'`（continuable 子会话保留默认 composer）；continuable subagent 是 durable Session + 可回收 Activation，冷恢复是常规路径；completion notice 携带最终答案、结算后可 resume，原文没有「创建者在线时」的限定；`Agent.cancel(cause)` 能中止活动。原文档因此把三件「本 bundle 没做」或「宿主旧形态」的事写成了宿主架构性缺陷，会误导后续决策。

## 决策

1. **选根会话的理由改为形态与归属**：身份进项目树与看板、工具面在 `agent/created` 上按身份裁、存活到显式销毁，不受 subagent 树的 preset、`maxDepth` 与驻留回收约束。不再用「界面只读 / 结算即销毁」当论据。
2. **自动唤醒改为「重建 + 增强」**：宿主的 completion notice 只覆盖 subagent 树内的创建者，worker 是根会话够不着，所以本 bundle 订阅会话事件重建同一条路径，并多做落盘（父会话离线时下次启动补投）。
3. **worker 控制面改为准确表述**：`message_worker` 走 `steer`，能在 worker 下一步注入纠偏指令；没有中止手段，因为宿主的 `Agent.cancel()` 没被接成工具——这是本 bundle 的缺口，不是宿主能力缺失。

## 边界

- **one-shot 地址的 subagent 仍只读**：`selectReadOnlySubagent()` 的判据仍成立；被推翻的是「所有 subagent 都只读、都无法常驻」这一推广。
- **本轮只改文档与笔记，不改代码**：是否补 `cancel_worker` 工具另行决策。
- **能力判断要落在 `engines.dsh` 下限上**：引用宿主新能力时必须核对该版本是否具备，不能只按本机最新版下结论。

## 验证

`npm run check` 全绿（文档预算、工具名比对、笔记格式门禁）。能力四条按 `dsh-v0.2.1-rc.2` 逐条核对；全仓 grep 旧说法（「界面只读 / 结算即销毁 / 原生缺失」）无残留，`docs/`、协议层 skill 与 README 中英两份一并改掉。
