# Agent Note: 文档预算的余量上限

Status: implemented

## Problem

standing docs 的体量门禁只判 `units <= ceiling`，天花板只升不降。余量一旦被「留够再说」抬高就不再约束体量：下一次改动可以先把文档写胖一成多才撞线，而门禁仍显示绿色。

## Decision

- **超过 12% 余量报 `loose`**：`ceiling / units > 1.12` 即报红、CLI 以 1 退出。状态优先级是 `bad-ceiling` / `missing` → `over` → `loose` → `ok`：前两者是清单结构错误，`over` 已说明天花板不够，不再重复报余量过大。
- **建议值按 5% 余量、并被 12% 上限夹住**：`recommendedCeiling(units)` 取 `min(ceil(units × 1.05), floor(units × 1.12))`，通常就是当前值 + 5%；`units` 小于 9 时两个约束之间没有整数解，取能落地的较小值。`units` 为 0 的文档判 `small`（非失败，下界豁免；下界规则见 [文档预算门禁的 5% 下界](2026-11-21-doc-budget-floor.md)）——空文档既不占预算也不会囤配额，判 `loose` 则建议值永远不收敛。失败文案与 `--list` 行都带建议值。
- **旧天花板按当前值重设**：这是「重设天花板」不是「压缩文档」，正文只顺带改指向新技能的链接说明；`AGENTS.md` 按每个任务都要改的那档惯例同步重算。

## Alternatives considered

- **只判 `units <= ceiling`、天花板只升不降**：余量一旦抬高就不再约束体量，下次可以先写胖一成多才撞线；超过 12% 报 `loose`。
- **把 5% / 12% 做成配置项**：每个任务会自己挑阈值；规则固定在 `AGENTS.md`。
- **同时报 `over` 与 `loose`**：`over` 已经说明天花板不够，再报余量是重复；`over` 优先。
- **建议值直接取当前值**：没有余量，下次一改就红；按 5% 建议、被 12% 上限夹住。

## Consequences

- 12% 判的是余量，不是文档质量：一篇内容已经过时的短文照样可以 `ok`。
- 不把 5% 与 12% 做成配置项：分层规则在 `AGENTS.md`，配置化会让每个任务自己挑阈值。
- 小文档的整数解问题只保证不崩、建议值可落地，不承诺同时满足 5% 与 12%。
- 只有 standing docs（根目录与 `docs/`）受管；`.agents/notes/` 与 `.agents/skills/` 仍不设预算。

收益：文档预算不只知道「超没超」，还知道余量是不是被抬得过大，天花板不会越留越松。

## Testing

`tests/doc-budget.test.js` 覆盖正好 12% 为 ok、略超报 `loose` 并给出建议值、空文档与极端路径、状态优先级；把某篇天花板临时抬高即报 `LOOSE … → 建议 <当前值>` 并让 `npm run check` 在文档预算一步红，还原后全绿。
