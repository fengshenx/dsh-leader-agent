# Agent Note: README 默认改中文，补 worker 模型能力

Status: implemented

## Problem

仓库的文档、提交信息与协议层都用中文，README 却以英文为默认：GitHub 仓库页、npm 包页与落地页的入口把中文读者送到英文版，中文版只是 `README_ZH.md` 的二级入口。同时 `spawn_worker` / `message_worker` 已支持给 worker 指定与切换模型（槽位默认、`list_worker_models` 查 route），README 亮点与使用手册还停在旧口径，读者看不到这条能力。

## Decision

- **默认中文**：中文放进 `README.md`，英文移到 `README_EN.md`，两版顶栏互切；GitHub 仓库页与 npm 包页默认展示中文。指向 `README_ZH.md` 的文档链接、`package.json` 的 `files`、发布包清单测试与文档预算清单同步改名，不保留 `README_ZH.md` 兼容文件。
- **亮点补一条**：在「编排规则写进两份文件」之后加「每个 worker 用合适的模型」，一句话覆盖派工选模型、槽位默认、续聊切换与 route 查询；后续编号顺延，两版同位置同步。
- **使用手册补一节**：`docs/usage.md` 新增「给 worker 选模型」，写清三个来源的优先级、`provider/model` 与裸模型 id 的解析、`effort` 回落、route 查询与拒绝场景（预检失败、读不到 worker 当前 route）；续聊切换与换卡/换槽位重选的规则也落在这一节。
- **预算与入口同步**：`scripts/doc-budgets.json` 的键改名（README 3660、README_EN 2370、usage 2250），落地页的「Full README」改指英文版、中文入口继续指 `README.md`；[README 改成亮点优先](2026-11-02-readme-highlights-first.md) 里的「英文默认」加取代指针。

## Alternatives considered

- **只把中文内容换进 `README.md`，保留 `README_ZH.md` 放英文**：文件名与内容对不上，后续链接维护者会持续误读；改为 `README_EN.md`。
- **保留 `README_ZH.md` 作为跳转壳**：仓内没有对外承诺这个路径，壳文件还会被文档枚举与预算当成又一篇 standing doc；直接改名。
- **README 只改中文、英文版不同步**：双语漂移是既有成本，两版同级与章节对应仍是既定约束；英文版同位置补同一条。
- **模型说明只留在 limitations 或协议 skill**：这是用户可见操作（怎么指定、怎么查、何时被拒），归属是 usage；limitations 只留快照边界。

## Consequences

- 中文成为默认入口，英文读者多一次点击；外部若直接引用 `README_ZH.md` 会 404（仓内没有对外承诺）。
- usage 天花板从 1990 抬到 2250（当前 2127，余量 5.8%）：新增一节用户可见操作，先压缩重复的模型句再抬高。
- 双语漂移仍靠人工约束，没有机械门禁比对两版的章节与锚点。
- 收益：默认语言与仓库其它文档一致，新能力在 README 第一屏与使用手册都能查到。

## Testing

`node scripts/verify-doc-budgets.mjs --list` 核对三篇读数；`node --test tests/pack-manifest.test.js tests/doc-budget.test.js` 验证改名后的发布包清单与预算判定；`npm run check` 全绿。
