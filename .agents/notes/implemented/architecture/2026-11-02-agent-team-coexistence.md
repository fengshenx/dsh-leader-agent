# agent-team 并存时的护栏

## 背景

宿主另一套编排设施 `agent-team-profile` 加载后注册 `agentTeams` 服务与团队工具。冲突不是工具名撞车，而是**会话形态撞车**：团队工具把「无 parent、无 subagent descriptor 的普通 root」判成隐式 Lead，而本 bundle 的 worker 正是普通根会话——于是 worker 能自己拉 teammate、绕开协调者与卡片归属；协调者则同时看到两套派工工具。

## 决策

### 检测用服务存在性，时机放在第一次会话创建

`isAgentTeamEnabled` 判 `ctx.get('agentTeams') !== undefined`：服务名由 agent-team 注册，是「这个组合有没有启用」的唯一权威信号（profile 的 bundles 列表在派生与叠加后会失真，工具注册表只在 Agent scope 可见）。检测放在 `agent/created` 而不是 `apply`：bundle 按 profile 顺序叠加，本插件可能先于 agent-team 装配。

### A：告警一次

`warnOnce()` 用闭包标志只打一次，日志说明三件事：worker 会被当成隐式 Lead、工具面挡不住、要彻底隔离请从 profile 移除 agent-team-profile。

### C：给协调者与 worker 注入运行时上下文

`dsh-leader-agent:team-ban` 点名 9 个团队工具，走运行时上下文而非 section：只在相关会话上生效，且每轮重新求值。order 取 10x 段（跟随协调者手册与角色槽位），具体整数是约定，用例只锁段与上界。

正文按角色分开：协调者的出口是 `spawn_worker` / `message_worker` / 卡片；worker 的这三件正被 deny，所以 worker 版只讲它真能做的——当轮结束由系统结算、交付落在自己的 worktree 与 PR、任务事实用 `update_card` 汇报。共用一份文案会让 worker 照做一个它没有的工具。普通会话不注入：它们可能真的在用 teammate。

### 不选 B（检测到就拒绝并存）

worker 与 teammate 在运行时并不互斥，混用才是问题；拒绝并存会让「想同时用两套编排」的部署直接起不来，而正确行为（不要拿 team 工具派本流程的活）是可以讲清楚的。

## 边界

- **工具面挡不住团队工具**：它们注册在 Agent scope，`restrict({ deny })` 只收全局名；要结构性隔离只能从 profile 移除 agent-team-profile。
- **teammate 不在本 bundle 的项目归属里**：它们是 Lead 的 continuable subagent，不进 worker 登记表、不出现在看板名单，本插件不接管。
- **客户端不隐藏 agent-team 的入口**：隐藏它需要宿主 UI 的扩展点，超出本 bundle 的契约面。
- **工具名名单随宿主版本漂移**：本 bundle 零宿主依赖、不读宿主包，宿主改名时名单与禁令正文要一起改；单测只保证名单与两份禁令、各角色推荐入口自洽。
- **没有跑过「启用 agent-team 的实例」**：日常 profile 未装该包，验证是单测加宿主源码读音。

## 验证

`tests/team-guard.test.js` 钉住启用判定、身份分派、两份禁令与 order 段。双向读数：短路 `if (!enabled) return ''`，未启用用例变红；把 worker 禁令换成协调者版，角色错配用例变红。
