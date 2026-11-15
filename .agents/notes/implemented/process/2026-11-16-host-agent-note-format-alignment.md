# Agent Note: 笔记格式与门禁对齐宿主

Status: implemented

## Problem

本仓的笔记格式是自定的中文四节（`## 背景` / `## 决策` / `## 边界` / `## 验证`），门禁也按这套判：路径是状态的唯一来源，不写 `Status:`，不强制备选节。宿主（`scripts/verify-agent-note-format.ts`）的格式是 `# Agent Note: <title>` + 第 3 行 `Status:` + 首节 `## Problem` + 按 lifecycle 的英文必需节 + 强制 `## Alternatives considered`。两套骨架并存时，从宿主笔记迁过来的决策要重排，门禁也判不了「这篇有没有真的记录备选」。本仓 93 篇全部晚于宿主 `FORMAT_ADOPTED`（2026-07-05），没有历史豁免问题。

## Decision

- **完整对齐宿主骨架**：第 1 行 `# Agent Note: <非空标题>`，第 2 行空行，第 3 行 `Status:`，第 4 行空行；首节 `## Problem`；`implemented` 要 `## Decision` + `## Consequences`，`proposed` 要 `## Proposal` + `## Acceptance criteria` + `## Risks`，`rejected` 要 `## Proposal`，`archived` 沿用 implemented 骨架。
- **`Status:` 与路径双写**：`proposed` / `implemented` / `rejected — <理由>` 按 lifecycle 精确匹配；`archived` 写 `Status: implemented`。全文件只能有一条 `Status:`，且必须就是第 3 行。
- **`## Alternatives considered` 每个 lifecycle 都必需**：不再接受「`## 边界` 已承载放弃了什么」。确实没有记录过的，写一条默认替代并标注「（原文未记录，本次补记）」；本轮只有 `windows-desktop-no-home` 一篇用到该标记。
- **implemented 禁提案期节名**：`## Proposal` / `## Plan` / `## Migration plan` / `## Acceptance criteria` 大小写不敏感、按词边界拦；`proposed` 里允许。
- **不实现祖父注释**：宿主给 2026-07-05 之前的笔记留了 `<!-- agent-note-format: alternatives-not-recorded ... -->` 豁免；本仓 93 篇全部晚于该日期，没有符合条件的历史笔记，加注释只会给新笔记留后门。
- **保留本仓更强的检查**：路径双轴与 class 闭集、文件名 `YYYY-MM-DD-<english-slug>.md`、真实日期、唯一 H1 且必须是第一行、节名不重复、`.md` 链接可达、围栏识别（``` / ~~~ / 最多三格缩进）。
- **旧决策加指针、不改写**：`2026-11-02-agent-note-format-gate` 的「不照搬宿主骨架」、`2026-11-03-agent-note-lifecycle-and-class` 的「不写 Status」「不强制备选」、`2026-11-16-agent-note-supersession-and-corpus-audit` 的「Status 只拦不写」均已加取代指针；旧结论保留为当时的记录。
- **机械部分脚本化、内容人工写**：93 篇一次性补头部、改节名、插 `## Alternatives considered` 与收益句；`Alternatives` 优先从原文的「放弃 / 而不是 / 否决」还原，收益句按该篇 Decision 写，不用模板套话。

## Alternatives considered

- **保留中文四节，只翻译成英文**：每篇仍要重写，且与宿主的节序、Status、备选节都不一致；对齐后两边的笔记可以按同一骨架读。
- **只改门禁、不迁移语料**：门禁一开就会红 93 篇；半对齐的格式既不能读宿主笔记，也不能证明本仓语料合规。
- **给旧笔记加宿主祖父注释**：本仓没有 2026-07-05 之前的笔记，注释没有适用对象；留着等于给新笔记一条「不写备选」的后门。
- **保留「不写 Status」**：与宿主格式直接冲突，门禁也无法交叉校验路径与状态；双写并由门禁判一致，比单写路径更可验证。

## Consequences

- **93 篇全部重写**：头部多 3 行、每篇多一个 `## Alternatives considered` 与一句收益，笔记总量从 2,641 行涨到 3,729 行；这是对齐宿主的固定成本。
- **旧规则被推翻**：「不写 Status」「不强制备选」不再成立；旧笔记靠指针保留可读历史，不把旧结论改写成相反结论。
- **收益句是人工写的**：门禁只能判节在不在、Status 对不对，判不了备选是不是真的被考虑过、收益句是不是套话；1 篇补记已标注，评审仍要读内容。
- **archived 仍是 0 篇**：映射沿用 implemented 骨架，没有单独的归档格式与冻结门禁；将来真归档时再补。
- **没有祖父注释**：靠日期条件本身挡住旧笔记，不引入豁免通道。

收益：本仓与宿主的 Agent Note 用同一套头部、节名与备选节，门禁能双向验证，读笔记的人不用在两套骨架之间切换。

## Testing

`tests/agent-note-format.test.js` 覆盖 9 条新检查与既有路径/围栏/链接；逐条撤掉检查→对应用例变红→还原→全绿，9 条全部双向。`npm run check` 全绿：94 篇笔记（proposed 1 / implemented 93）、1125 用例通过、15 篇 standing docs 在预算内；笔记总量 3,729 行。仓库语料用例 `仓库现有笔记全部合规（含链接可达）` 直接读 `.agents/notes/`，漏一篇或断一条链接都会红。
