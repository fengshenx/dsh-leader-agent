# Agent Note: 浏览器 e2e 的宿主方案落地与确定性规则

Status: implemented

## Problem

浏览器 e2e 不是从零设计的：宿主 `apps/web/tests/` 已跑通真实 chromium → SSE → apiproxy → agent loop → 工具 → 持久化的链路，但它不能整搬——`scaffold.ts` 在进程内 import 宿主 cordis 树与 `dsh-llm-replay`，与本仓「不 import 宿主内部包」冲突。车道实现见[浏览器 e2e 车道](2026-11-02-browser-e2e-lane.md)，这里只留搬来的机制与不能破的规则。

## Decision

> **部分已被 [e2e 只测行为与逻辑，不测样式](2026-11-25-e2e-logic-only.md) 取代**：断言锚不再包含计算样式；确定性与黑盒化规则仍然成立。

- **只搬机制，实现黑盒化**：vitest + `playwright` 库 → `node:test` + `playwright` core；进程内 `launchWebScaffold()` → 黑盒 spawn `dsh web --port 0 --no-open` 并从就绪行取地址；replay 包回放 fixture → 本地 Messages mock 按 `MOCK-*` 标记出脚本；宿主 `whenIdle()` 轮次屏障 → 浏览器侧状态同步（DOM 稳定、落盘文件出现）；ariaSnapshot golden + refresh → 不做，断言锚是 DOM class / 可见性 / 落盘（计算样式断言后由 [新笔记](2026-11-25-e2e-logic-only.md) 移除）；`DSH_HOME` 隔离与端口 0 → 派生数据根。
- 等价物只保留宿主方案里**是测试判据**的部分（隔离、确定性、失败可见），不复制实现形态：宿主换 scaffold、换 replay 包、换快照工具都不影响本仓。
- **禁 `networkidle`**：SSE 长连接下它永远不解析。
- **禁单次瞬态 DOM 采样**：从流式输出到 React commit 的每一跳都可能合并 chunk，采样天然是竞态。
- **禁固定 sleep**：等 readiness 事件、状态翻转或落盘条件。
- **`pageerror` / `console.error` 即失败**：重连与历史重同步会把断掉的通路自愈掉，套件于是认证了坏 wire；唯一例外是宿主 session 引用释放，`watchProblems()` 按文案放行。
- **端口用 `listen(0)`**：先扫空闲端口再绑定会与并发进程抢。
- **默认不开重试**；**一次只改一个变量**——两个变量同时变，失败原因就分不开。
- **随包技能不引用包外相对路径**：`files` 只含 `.agents/skills/**`，技能里指向 `docs/` 与 `.agents/notes/` 的相对链接装机后不存在，改用绝对 GitHub URL；bundle 链接用例遍历全部候选，断言剩下的相对链接解析后仍在 `.agents/skills/` 内。
- 规则的操作化（等待预算、失败读数、双向验证、搭场景）在 [e2e-scenarios 技能](../../../skills/e2e-scenarios/SKILL.md)，车道入口在 [docs/e2e-testing.md](../../../../docs/e2e-testing.md)。

## Alternatives considered

- **整搬宿主 scaffold 与 replay 包**：会 import 宿主内部包，整条车道随宿主版本漂移；只搬机制、实现黑盒化。
- **用 `networkidle` 等页面稳定**：SSE 长连接下它永远不解析；等 readiness 事件、状态翻转或落盘条件。
- **单次瞬态 DOM 采样 / 固定 sleep**：流式输出与 React commit 天然有竞态；只等确定状态。
- **做 ariaSnapshot golden + refresh**：本仓没有受评审的 UI 快照所有权，快照进回归只会周期性红；用 class / 计算样式 / 落盘断言。
- **默认开重试**：会把不确定性藏起来；默认不开，一次只改一个变量。

## Consequences

- 不 import 宿主内部包、不 peer 依赖 dsh：黑盒化要付的成本就在这里，为少写几行夹具去 import 宿主测试基建，整条车道会随宿主版本漂移。
- 不做 ariaSnapshot golden：本仓没有受评审的 UI 快照所有权，快照进回归只会周期性红。
- 跨进程拿不到 `whenIdle()`：轮次完成只能从浏览器侧观察，这是已知的弱化。
- 规则不按单次方便放行：要放宽先给出哪次失败、什么读数，否则下一次失败会退回「机器慢」这类不可行动的结论。

收益：e2e 的确定性规则写成了可执行判据：不 import 宿主内部包、不靠 sleep/networkidle，失败能看到真实读数。

## Testing

`tests/skills.test.js` 守随包技能的绝对 URL；双向读数：把技能里一条绝对 URL 改回相对路径 → 红并报出越界路径，还原后全绿。文档预算余量由 `tests/doc-budget.test.js` 与 `verify-doc-budgets` 守。
