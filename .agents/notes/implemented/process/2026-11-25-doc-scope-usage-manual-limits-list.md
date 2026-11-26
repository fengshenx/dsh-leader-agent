# Agent Note: 文档回归工具书：usage 只写操作，limitations 只记限制

Status: implemented

## Problem

`docs/usage.md` 与 `docs/limitations.md` 长期只增不删：体量天花板 usage 7400→8223、limitations 8900→9450，每次修 bug 追加一句。usage 里混进 DOM 类名、localStorage、落盘路径与渲染层补丁，limitations 里混进测试夹具与截断参数；同一主题（回报气泡、巡查、卡片写权限、看板 Tab、隐藏改动文件、初始化拒绝）两边各写一遍。读者拿到的是实现规格，不是手册。

## Decision

- usage 改成按操作组织的手册：加项目、派工、看 worker、卡片、看板、项目管理、项目提示词、设置。每条只写「做什么、看到什么、什么时候被拒」，参数只到调用方需要的那一层。
- limitations 只留限制：每条约一到两句，写清做不到什么与代价；机制与推演链回 architecture / capability-gaps / notes。
- 外部锚点原样保留：limitations 的「宿主语义与运行形态」「worker 的控制面」「看板与卡片」「项目树与工作区」「客户端与宿主耦合」「发布」，usage 的「卡片」「worker 名册上限与复用」。
- 同步 AGENTS.md 分层表与 README / getting-started / architecture 的指针措辞。
- 在 AGENTS.md 补「用户文档的维护口径」：读者是人不是模型，usage 跟用户可见操作走，limitations 跟边界走，README 留概览、存量长文另开 PR 收，长文只活在 GitHub。
- 天花板按新体量重设：usage 1900、limitations 2380；补完用户操作后留 5–6% 余量，AGENTS 4342 / 4840 留 11.46%。

## Alternatives considered

- 只去重与拆段、不删事实：体量仍停在 5–6k，规格书气质不变，被否。
- 拆成「用户手册 + 维护者规格」两篇新文档：分层表已有 architecture / capability-gaps 承接，再开一篇只多一处要同步的归属，被否。
- 保留逐功能点的「完整交互」并加目录：正是要清掉的问题，被否。

## Consequences

- 实现细节不再有「使用手册」这处落点：新增行为先判断读者——用户可见的进 usage，做不到的进 limitations，机制进 architecture。
- 旧文档里的一些细节（气泡折叠的 DOM 测法、claim 的分支等）不再有独立段落；需要时查对应 Agent Note 与代码。
- README 现有五步操作与长限制属存量，按单独 PR 收；本 PR 只改指针句，规则已限定为「存量长文另开 PR」。
- 收益：两篇从约 17k 单位降到约 4k，按操作可查，门禁留出正常余量。

## Testing

`npm run check` 全绿（文档预算、Agent Note 格式、工具名比对）；`node scripts/verify-doc-budgets.mjs --list` 读数为 usage 1805/1900、limitations 2244/2380、AGENTS 4342/4840。
