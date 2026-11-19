# Agent Note: 用 oxlint 补上 lint 门禁

Status: implemented

## Problem

本仓只有 `node:test`，没有 lint：未使用的 import、死代码、拼写错误都抓不到，改完靠手扫。`src` 约 2.1 万行、`tests` 约 2.3 万行，手扫成本随体积上升。这不是 dsh 的限制——插件就是普通 npm 包，lint 装在 `devDependencies`，宿主加载时完全不参与。

## Decision

- 用 oxlint 1.94.0，精确锁版本：lint 门禁的读数要可复现，`^` 会让新 minor 自带的新规则在别人的 PR 上变红。
- `npm run lint` 覆盖 `index.js src tests scripts build .agents/skills`，与 `check-syntax.mjs` 的 `ENTRIES` 对齐并加 `tests`；判据是 `--deny-warnings`——oxlint 默认 warning 退出码为 0，不开等于没门禁。
- 配置在 `.oxlintrc.json`：忽略 `lib/`、`node_modules/`、`.worktrees/`、`.dev/`、`growing/**/dist`；`no-unused-vars` 用 `^_` 前缀约定忽略 `vars` / `args` / `caughtErrors`。
- 先清 23 条基线：7 条真实未使用直接删；3 条 `_` 前缀 catch 参数靠配置忽略；4 条集合/Map 快照的 spread 改成 `Array.from`（保持先快照语义），1 条冗余的外层对象 spread 直接去掉；6 条 `?? {}` 空回退删掉（对象展开 null/undefined 本来就是 no-op）；2 条刻意的控制字符正则在行内 disable 并写原因。
- `npm run check` 第一段跑 lint；`.oxlintrc.json` 不在 `files`，不随包发布。

## Consequences

未使用的 import、死代码与大部分笔误在本地和 CI 的 `npm run check` 第一段就拦住，不再依赖人工。`npm run check` 多约 10ms；新增一个 devDependency，`THIRD_PARTY_LICENSE` 的工具表随之增加一行。不开 `import/no-unresolved`（`react` 与 `@deepseek-ai/dsh-*` 来自宿主冻结模块表，开了必误报），也不 lint `lib/` 构建产物与 `growing/` 素材脚本。

收益：手扫从「每次改完通读」变成「只处理 lint 没覆盖的语义与拼写」。

## Alternatives considered

- **ESLint**：生态最全，但要自带 parser、插件与一套配置，依赖与启动成本都高于本仓需要；否决。
- **Biome**：lint + formatter 一体，但会引入全仓格式化噪音，与「不跑全仓 `--fix`」的边界冲突；否决。
- **放宽成 `--max-warnings=0`**：与 `--deny-warnings` 等价，但后者直接表达「warning 也算失败」；选 `--deny-warnings`。
- **保留 `?? {}` 空回退、给快照 spread 加 disable**：两者都能变绿，但前者是死代码，后者把真实语义藏进 disable；只有确属刻意的控制字符正则才 disable。

## Testing

- `npm run lint`：0 warnings / 0 errors。
- `npm run check` 全绿：lint 段在前，Agent Note 格式、文档工具名、文档预算、语法、许可与覆盖率门禁一并通过。
- 双向验证：给 `scripts/check-syntax.mjs` 临时加未使用的 `tmpdir` import，`npm run check` 在 lint 段退出 1；还原后全绿。
- `npm pack --dry-run` 确认 `.oxlintrc.json` 不在包内。
