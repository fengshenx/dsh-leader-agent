# Agent Note: 文档预算的余量上限

## 背景

standing docs 的体量门禁只判 `units <= ceiling`，天花板只升不降：`README.md` 3,506 / 3,018（16.2%）、`README_ZH.md` 5,250 / 4,508（16.5%）、`SLOTS.md` 900 / 649（38.7%）。余量一旦被「留够再说」抬高，就不再约束体量——下一次改动可以先把文档写胖 16% 才撞线，而门禁仍显示绿色。

## 决策

### 超过 12% 余量报 `loose`

`checkBudgets()` 增加状态 `loose`：`ceiling / units > 1.12` 即报红，CLI 以 1 退出。状态优先级为 `bad-ceiling` / `missing` → `over` → `loose` → `ok`：前两者是清单结构错误，`over` 已经说明天花板不够，不再重复报余量过大。

### 建议值按 5% 余量、并被 12% 上限夹住

`recommendedCeiling(units)` 取 `min(ceil(units × 1.05), floor(units × 1.12))`，`units > 0` 时结果天然 ≥1。通常就是当前值 + 5%；`units` 小于 9 时两个约束之间没有整数解，取能落地的较小值。`units` 为 0 的文档直接判 `ok`：空文档既不占预算也不会囤配额，若判 `loose` 建议值永远不收敛。失败文案与 `--list` 行都带上建议值。

### 三篇旧天花板按当前值重设

`README.md` 3,506 → 3,177、`README_ZH.md` 5,250 → 4,744、`SLOTS.md` 900 → 682。这是「重设天花板」不是「压缩文档」，三篇正文的改动只有指向新技能的链接说明。同一 PR 按 10% 约定把 `AGENTS.md` 4,280 → 4,350（3,954 的 10.0%，不是抬价）。

## 边界

- 12% 判的是余量，不是文档质量：一篇内容已经过时的短文照样可以 `ok`。
- 不把 5% 与 12% 做成配置项：分层规则在 AGENTS.md，配置化会让每个任务自己挑阈值。
- 小文档的整数解问题只保证不崩、建议值可落地，不承诺同时满足 5% 与 12%。
- 只有 standing docs（根目录与 `docs/`）受管；`.agents/notes/` 与 `.agents/skills/` 仍不设预算。

## 验证

- `tests/doc-budget.test.js` 新增 6 条：正好 12% 为 ok、略超报 loose 并给 105、建议值 3169、空文档判 ok 与 units=1 的极端路径、bad-ceiling / missing / over / loose 的优先级、`loose` 输出行；真实清单用例从「文件存在」扩到「当前读数全 ok」。
- 双向验证：`README.md` 天花板 3,177 → 4,000 → `LOOSE 3025 / 4000 README.md → 建议 3177`、`verify-doc-budgets` 退出 1、单测 15 / 1 红、`npm run check` 在文档预算一步红；还原 3,177 → 16 / 16 绿、check 全绿（1,069 用例通过、17 跳过）。
- 当前读数：`AGENTS.md` 3,954 / 4,350、`README.md` 3,025 / 3,177、`README_ZH.md` 4,518 / 4,744、`SLOTS.md` 649 / 682，余量均 ≤ 12%；13 篇 standing docs 全绿。
