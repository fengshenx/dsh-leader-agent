# Agent Note: 文档预算门禁的 5% 下界

Status: implemented

## Problem

门禁只判「有没有超过天花板」和上限 [`loose`](2026-11-04-doc-budget-headroom-cap.md)（`ceiling / units > 1.12`），余量低于 5% 仍然 `ok`。`docs/development.md` 4.75%、`docs/usage.md` 4.98% 时 `npm run check` 全绿；下一次改一行就撞线，或者逼着改的人随手抬天花板。规则一直写的是 5–12%，但下界没有门禁。

## Decision

- **低于 5% 判 `tight`**：`units >= 9` 且 `ceiling / units < 1.05` 时计入失败，CLI 退出 1。输出行与失败文案都带当前值、天花板、余量百分比、`压到 N` / `抬到 M`；状态优先级为 `bad-ceiling` / `missing` → `over` → `loose` → `tight` → `small` → `ok`。
- **5.0% 是边界**：`ceiling / units = 1.05` 不报；`1.12` 仍不报，`> 1.12` 仍报 `loose`，上限行为不变。
- **9 个单位以下标 `small`（下界豁免）**：没有整数天花板能同时满足 5% 与 12%，硬判会把小文档送进死循环；输出 `SMALL` 与「<9 单位，下界豁免」，不计入失败，`--list` 与成功/失败文案都能看到。
- **warning 先跑，再升级 error**：临时 warning 口径列出 2 篇贴线文档；两篇都只差几个单位，抬天花板即可回到区间，清单 ≤3 且不扩张内容。于是把 `docs/development.md` 3000 → 3008、`docs/usage.md` 7400 → 7402，同 PR 清完并让 `tight` 计入失败。5–12% 的规则本身不动。

## Alternatives considered

- **长期保留 warning、不升级**：清单清完后没有已知贴线文档，warning 会长期沉默；Issue 要的是门禁能拦住，warning 不改变退出码。清完再升级，避免「一半红一半绿」。
- **不做体检直接报红**：会留下 2 篇红文档，PR 无法全绿；先列出清单再处理。
- **把 5% 做成配置项**：每个任务会自己挑阈值；规则固定在 `AGENTS.md`，与 12% 一样不做配置。
- **`units < 9` 也报 `tight`**：整数解不存在，建议值无法落地；改为标 `small`，让豁免可见但不失败。

## Consequences

- 两篇旧文档只重设天花板，正文不动；`--list` 21 篇全 `ok`，`docs/development.md` 2864/3008、`docs/usage.md` 7049/7402。
- 新增文档仍按 5% 余量登记；贴线时失败文案给出压缩与抬天花板两个方向。
- `units < 9` 的小文档标 `small`，`--list`、成功与失败文案都能看到豁免来源，不是静默跳过。
- 收益：5–12% 的两端都由门禁兜住，贴线文档不会静默通过。

## Testing

`tests/doc-budget.test.js` 覆盖 4.x% → `tight`、5.0% → `ok`、12.0% → `ok`、>12% → `loose`、8/8 → `small`，以及 `100000 / 104999` 显示 `4.99%` 而不是 `5.00%`；`runBudgetGate` 用 100 单位的 4% / 5% / 12% / 13% 与 8/8 夹具验证 CLI 的退出码、`SMALL` 标记和 `余量 4.00% 低于 5%`、`压到 99`、`抬到 105`。`npm run check` 全绿。
