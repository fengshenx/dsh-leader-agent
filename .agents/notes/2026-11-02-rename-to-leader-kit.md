# 包名改为 dsh-leader-kit

**日期**：2026-11-02
**范围**：全仓标识（包名、CSS 前缀、skill 名、locale、remote），不含 `.worktrees/` 旧副本

## 为什么改名

`coordinator` 太泛，不表达"人带队派工"这个形态。选型时先排除了 dsh 生态里已被占用的词：

| 候选 | 状态 |
|---|---|
| `dsh-crew` | 已占用：第三方角色小队插件（PM / 研究员 / 架构师 / 工程师 / 审查） |
| `dsh-fleet`、`dsh-agent-fleet` | 已占用：多机算力组网、进程内协作 |
| `dsh-orchestrator` | 已占用；且官方 Super-agent 在代码与提示词里用 `orchestrator` 指主会话 |
| `dsh-lead-mode` | 已占用：围绕官方 Agent Teams 的预设 + skill 封装 |
| `dsh-leader-kit` | 未占用 |

官方 2026-10-31 发布的 `dsh-superagent` 原型用 Source / Trigger / Ticket / Executor 一套词，主会话在代码里叫 `orchestrator`，worker 由官方 Agent Teams 提供。本包的差异是**人在场**：leader 就是用户正在对话的那个会话，worker 是本 bundle 用 `ctx.agents.create` 建的常驻根会话，不依赖官方 Agent Teams，也不做从 IM / GitHub 主动接活。

## 改动

- 包名 `dsh-coordinator` → `dsh-leader-kit`，连带 CSS 类名前缀、`STYLE_ID`、`@module`、日志前缀、skill providerName、worker 消息 kind、运行时数据目录
- skill `coordinator-mode` → `leader-mode`（目录与 frontmatter）
- locale 标题 `Coordinator` → `Leader Kit`、`协调者` → `队长工具包`
- `cordis.patch.yml` 插件行 id `coordinator-host` → `leader-kit-host`
- `scripts/dev-plan.mjs` 常量 `COORDINATOR_PACKAGE` → `LEADER_KIT_PACKAGE`

## 没改的

- **`COORDINATOR.md` 文件名**：项目级提示词约定，改名会让所有已初始化项目静默失效。中文"协调者"叙述同样保留：它是角色描述，与包名是两层。
- **内部领域标识**：`coordinatorSessionId`、`isCoordinatorSession`、`coordinatorIndex` 是领域概念，不是包名。
- **`.worktrees/` 旧副本**：独立 checkout，随分支处置。

## 数据目录

运行时数据目录随之变为 `$DSH_HOME/dsh-leader-kit/`。旧的 `$DSH_HOME/dsh-coordinator/` 未做迁移（确认只是测试数据）。若将来有真实部署要升级，需要 `mv` 旧目录或加读取退回。

## 验证

`npm run check`：511 通过、0 失败。`lib/client.js` 重建后无旧名残留。
