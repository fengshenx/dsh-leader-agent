# Agent Note: 文档预算的最小余量门禁

**范围**：`scripts/doc-budget.mjs`、`scripts/verify-doc-budgets.mjs`、`scripts/doc-budgets.json`、`docs/development.md`、`docs/e2e-testing.md`

## 背景

`verify-doc-budgets` 此前只判一件事：超没超天花板。余量是规矩（AGENTS.md 要求 ≥5%，`AGENTS.md` 与 `capability-gaps.md` ≥10%），但没有任何机械判定——#77 / #81 / #85 / #89 / #93 / #102 / #104 都出现过「余量 4.3%–4.9% 照样全绿」，每次都要在下一个 PR 里临时搬内容或抬天花板，抬完又立刻贴线。

本次动手时 `docs/development.md` 是 2530 / 2660。两种余量口径给出相反结论：

- **按实际值**（`ceiling / units - 1`）：5.14%，合格；
- **按利用率**（`1 - units / ceiling`）：4.89%，不合格。

同一份数据两种读法，正是这条规矩反复失守的原因。

## 决策

### 余量按实际值算，门槛 5% / 10%

取 `ceiling / units - 1`：它回答「还能再写多少字」，是改文档时真正需要的数。利用率在天花板刚抬完时永远接近 100%，看不出还剩多少空间。

- 普通文档 5%，`AGENTS.md` 与 `docs/capability-gaps.md` 10%（每个任务都要改的两份）——名单常量在 `doc-budget.mjs` 的 `STRICT_HEADROOM_PATHS`，测试与门禁共用一处来源。
- 比较用整数：`ceiling >= ceil(units * (100 + pct) / 100)`。浮点下 `2000 * 1.05` 会算成 `2100.0000000000002`，正好 5% 的会被误判成贴线。
- 新增状态 `tight`，与 `over` / `missing` / `bad-ceiling` 并列。余量不足不再混进 `ok`。

### 违例要直接给出该抬到多少

`checkBudgets` 每项带回 `headroom` 与 `recommended`（`recommendedCeiling`），门禁输出：

```
docs/development.md: 2530 / 2600，余量 2.77%，要求 ≥5%——抬到 2657，或压到 2476 个单位以内
```

`maxUnitsFor` 是 `recommendedCeiling` 的反函数（同一 ceiling 下允许的最大体量），两条路一起给，省掉自己算。

### 本次抬的两处天花板

- `AGENTS.md` 4280 → 4350：本 PR 在分层节补了「多余量也会红」的规矩（3899 单位），按 10% 需 4289；留到 4350 是因为这份每轮都在改。
- `docs/development.md` 2660 → 2790：补了文档体量门禁的说明（2630 单位），按 5% 需 2762。

`docs/architecture.md`（5315/5600）与 `docs/capability-gaps.md`（15091/16800）按新口径都已达标，但按利用率分别只有 5.09% 与 10.17%，同样贴线——本 PR 不扩面，留着下一轮处理。

## 边界

- 只判体量，不判内容质量；能不能搬到别的层、值不值得留，仍要人判断。
- 天花板没设或不是正整数时只报 `bad-ceiling`，不叠报 `tight`——配置错与贴线是两回事。
- 空文件（`units === 0`）任何正天花板都够，余量按正无穷处理，不做除零。
- 不动 `--list` 的输出格式：贴线与否只在失败路径报，正常路径保持一行一篇的好读性。
- 不自动抬天花板：门禁只给建议值，抬不抬、抬多少由 PR 作者写明理由。

## 验证

- 单测 `tests/doc-budget.test.js` 18 例（新增 7 例）：5.00% 绿 / 4.99% 红；`AGENTS.md` 10.00% 绿 / 9.99% 红；`capability-gaps.md` 同门槛；空文件不除零；`bad-ceiling` 不叠报 `tight`；`recommendedCeiling` 抬到恰好绿、少一个单位就红（四组边界含 1 与 7 这种小值）；`headroomOf` 与实际值口径一致、与利用率口径可区分；`formatBudgetRow` 的 `TIGHT` 标签。
- 真实清单用例：读全部 standing docs 现算体量，任一篇余量不足即红——这条是本 PR 的永久回归，替代人工核对。
- 双向验证一（撤判定）：把 `checkBudgets` 的 tight 分支改回 `units <= ceiling ? 'ok' : 'over'`，4 例红（判定分档、5% 边界、10% 边界、建议值边界）；还原后 18 例全绿。
- 双向验证二（真实数据）：临时把 `doc-budgets.json` 的 `docs/development.md` 改成 2600，真实清单用例红，门禁输出 `2530 / 2600，余量 2.77%，要求 ≥5%——抬到 2657，或压到 2476 个单位以内`；还原后全绿。
- 现状读数：13 篇 standing docs 余量全部达标。按实际值最低的是 `docs/architecture.md` 5.36%，按利用率最低的也是它（5.09%）。
