# Agent Note: e2e 场景合并（i18n / 左栏 / 排序）

Status: implemented

## Problem

Issue #201 时 22 个场景 / 212.5s；本次实测 24 个 / 241.8s（平均 10.07s）。每个场景固定起一次宿主 + mock + chromium（约 3s），重复启动是主要成本。三组重复：`i18n-english` 与 `i18n-switch` 同 seed；`project-alignment` 与 `project-placement` 同左栏夹具；`worker-session-order` 自建 3 个 worker，而 `project-session-fold` 已有 2×6。

## Decision

- `i18n-english` 并入 `i18n-switch`：en 步补 guide 入口标题 / 正文断言；看板 tab 占右栏时新开 guide 标签页，读完切回看板；删除独立场景。
- `project-placement` 并入 `project-alignment`：共用 seed，先断言落点再断言几何，失败信息带「落点：」「几何：」前缀；删除独立场景。
- `worker-session-order` 并入 `project-session-fold`：seed 写与创建顺序相反的 `lastUsedAt`，A 展开到 6 条后断言 DOM 顺序；删除独立场景。
- `project-session-fold` 保持每项目 6 个 worker：2×5 会让「5 条 + 展开其余 1 个」消失，丢掉 #215 的完成未读不撑开守卫，不为数字硬压。
- `project-alignment` 的 `sectionHeader` 改为从 `hostRow` 向上找同 section，并断言 label 为「工作区」，不再取全局第一条。
- `leader-changes` 去掉两条 `working_directory` mock 步骤；绝对路径 + 完全权限已足够让宿主记录改动文件。
- 顺带修 `board-done-paging` 的点击竞态：宿主侧栏刷新期间首次点项目行可能丢，改成点到 `data-selected` 为止；`avatar` / `guide-card` 有同样形态，但它们在禁改清单里，本次只记录根因。
- 保留 `i18n-link-editor`：URL 校验是纯函数且已有单测；该 e2e 的独有守卫是「错误码 → locale key → 英文 DOM」，删掉会缩小行为范围。

## Alternatives considered

- **删 `i18n-english` 不迁移断言**：丢掉英文 guide 入口标题 / 正文的 e2e 守卫。
- **`worker-session-order` 缩到 2 个 worker**：仍保留一次完整启动，收益小于并进 fold。
- **`project-session-fold` 缩到 2×5**：水位正好 5 条时没有「展开其余」，必须删改 #215 守卫。
- **删 `i18n-link-editor`**：纯函数只证明校验码，证明不了英文 DOM 映射。
- **保留独立 `project-placement`**：多一次启动，断言数量不变。

## Consequences

- 场景数 **24 → 21**；总耗时 **241.8s → 226.5s**（少 15.3s，约 6.3%；平均 10.07s → 10.79s，受最终跑 load 7.33 与倍率影响）。少掉三次启动与三组夹具。
- 合并后的失败仍指向子场景：guide 断言、`落点：` / `几何：` / `排序：` 前缀。
- fold 的 `lastUsedAt` 与创建顺序相反，排序断言能区分「按最近使用」与「按会话库创建顺序」；5+1 水位与完成未读守卫保留。
- `docs/e2e-testing.md` 没有逐场景表或条数，只更新 `avatar` / `guide-card` / `board-done-paging` 的 flake 确认日期；`docs/development.md` 无条数描述；样式人工取证清单未动。
- 代价是 `i18n-switch` 与 `project-session-fold` 各长一点，换少一条车道。
- 收益：保持全部断言与 flake 守卫，全量少 3 条车道、约 15.3 秒固定启动开销。

## Testing

- 基线 `npm run e2e:report`：24/24，241.8s（load 5.17，无倍率）；精简后 21/21，226.5s（合并 main 产品修复前的 head，load 7.33，`E2E_BUDGET_SCALE=1.5`）。合并 main 产品修复后同一命令在 load 7.8 下命中 `guide-card` / `project-workspace` 同款点击竞态，两条空载单跑 8.2s / 7.2s 通过。
- mutation：行高 30px、header padding 0、行左缘 +4px、en label 中文各红一次，还原后绿。
- `board-done-paging` 修复后单跑 9.7s 通过；最终全量 21/21。
- `npm run check`：exit 0。
