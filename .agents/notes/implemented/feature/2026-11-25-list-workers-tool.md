# Agent Note: list_workers 名册与模型核对

Status: implemented

## Problem

worker 的模型选择（[见](2026-11-25-worker-model-selection.md)）在派工回执里报一次、在失败通知里再报一次，此外没有任何入口：项目树只在浏览器侧，模型看不到；`list_worker_models` 列的是可用目录，不读具体 worker 的会话。派工之后想核对某个 worker 跑在什么 route 上、还有哪些 worker 可以复用，只能翻自己的历史或凭记忆。人在 worker 会话里用模型选择器改过模型时，回执里的旧值也不会跟着变。

## Decision

- 新增 leader-only、只读的 `list_workers`：列调用方 leader 派出的未归档 worker，按最近使用排序，给出会话 id、名字、模型与 effort（带来源）、是否在跑、挂着的未完成卡与最后使用时刻。不唤醒 worker、不产生模型调用。
- 归属按 `parentSessionId` 精确匹配，与 `message_worker` 的投递校验同口径：列出来的每条都能直接续聊，不制造「看得见、投不进」。
- 模型优先读活 agent 的当前选择（`model.current` → 会话 `model/selection` → 请求头 → `agent.options`），读不到才回落到登记表里建会话时落盘的 `agentOptions`。后者也是冷恢复还原的 route；活会话换过模型时标来源「当前会话」，不把后来的 route 说成派工时选的。
- 归档集合读不到时不假装完整：列出登记表全部并明说可能含已归档会话；卡绑定提供方缺失时省略挂卡行。旧登记没有模型记录时显示「未记录」，不拿部署默认冒充。
- 名册渲染成文本，空名册给出下一步；工具面归入 `LEADER_ONLY_TOOLS`，worker 与普通会话都拿不到。

## Alternatives considered

- **扩展 `read_worker_session` 的表头**：能看单条但每次都要先知道 sessionId，无法回答「有哪些 worker」；盘点要先有清单。
- **给 `list_worker_models` 加 `sessionId`**：把「目录」与「实例状态」两种事实混进一个工具，参数形态也会让模型在两种语义间犹豫。
- **只在前端项目树加模型列**：leader 是模型，看不到前端；用户的核对需求与模型决策需求是两条通道。
- **永远读活 agent**：冷 worker 不在内存时没有 agent，必须回落到登记表；只读活表会把大部分历史 worker 显示成未知。
- **永远读登记表**：会漏掉人在会话里手动换过的 route；活会话的当前值才是「现在跑在什么上」。
- **按项目 leader 集合（含退役 leader）过滤**：名册会列出调用方投不进去的 worker；精确父会话与投递门禁一致更安全。

## Consequences

- 模型是尽力而为的读数：旧登记、登记落盘失败或活会话读不到时可能是「未记录」；`list_workers` 不读会话日志，不会为补一个旧值付出 O(N × 文件体积) 的代价。
- 名册只覆盖未归档、且由当前 lead 派出的 worker；跨项目与别的 leader 的工人不可见，也不该可见。
- 本次改动触及五份接近 5% 余量下界的文档（README 两份、LEADER.md、limitations、usage），天花板按当前值各留约 8% 余量重设；原因都是新增工具行/段落，不是扩写既有内容。
- 收益：leader 能在不唤醒任何 worker 的前提下盘点名册、核对每个 worker 的实际 route，并据此决定续聊、换模型重派或新派工。

## Testing

`tests/list-workers.test.js` 钉住渲染（模型/effort/来源、未记录、在跑、挂卡、空名册与归档未知提示）与工具装配；`tests/dispatch.test.js` 钉住父会话过滤、归档过滤、最近使用排序、活 agent 覆盖登记表、逐会话卡读取回退与身份拒绝；`tests/tool-gate.test.js` 钉住只给 leader，`tests/doc-tool-names.test.js` 钉住文档可引用。双向：把 `list_workers` 从 `LEADER_ONLY_TOOLS` 删掉 → tool-gate 用例红；把活 agent 选择改回只读登记表 → dispatch 的 live 覆盖用例红；均还原后全绿。
