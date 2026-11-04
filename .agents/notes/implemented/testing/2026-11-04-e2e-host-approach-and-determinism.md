# Agent Note: 浏览器 e2e 的宿主方案落地与确定性规则

## 背景

本仓的浏览器 e2e 车道不是从零设计的：宿主 dsh 的 `apps/web/tests/` 已经跑通一条成熟链路（真实 chromium → SSE → apiproxy → agent loop → 工具 → 持久化）。本仓照它的机制与规则做了一套黑盒等价物。

问题在于**不能整搬**：宿主的 `scaffold.ts` 约 1800 行，在进程内 import 宿主 cordis 树与 `dsh-llm-replay`，而本仓禁止 import 宿主内部包、不 peer 依赖 dsh。车道实现本身记在[浏览器 e2e 车道](2026-11-02-browser-e2e-lane.md)；这里只留「哪些是搬来的、为什么这样等价、哪几条规则不能破」——那些规则是宿主踩出来的，重踩一遍要付同样的代价。

## 决策

### 只搬机制，实现全部黑盒化

| 宿主 dsh | 本仓等价物 |
|---|---|
| vitest 跑道 + `playwright` 浏览器库 | `node:test` 跑道 + `playwright` core（本仓只有 node:test） |
| `launchWebScaffold()` 进程内启动真实组合 | 黑盒 spawn `dsh web --port 0 --no-open`，从 `dsh web: <url>` 行取带 token 的地址 |
| 禁用 llm 适配器 + `dsh-llm-replay` 回放 fixture | `DEEPSEEK_BASE_URL` 指向本地 Messages mock，按 `MOCK-*` 标记出脚本 |
| host 侧 `whenIdle()` 作为轮次完成屏障 | 浏览器侧按状态同步（DOM 稳定、落盘文件出现）——跨进程拿不到 whenIdle |
| ariaSnapshot golden + `DSH_SNAPSHOT=refresh` | 不做：本仓没有受评审的 UI 快照所有权，断言锚用 class / 计算样式 / 落盘 |
| DSH_HOME 隔离、端口 0、Linux PR 必需门禁 | 复用 `scripts/dev-instance.mjs` 派生数据根；端口 0；`npm run e2e` 独立，不进 `npm run check` |

等价物只保留宿主方案里**是测试判据**的部分（隔离、确定性、失败可见），不复制它的实现形态。宿主换 scaffold、换 replay 包、换快照工具都不影响本仓。

### 从宿主搬来的确定性规则

这几条是宿主踩过的坑，别在本仓重踩：

- **禁 `networkidle`**：SSE 长连接下它永远不解析。
- **禁单次瞬态 DOM 采样**：从流式输出到 React commit 的每一跳都可能合并 chunk，采样天然是竞态。
- **禁固定 sleep**：等 readiness 事件、状态翻转或落盘条件。
- **pageerror / console.error 即失败**：重连与历史重同步会把断掉的通路自愈掉，套件于是认证了坏 wire。唯一例外是宿主的 session 引用释放，`watchProblems()` 按文案放行。
- **端口用 `listen(0)`**：先扫空闲端口再绑定会与并发进程抢。
- **默认不开重试**：重试只会把竞态藏起来。
- **一次只改一个变量**：两个变量同时变，失败原因就分不开。

规则的操作化（等待预算、失败读数、双向验证、搭场景）写在 [e2e-scenarios 技能](../../../skills/e2e-scenarios/SKILL.md)，车道入口在 [docs/e2e-testing.md](../../../../docs/e2e-testing.md)。

## 边界

- **不 import 宿主内部包、不 peer 依赖 dsh**：这是黑盒化要付的成本来源；为了少写几行夹具去 import 宿主测试基建，会让整条车道随宿主版本漂移。
- **不做 ariaSnapshot golden**：本仓没有受评审的 UI 快照所有权；快照进回归只会周期性红，断言锚是 class、计算样式与落盘文件。
- **跨进程拿不到 `whenIdle()`**：轮次完成只能从浏览器侧观察（回复上屏、落盘文件出现），这是已知的弱化。
- **规则不按单次方便放行**：要放宽一条，先在 PR 里给出实测依据（哪次失败、什么读数），再改规则；否则下一次失败会退回「机器慢」这类不可行动的结论。

## 验证

- 拆分 `docs/e2e-testing.md`：196 行 / 4,490 单位 → 122 行 / 2,542 单位；天花板 4,750 → 2,670（余量 5.0%）。三篇同步重设的天花板：`README.md` 3,025 / 3,177、`README_ZH.md` 4,518 / 4,744、`SLOTS.md` 649 / 682。
- `npm run check`：1,069 个用例通过（17 跳过）；Agent Note 83 篇、文档工具名 15 篇、文档预算 13 篇全绿。
- 搬走的规则在入口文档只留一行清单与链接，未留死锚点：全仓对 `docs/e2e-testing.md#...` 的链接复查为 0 条（原 `#断言纪律` 改指技能）；改动文件的相对链接解析全部可达。
- 双向验证（余量上限）：把 `README.md` 天花板从 3,177 抬到 4,000 → `verify-doc-budgets` 输出 `LOOSE 3025 / 4000 README.md → 建议 3177` 并以 1 退出；`tests/doc-budget.test.js` 的「真实清单：当前读数都不超限，余量也不超过 12%」变红（15 pass / 1 fail），`npm run check` 在文档预算一步红。还原 3,177 → 16 / 16 绿、`npm run check` 全绿。
- 车道本身的验证（mock、截图、Fail Loud、清理上限）见[浏览器 e2e 车道](2026-11-02-browser-e2e-lane.md)、[e2e 失败预算](2026-11-04-e2e-failure-budget.md)与 [e2e 清理阶段的有界等待](2026-11-04-e2e-shutdown-bounded.md)。
