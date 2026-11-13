# subagent 能力的重新校准

**范围**：`docs/architecture.md`、`docs/limitations.md`、`docs/capability-gaps.md`、`2026-10-29-worker-as-root-session.md`

## 背景

用户实测后连续质疑三处论证：宿主 agent-team 的 worker 可以对话、有自动回报、leader 也能纠偏。逐条核对宿主源码与决策记录后确认文档论据已失效：

- **可对话**：rc.2 的 `packages/client/ui-subagent/src/client/index.ts:41` 只把 `address.mode === 'one-shot'` 判只读，`:45` 的注释写明 continuable 子会话保留默认 composer——「所有 subagent 都只读」不成立。`2026-10-22-subagent-target-user-controls.md` 记录了更彻底的直接寻址（浏览器 prompt 与 `interruptByUser`），但它 2026-10-22 才加入、晚于 rc.2（10-17），**下限版本上不能引用**。
- **可常驻、可冷恢复**：`2026-07-28-continuable-subagent-conversations.md`——continuable subagent 是 durable Session + 可回收 Activation，冷恢复是常规路径。
- **有自动投递**：`packages/subagent/tool-subagent/README.md:61` 的 completion notice 携带最终答案、结算后可 resume，`:96` 的 `startActivation()` 可选 parent delivery；`subagent-codex/README.md:158` 的「may wake another turn」。原文**没有**「创建者在线时」这个限定——最接近的 `packages/subagent/subagent/src/manager.ts:502` 的 `assertLiveParent` 是启动准入，不是投递条件。
- **可中止**：`packages/core/agent/README.md:47` 的 `cancel(cause)` aborts the active activity，除非 `keepInbox` 会清空 pending work。

原文档因此把三件「本 bundle 没做」或「宿主旧形态」的事写成了宿主架构性缺陷，会误导后续决策——让读者以为用根会话必须放弃控制面与自动回报。

## 决策

1. **选根会话的理由改为形态与归属**：身份进项目树与看板、工具面在 `agent/created` 上按身份裁、存活到显式销毁，不受 subagent 树的 preset、`maxDepth` 与驻留回收约束。不再用「界面只读 / 结算即销毁」当论据。
2. **自动唤醒改为「重建 + 增强」**：宿主的 completion notice 只覆盖 subagent 树内的创建者，worker 是根会话够不着，所以本 bundle 订阅会话事件重建同一条路径，并多做落盘（父会话离线时下次启动补投）。
3. **worker 控制面改为准确表述**：`message_worker` 走 `steer`，能在 worker 下一步注入纠偏指令；没有中止手段，因为宿主的 `Agent.cancel()` 没被接成工具——这是本 bundle 的缺口，不是宿主能力缺失。

## 边界

- **one-shot 地址的 subagent 仍只读**：`selectReadOnlySubagent()` 对 `address.mode === 'one-shot'` 的判据仍成立，原笔记背景段对这一路径没有被推翻；被推翻的是「所有 subagent 都只读、都无法常驻」这一推广。
- **本轮只改文档与笔记，不改代码**：是否补 `cancel_worker` 工具另行决策，不混进这次修正。
- **能力判断要落在 `engines.dsh` 下限上**：本仓支持 `>=0.2.1-rc.2`，引用宿主新能力时必须核对该版本是否具备，不能只按本机最新版下结论。

## 验证

- `npm run check` 全绿（文档预算、工具名比对、笔记格式门禁）。
- 逐条对照宿主源码与笔记核对上述四条证据，行号按 `dsh-v0.2.1-rc.2`（本仓下限）。
- 下限核对：rc.2 的只读判据在 `ui-subagent/src/client/index.ts:41` 只认 `one-shot`，continuable 保留 composer（`:45` 注释）——`architecture.md` 的「浏览器可直接对话」因此在 rc.2 上成立；`2026-10-22-subagent-target-user-controls.md` 不在该版本，正文只把它当更晚能力的旁证并加了限定词。
- 全仓 grep「换不来 / 原生缺失 / 只能请人 / 界面只读 / 结算即销毁」无残留：`docs/` 已清，`.agents/skills/leader-mode/`（`SKILL.md` 与 `playbooks/program.md`）与 README 中英两份的四处旧说法这次一并改掉。
