# agent-team 并存时的护栏

## 背景

宿主有另一套编排设施：`@deepseek-ai/dsh-experimental-agent-team-profile`（bundle 层），加载后注册 `agentTeams` 服务与 `tool-agent-team`。与本 bundle 的冲突不是工具名撞车，而是**会话形态撞车**：

- `tool-agent-team` 给每个 `tryMembership` 成功的 agent 装团队工具（`packages/experimental/tool-agent-team/src/index.ts:411-432`）；`tryMembership` 把「无 `parentSession`、无 subagent descriptor 的普通 root」判成隐式 Lead（`packages/experimental/agent-team/src/roster.ts:111-112`）。
- 本 bundle 的 worker 正是 `agents.create` 建的普通根会话，于是被当成 Lead，拿到 `spawn_teammate` / `team_task_*`：worker 能自己拉 teammate、自己记任务，绕开协调者与卡片的项目归属。
- 协调者则同时看到两套派工工具（`spawn_worker` 与 `spawn_teammate`），以及 team 版的 `send_message` / `list_agents`——后者对 worker 无效。

## 决策

### 检测用服务存在性，时机放在第一次会话创建

`isAgentTeamEnabled` 判 `ctx.get('agentTeams') !== undefined`。服务名由 agent-team 插件注册，是「这个组合到底有没有启用」的唯一权威信号；profile bundles 列表会在派生与叠加后失真，工具注册表只在 Agent scope 可见（全局查询看不到）。

检测放在 `agent/created` 而不是 `apply`：bundle 按 profile 列表顺序叠加，本插件可能先于 agent-team 装配，那时服务还不存在。

### A：告警一次

`warnOnce()` 用闭包标志只打一次（`logger` → `ctx.logger.warn`）。日志说明三件事：worker 会被当成隐式 Lead、工具面挡不住、要彻底隔离请从 profile 移除 agent-team-profile。每次会话都打会把日志刷满，且用户改完配置重启即止。

### C：给协调者与 worker 注入运行时上下文

`dsh-leader-kit:team-ban`（order 106，跟随协调者手册 104 与角色槽位 105）点名 9 个团队工具，走运行时上下文而非 section：只在相关会话上生效，且每轮重新求值（与槽位、协调者手册同一条通道）。

10x 段与 120 的上界有依据，具体整数没有：段内是「这个会话该怎么干活」的约束，107 之类的等价调整同样成立。用例只锁段（`TEAM_BAN_CONTEXT_ORDER_BAND`）与「< 120」，取值写在常量注释里作为约定。

正文按角色分开：协调者的出口是 `spawn_worker` / `message_worker` / 卡片；worker 的这三件工具正被 deny（`tools/gate.js` 的 `COORDINATOR_ONLY_TOOLS`），所以 worker 版只讲它真能做的——当轮结束由系统结算、交付落在自己的 worktree 与 PR、任务事实用 `update_card` 汇报。共用一份文案会让 worker 照做一个它没有的工具，拿 tool-not-found 并把失败写进交付。

普通会话不注入：它们可能真的在用 teammate，那套工具对它们是有效的。`teamBanFor` 只认协调者与 worker。

### 不选 B（检测到就拒绝并存）

worker 与 teammate 在运行时并不互斥，混用才是问题。拒绝并存会让「想同时用两套编排」的部署直接起不来，而正确行为（不要拿 team 工具派本流程的活）是可以讲清楚的。

## 边界

- **工具面挡不住团队工具**：它们注册在 Agent scope，`tools.restrict({ deny })` 的 `restrictableNames` 只收全局名（`packages/core/tools/src/index.ts:179-182,210-226`），而 `tool-subagent*` 的全局注册已被 agent-team-profile 禁用。本插件现有的逐件重试会静默跳过这些名字（`src/host/tools/gate.js:133-140`）。要结构性隔离只能从 profile 移除 agent-team-profile。
- **teammate 不在本 bundle 的项目归属里**：它们是 Lead 的 continuable subagent，不经过 `spawn_worker`，不进 worker 登记表，也不会出现在看板的 worker 名单。本插件不接管它们。
- **客户端不隐藏 agent-team 的入口**：它只在会话头部加一个按钮（`client-ui-agent-team` 的 `conversation.session.header.actions`），与看板并存；隐藏它需要宿主 UI 的扩展点，超出本 bundle 的契约面。
- **工具名名单随宿主版本漂移**：`TEAM_TOOL_NAMES` 是 0.2.1-rc.2 的集合，本 bundle 零宿主依赖、不读宿主包，宿主改名时这份名单与禁令正文要一起改；单测保证「名单里的每个名字都出现在两份禁令里」与「每个角色的推荐入口都在自己的工具面里」（对照 `tools/gate.js` 的 deny 清单），管不了宿主是否改名。
- **本机没有真机复现**：当前日常 profile 未装 agent-team 包（`~/.dsh/profiles/web/package.json` 的 bundles 与 node_modules 都没有），所以验证是单测 + 宿主源码读音，没有跑「启用 agent-team 的实例」这一读数。

## 验证

`npm run check` 全部用例通过（本 PR 新增 12 条 `team-guard` 用例：启用判定、身份分派、两份禁令都点名全部工具、各角色推荐入口落在自己的工具面里、worker 禁令不点名协调者专属工具、order 段与上界、求值抛错回落、告警去重）。

双向验证（撤销判定 → 对应用例变红 → 还原全绿，逐条实跑）：

- 把 `teamBanFor` 的 `if (!enabled) return ''` 短路掉 → 「未启用时任何会话都不注入」变红（9/10），还原后 10/10 绿。
- 去掉 `warnOnce` 的 `warned` 判据 → 「检测到 agent-team 时只告警一次」变红（9/10），还原后 10/10 绿。
- 把 `TEAM_BAN_TEXT_WORKER` 换成协调者版（角色错配，审查里的 M4）→ 「worker 的禁令不点名协调者专属工具」「协调者与 worker 各拿自己的禁令」变红（10/12），还原后 12/12 绿。
- order 的三向读数：`TEAM_BAN_CONTEXT_ORDER` 改到 107（段内等价调整）→ 12/12 绿，109 以内都不会误报；改到 110（越出 10x 段）与 130（越过宿主 120 / 125）→ order 用例变红（11/12），还原后 12/12 绿。

宿主侧依据（读码，非实测）：`agent-team/src/index.ts:76` 注册 `agentTeams`；`tool-agent-team/src/index.ts:411-432` 对所有 `tryMembership` 成功的 agent 装工具；`agent-team/src/roster.ts:111-112` 把普通 root 判成 lead；`packages/core/tools/src/index.ts:179-182` 的 `restrict` 只接受全局工具名。
