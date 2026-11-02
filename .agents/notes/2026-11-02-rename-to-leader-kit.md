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

运行时数据目录随之变为 `$DSH_HOME/dsh-leader-kit/`。旧的 `$DSH_HOME/dsh-coordinator/` 不做迁移、也不加读取退回。判据可复核：

- 包从未发布到 registry：`npm view dsh-coordinator version` 返回 404，不存在需要升级的外部安装。
- 本机逐个已知数据根检查。命令写绝对路径：cwd 在 worktree 里时相对路径会指到另一份数据上，结论相反。

  ```sh
  ls -d ~/.dsh/dsh-coordinator
  # No such file or directory：日常实例根没有旧目录
  ls -d ~/.dsh/dsh-leader-kit
  # 存在
  ls -d /Users/mxwu/Documents/code/dsh-leader-kit/.dev/home/dsh-coordinator \
        /Users/mxwu/Documents/code/dsh-leader-kit/.dev/home/dsh-leader-kit
  # 两者都存在：旧目录是主 checkout 开发实例的调试数据
  ls -d /Users/mxwu/Documents/code/dsh-leader-kit/.worktrees/*/.dev/home/dsh-coordinator
  # 无匹配：其他 worktree 的开发实例没有旧目录
  ```

  结论：旧目录只出现在主 checkout 的 `.dev/home`，那是 `npm run dev` 的数据根（README 写明删掉即重置），不属于要迁移的用户数据。

将来真有旧版本部署要升级时，按 README 安装段的 `mv` 手工迁移，或再加读取退回。

## 读取退回与旧包剔除

- **worker 回报消息的 `source.kind`**：读侧认新值与旧值 `dsh-coordinator/worker-report`，写侧只产新值。已落盘的完成通知是会话事件（运行时用户数据、不可重建），只认新值会让旧会话里的气泡静默降级成宿主普通 notice——无头像、无 worker 名、无跳转。回归用例：`tests/worker-report.test.js` 的「旧 kind 的 worker 回报仍能读出 source」「节点定义认领旧 kind 的回报消息」。
- **客户端产物要重建**：`src/client/worker-report-definition.js` 与 `worker-report-view.js` 都从 `../shared/worker-report.js` 导入，读侧兼容会进 `lib/client.js`。`lib/` 不入库（`.gitignore`），已有实例不会自动更新产物——升级到含本改动的版本后必须 `npm run build:client`，否则旧 kind 的回报仍按宿主普通 notice 渲染。重建后验证：`grep -o 'dsh-coordinator/worker-report\|dsh-leader-kit/worker-report' lib/client.js | sort | uniq -c` 两个 kind 各 1 处（改名前产出的 `lib/client.js` 只有新 kind）。
- **`scripts/dev-plan.mjs` 派生 profile 时剔除旧包名**：旧包与本包各带一行 patch（`coordinator-host` / `leader-kit-host`），行 id 不同不去重，留在同一 profile 里会得到两个插件实例。`bundles`、`dependencies` 与 `node_modules` 链接三处都剔除。

## 验证

`npm run check`：519 通过、0 失败（本 PR 后；改名当次为 511）。`npm run build:client` 重建后 `lib/client.js` 里新旧 kind 各 1 处。
