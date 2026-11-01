# 能力缺口清单（P0–P5 实测）

本清单由 P0–P5 阶段在真实 dsh（0.2.1-rc.2）上实测得出，不是文档推断。每条给出对比形态、dsh 实测现状、证据与影响。**目标形态**指希望达成的能力，**参照形态**指已有实现的实际做法；本仓是否已达成，看条目结论。

复现环境：macOS arm64，dsh `0.2.1-rc.2`，web、headless 与 sdk 三个 profile。

---

## 一、阻断级

### 1. `agent-team` 的版本耦合（P1 期间已解除，但结论保留）

**目标形态**：协调者的执行者能力是产品级能力，不受宿主版本漂移影响。

**P0 实测**：web profile 的 `dsh.profile.bundles` 里有三个 team 插件行，dsh 启动时全部拒绝激活：

```
dsh: disabling profile plugin row "agent-team": Plugin @deepseek-ai/dsh-experimental-agent-team@0.1.5-alpha.2
is incompatible with dsh 0.2.1-rc.2: requirements {"@deepseek-ai/dsh-llm":"^0.1.5-alpha.2", ...}
```

`^0.1.5-alpha.2` 在 semver 下只允许 `0.1.x`，宿主已是 `0.2.1-rc.2`，因此整组被拒。启动日志里共 8 条同类拒绝（agent-team / tool-agent-team / ui-agent-team）。

**P1 期间更新**：team 已升到 `0.2.1-rc.2`，在 web profile 正常激活。

**结论保留**：被拒不是配置问题，是 dsh 的插件版本策略在预览期的必然结果。dsh 的 `engines.dsh` 机制意味着**任何依赖 dsh 内部包的 bundle 都会周期性失效**；本 bundle 零 dsh 内部依赖的设计因此是必要的，不是保守。编排层用 `ctx.subagents` 系列（见缺口 2），不依赖 team；team 若恢复可用，只需换 adapter（把 team 调用收敛到单一文件）。

### 2. dsh 没有「完成唤醒协调者」——P1 已自建补齐

**目标形态**：worker 跑完 → 事件触发 → 协调者自动开新 turn 并收到富通知，外加通知落盘、崩溃补投与自动续行护栏。协调者派完活继续思考，不阻塞。

**dsh 实测**：base bundle 内置 `subagent-spawn-in-process`、`tool-subagent-control`、`tool-subagent-list-agents`（`packages/bundle/base/cordis.patch.yml:362-377`），可用；但 subagent 工具的语义是**父 agent 调工具 → 子 agent 跑完 → 工具返回结果**，父 turn 在调用处阻塞。dsh 侧没有等价的「子会话结束后父会话被动醒来」机制；team 有 inbox 投递但同样不主动唤醒 Lead（team README「Waiting and interruption」只有成员主动 `waitForChange()`）。

**P1 的解法**：不改 dsh，只用它的公开入口自建三条链路：

- **派工**：`ctx.subagents.startActivation({ delivery: 'caller' })` 立即返回子会话 id，`activation.result` 是终态 promise——dsh 原生 spawn 工具是阻塞式，做不到「派完即返回」。
- **唤醒**：`agent.followup(userMessage)`，dsh 唯一能开新 turn 的入口。
- **落盘**：完成通知先写盘再唤醒，进程在唤醒前崩溃不丢通知；投递失败的通知留在队列，父会话重新打开时补投。

**实测结论**（sdk profile，mock LLM，全链路一次通过）：父派工 → 子会话建立并执行 → 子终态 → 父 inbox 收到「任务「写文件」已结束…」→ 父状态 `idle → running → idle`（真的被唤醒并开了新 turn）→ 通知队列清空。

---

## 二、形态级

### 3. 插件模块从 profile 目录解析，不从 dsh 安装目录解析

**实测**：用 `--patch` 加载时，插件行写包名会失败：

```
Cannot find package 'dsh-leader-kit' imported from /Users/mxwu/.dsh/profiles/web/
```

把包 link 进 dsh 仓库的 `node_modules` 无效——解析基准是 profile 目录。

**应对**：bundle 必须装进 profile（`dsh plugin --profile <name> add <spec>`）。开发期可另用绝对路径 patch（`docs/user/develop/basic/index.md:56` 要求绝对路径），但那是开发形态，不是分发形态。

### 4. 用户 profile 里的坏 bundle 会阻塞 plugin CLI

**实测**：`~/.dsh/profiles/web/package.json` 里的 `@dsh-external/dsh-super-injector` 指向 `/Users/mxwu/Documents/code/dsh-routing-suite/injector`，该目录已不存在。于是：

```
Error: dsh: cannot resolve profile bundle "@dsh-external/dsh-super-injector" ...
at runProfilePnpm (packages/boot/plugin-manager/src/operations.ts:523:15)
```

`dsh plugin --profile web add ...` 在写入 `dsh.profile.bundles` 之前就抛错，导致**依赖装上了但 bundle 层没写入**的半完成状态。

**应对**：这是宿主环境问题，不是 bundle 问题；但它意味着「按官方命令安装」在真实机器上可能失败。安装流程需要具备「plugin CLI 失败后回退到手工写 profile patch 层」的预案。

---

## 三、能力级

### 5. 无角色与权限模型

dsh 的 skill 只有 `modelInvocable` / `userInvocable` 两个布尔开关（`packages/skill/skill/src/index.ts:49-54`），没有 per-skill 工具白名单或角色声明。粗粒度角色只能靠 agent preset 换工具集 + persona 换人设。

**影响**：角色槽位机制（项目根的 `SLOTS.md`）在 dsh 无对应物。**应对**：P3 自建薄层，只承载方法入口与人设，不承担工具授权——协议层需保留「技能不授予权限」的声明。

### 6. 无跨会话的项目实体

session 类型里没有 `projectId`；`projectRoot` 只用于 skill 发现与 agent-instructions。最接近的持久实体是 team 的任务板（绑定单一 Lead Session）、todo（单会话整表）、goal（单会话一个目标）。

**影响**：项目实体（目录绑定 + coordinatorSessionId + 卡片外键）需自建。**但**：dsh 的 `profile` 概念可能已覆盖「一套插件组合 + 一个协调者」的诉求，P3 开工前必须先核对，避免自建重复概念。

### 7. team 任务板不覆盖 slot→session 绑定

即便 team 可用，其任务板提供任务、依赖 DAG、owner、revision CAS，**没有**「一个卡片同时挂 dev 与 review 两个会话」的槽位绑定，也没有 links 与编号不复用。

**影响**：人类可见的交付看板必须自建存储域，不能硬塞进 team 任务板。两者职责需分开：team 板是机器侧编排状态，自建 Card 是人类侧交付状态。

### 8. 仓外插件不能新增 session event 类型

dsh 要求仓外事件必须带 `ignorable` 标记且不进读路径（`packages/core/session/src/known-event-types.ts:24-30`）。

**影响**：卡片与项目状态不能写进会话事件流，只能走独立存储域 + session projection。这决定了 P2/P3 的实现形状。

### 9. session 日志在 headless 下未落盘内容

**实测**：headless 会话产生的 `session.v4.jsonl.zstd` 解压后仅 198 字节，无工具调用、无 skill catalog 记录。`~/.dsh/storages/session_projcache/` 里有工具名，但没有 skill catalog。

**影响**：不能指望 session log 做编排状态的持久化或审计。编排状态与卡片状态需要自己的持久化。

### 10. `agents` 注册表在插件根作用域不可见

**实测**：`ctx.get('agents')` 抛 `cannot get required service "agents" in inactive context`——`agents` 是 agent-scoped 服务，根作用域的插件拿不到。

**影响**：插件无法在任意时刻反查任意会话的 agent。唤醒与补投只能依赖「派工时持有的父 agent 活对象」加 `agent/created` / `agent/disposed` 事件。

### 11. `sessionController` 只挂在 web-app bundle

**实测**：`@deepseek-ai/dsh-api-session-controller` 由 `packages/bundle/web-app/cordis.patch.yml:121` 挂载。它有 30 余个 peer 依赖，还需 `fileUploads` 与 `workspaceRegistry` 两个服务；headless profile 补齐不现实，实测报 `pending (waiting for services: fileUploads, workspaceRegistry)`。

**影响**：不能把 `sessionController` 声明为插件的必需 inject——否则不含该服务的 profile 整个插件挂起。本 bundle 改用 `ctx.get()` 惰性获取，缺失时回退到派工时持有的 agent。

### 12. headless 一次性 CLI 会销毁父会话——唤醒失败的真因

**实测**：headless profile 下父会话在 turn 结束后被 dispose（`agent/disposed`），此后 `followup()` 没有载体，投递报 `cannot read inbox state: its projection registration is not active`。web 与 sdk 等长驻组合里父会话存活，唤醒正常。

**影响**：后台编排只适用于长驻组合（web / desktop / sdk）；headless 的一次性任务模式不适用——这是宿主语义，不是本 bundle 的缺陷。

### 13. 两套同名工具：父子模型与同伴模型

**实测**：dsh 有两处 `send_message` / `interrupt_agent` / `list_agents`：

| 来源 | 模型 | 寻址 | 作用域 |
|---|---|---|---|
| `@deepseek-ai/dsh-tool-subagent-control`（base bundle 默认启用） | 父子 | `agent_id` 即子会话 id | 调用者派出的子会话 |
| `@deepseek-ai/dsh-tool-agent-team`（experimental，base bundle 未启用） | 同伴 | teammate 名字 | team 成员 |

**影响**：本流程两者都不用。worker 是本 bundle 用 `ctx.agents.create` 建的普通根会话，不在任何 subagent 目录里：`list_agents` 列不到它；`send_message` 的 `authorizeLineage` 要求子会话头的 `parentSession`（根会话没有），走不通；`interrupt_agent` 对非 resident 目标静默 `return`，工具却仍报成功。worker 的所有交互只经本 bundle 的 `spawn_worker` / `message_worker`，协调者的工具面也把这三件 deny 掉了（普通会话保留：它可能真的用官方 subagent）——也因此协调者没有中止常驻 worker 的手段，worker 卡住只能请人去那个会话处理（见 README「已知限制」）。早期方案文档按 team 工具写过映射表，同样不适用于本流程。

### 14. 工具的结构化结果不进事件流 content，只在 `presentationMeta` 投影的 `meta` 里

**实测**：`tool/result` 事件的 `message.content` 只有 `output.render` 给模型的文本；`output.value`（结构化结果）不出现在事件里。`output.presentationMeta(args, value)` 投影的 `meta` 才随事件持久化（`tool/result` 事件的 `data.meta`），并被客户端的 `ToolResultNode.meta` 读回。

**影响**：客户端要拿结构化数据，只能走 `presentationMeta`。本 bundle 的卡片工具据此投影 `meta`（`{kind:'dsh-leader-kit-cards', scope, cards}`），客户端据此重建看板。

### 15. 右栏 tab 注册与 slot body 都在浏览器侧，host 插件够不着

**实测**：`ctx.sidebarRightTabs.register` 与 `ctx.slots.inject('sidebar.right.pane.tab', …)` 是 client 服务（`packages/client/ui-sidebar-right`，browser-side UI plugin layer），host 进程（Node 侧插件）注册不了。

**影响**：看板 UI 必须有 client 半边——package.json 声明 `dsh.client`（`platform:'web'`、`exports:'./client'`），并产出 `lib/client.js`（closure-factory 格式，React 等 baseline 模块由宿主提供，本仓无额外模块请求）。构建链见第 19 条，插件行名的硬约束见第 18 条。

**右栏入口的过滤边界**：tab 类型的 `guide` 是静态注册，注册表没有按会话过滤的扩展点，guide 页会把每个入口画给所有会话。能收紧的只有一处：`sidebar.right.tab.guide.entry` 是 keyed slot（key 为 tab 类型的 `providerId`），插件接管自己那一个入口的渲染，按会话决定画或不画；但 guide 的 More 菜单走 `sidebar.right.tab.guide.actions`（root scope，不带会话），列出的入口名单无法过滤。接管渲染的代价是胶囊要自己复刻宿主 `EntryBox` 的数值，宿主改版式时要跟。

### 16. 读子会话原始回合内容没有默认可用的工具

**实测**：`session_event_read` / `session_search` / `session_trace` 属 `@deepseek-ai/dsh-tool-session-query`（experimental），base bundle 未启用；其「authorized session」授权校验在 dsh 内部，仓外插件无法零依赖正确复刻。

**影响**：读 worker 原始回合没有直接对应物，降级为「完成通知携带产物摘要」；需要深挖时用 `message_worker` 向该 worker 追问（会唤醒它开新回合）。若要直读会话原始事件，须显式安装 `tool-session-query` 并接受其 experimental 状态。

### 17. storage domain 需要 dsh 内部包与 zod，与「bundle 零内部依赖」冲突

**实测**：`defineDomain` / `domainTable`（`packages/storage/storage-domain/src/spec.ts:107`）要求 zod schema，存储域服务本身是 `@deepseek-ai/dsh-storage-domain` peer 依赖，dsh 按 peer 版本与宿主严格校验。

**影响**：卡片与通知队列改用自建落盘（原子写 + 读-改-写串行化），落在 `$DSH_HOME/dsh-leader-kit/`。代价是不享受 dsh 的存储域生态（迁移、备份、跨端同步），换来的是零版本耦合。

### 18. 插件行名必须是纯包名，否则浏览器侧发现不到 client 半边

**实测**：`packages/client/modules/src/index.ts:892` 的 `locatePkgJson` 要求 Loader 行名可解析成包名：`exactPackageSpecifier` 不接受含 `/` 的子路径。行名写成 `dsh-leader-kit/src/host` 时定位不到包 manifest，该行不会被识别为 client row——宿主不下发 client bundle，浏览器侧完全没有本包的 UI。

**实测（修复后）**：行名改为 `dsh-leader-kit`（纯包名）→ web profile 的 boot manifest 从 70 条目变 71 条目，多出的条目即本包，附带 `plugins/??dsh-leader-kit/client.js` 下发路径；浏览器右栏随即出现本包注册的 Tab。

**影响**：bundle 的插件行名不能为了定位子模块而写成子路径；子模块仍可通过 `exports` 映射（如 `"./src/host"`）供包内引用。

### 19. client 产物得自己产出 closure-factory 封装

**实测**：dsh 的 `clientBundle` 预设（`packages/client/tsdown.client.ts`）绑定仓内 `PLATFORM_MODULES` 等多个模块，第三方仓无法直接引用；宿主按 closure-factory 约定加载产物——`window.__ModuleLoader__.load({ id, factory: (require) => { var module = { exports: {} }; … return module.exports; } })`。

**影响**：本 bundle 用 esbuild 自建轻量构建链（`build/client.mjs`）：产物体是 CJS，banner 注册工厂并注入 require，footer 交回 exports；产物里留下的外部 import 由工厂的 require 解析——React 与 react-dom 是宿主基线模块（`PLATFORM_MODULES`），必须 external 掉以复用宿主那份实例，打进产物会出现第二份 React 实例。manifest 的 `dsh.client.external` 只用于请求非基线模块，本仓无此需求。

### 20. 面板读会话事件要走 `ctx.sessions`，不是纯 session projection

**实测**：`ctx.sessions.retain(sessionId, { source })` → `reference.ready` → `reference.binding.eventSource`（`ObservableSnapshot<SessionEventWindow>`）→ `getSnapshot().entries` 里筛 `entry.type === 'event' && entry.event.type === 'tool/result'`。纯 session projection 路线走不通：仓外事件类型不进宿主读路径（见第 8 条）。

**影响**：看板面板按事件顺序重放卡片投影——全量投影（`scope:'all'`）清空视图，单卡投影（`scope:'card'`）覆盖一张卡。面板挂在 `sidebar.right.pane.tab` 座，scope 是 session，运行时 props 自带 `sessionId`。

**事件窗口是分页的**：初始只装最近一页，`SessionEventWindow.hasMore` 标志更早历史未加载。面板必须驱动 `SessionFace.loadOlder()` 逐页加载到没有更早历史再重放投影，否则早期建卡/改卡不在窗口内；更糟的是窗口内若恰有 `list_cards` 的全量投影，它本应是完整列表，却被当成窗口内的部分视图看待，破坏「全量投影是权威快照」的前提。`loadOlder` 失败时宿主只记日志不抛错，故翻页设了上限（20 页），到顶则标注「仅显示已加载的历史片段」。

**P5 已绕开这条路线**：看板改成项目维度后，数据源从会话事件流换成宿主的卡片库（见[看板按项目组织](../.agents/notes/2026-10-27-project-bound-board.md)）。事件流跨不了会话（worker 建的卡不在协调者的窗口里），也扛不住宿主回收（窗口丢了卡就没了）。上面两段记录的是走这条路要付的代价，留作背景；本仓不再重放事件。

### 21. `ctx.sessions.list()` 只返回 live session——从会话推导的列表会随重启漂移

**实测**：`ctx.sessions.list()` 的注释明写「All live sessions, in creation order」（`packages/core/session/src/index.ts:1359`），只含进程内活着的会话。持久化语料在 `ctx.sessionQuery.listSessions()`（`packages/session-query/session-query/src/index.ts:174`），它合并持久化记录与 live session、live 优先（`packages/session-query/session-query/src/corpus.ts:62`），每条带 `header.cwd`。

**影响**：任何「列表」都不能只用 `ctx.sessions.list()`——进程重启后，未加载的历史会话不在其中，昨天还在的条目今天会从列表消失。项目列表因此**不**从会话推导，而是显式注册表（`projects.json`），真源是注册表而不是会话语料。

**但浏览器侧的 `ctx.sessions` 是另一个服务**（同名不同物，务必分清）：session-controller 的客户端服务用 `rootCtx.reflect.provide('sessions', …)` 注册（`packages/api/session-controller/src/client/sessions/service.ts:286`），它的 `list` 是快照存储而不是函数。快照 `getSnapshot()` 给出 `{ids, byId, phase}`，`byId` 每行带 `title` / `displayTitle` / `cwd` / `origin` / `running` / `blank` / `updatedAt`——**含全部持久会话，也含 `origin==='subagent'` 的 worker 会话**（官方左栏把后者过滤掉了，第三方读得到）。浏览器实测：225 个会话行全部带 `cwd`，其中 51 个是 subagent。快照由 host 的 `session/list` RPC 投影而来（`packages/api/session-controller/src/client/sessions/manager.ts:418-481` → `remote.session.list()`），加载前 `phase` 为 `pending`，取值要等它变 `ready`。

### 21b. 目录归组要按 realpath 比对，字符串相等不够

**实测**：同一物理目录在会话头里有两种写法——`/tmp/dsh-demo-project` 与 `/private/tmp/dsh-demo-project`（macOS 的 `/tmp` 是指向 `/private/tmp` 的符号链接）。项目记录里存的是用户给的原始路径，会话头里存的是宿主创建会话时的写法，两者字符串相等但物理目录相同。按字符串分组会把同一个项目拆成两组，且 worker 会话（由派工器注入项目目录）与协调者会话（由建项目时传入目录）常常分属两组。

**应对**：宿主侧统一做 realpath 归一化再比对——官方 workspace 注册表就是这么做的（`packages/workspace/workspace/src/entity.ts:125` 的 `realpathNormalize`）。第三方没有理由发明另一套。

### 22. 持久化会话头里没有标题与更新时间

**实测**：`SessionHeader` 只有 `version`、`id`、`createdAt`、`cwd`、`parentSession`、`isSeeded`、`origin`、`delegationDepth`、`agentPreset`（`packages/core/session/src/types.ts:95-138`），没有 `title` 与 `updatedAt`——那是客户端投影（`SessionSummary`）才有的字段。

**影响**：宿主侧从持久化语料挑会话时，只能按 `createdAt` 与 live 优先排序，取不到「最近更新」；客户端侧用 `ctx.sessions.list` 的 `SessionSummary` 才能按 `updatedAt` 排。项目名存在项目记录里，不依赖会话头。

### 23. 客户端构建产物不能用 `node:` 内置模块

**实测**：`build/client.mjs` 的 esbuild 配置是浏览器平台，引入 `node:path` 直接报 `Could not resolve "node:path"`。client 半边跑在浏览器进程里，没有 Node 内置模块。

**影响**：路径末段名称这类小工具在 client 侧得自己实现（`src/client/project-switcher.js` 的 `basenameOf`），且要同时认 `/` 与 `\` 两种分隔符——宿主可能在 Windows 上把工作目录写成反斜杠形式。

---

### 24. 系统提示词消息是会话级固定的——动态内容必须走运行时上下文

**目标形态**：角色槽位正文作为 role_context 随每轮 turn 构造注入，读的是当轮的文件内容，改完文件下一轮即生效。

**dsh 实测**：`systemPrompt.section()` 注册的段进的是**系统提示词消息**，而那条消息只在请求序列重启时重新投影（`packages/core/agent-loop/src/agent.ts:407-425` 的 `systemPrompt.project`；`startsSeries` 为假时不追加新消息）。会话建立后再注册进去的段，在后续请求的系统提示词里始终不出现——注册成功、不报错、静默失效。

**替代通道**：运行时上下文（`assembly.contexts`）没有这个限制，provider 每轮组装时重新求值（`packages/core/system-prompt/src/index.ts:582-602` 的 `refreshContext`），快照有变化才作为一条 user 消息追加（`packages/core/agent-loop/src/runtime-context.ts:152-163`）。宿主自己的 `working-directory` 上下文就是这么做的（`packages/session/working-directory/src/index.ts:97`）。

**附加约束**：上下文必须**注册成 provider**，不能只在组装事件（`system-prompt/assemble` waterfall）里临时追加——`refreshContext` 按注册表重新求值，注册表里没有的临时项在运行时被抑制时会被丢弃（`packages/core/system-prompt/src/index.ts:591`）。

**影响**：任何「随时间变化、但要进模型视野」的内容（角色、租户配置、能力开关）都得走运行时上下文，不能走 section。

### 25. `systemPrompt` 不声明在 inject 里就拿不到——即使只是要注册 provider

**dsh 实测**：`ctx.on('system-prompt/assemble', ...)` 这类绑定在服务上的事件，在插件未声明 `systemPrompt` 依赖时不触发；声明后即触发。同一段注册代码在「声明」与「不声明」两种 `inject` 下行为不同，且不报错——只是注入内容不出现。

**影响**：`systemPrompt` 需与其他核心服务一样进 `inject`。它在全部官方 bundle 都有（base 挂载、`packages/bundle/base/cordis.patch.yml:505`；sdk-minimal 自带一行；headless 在 base 之上覆盖 config），声明为必需依赖是安全的——与 `sessionController`、`workspaceRegistry` 那类「只在部分 bundle 存在、声明会让插件挂起」的服务不同。

### 26. `connection.rpc.handle` 对仓外插件不可用——但 Typert 的 SRC 通道可用

**参照形态**：渲染进程的 IPC 通道由宿主提供，插件只要拿到通道句柄就能调宿主。

**dsh 实测**：`connection` 服务提供 `rpc.handle(channel, handler)` 与 `rpc.fetch.register(route)`，但它们把路由注册到**读取 connection 的那个作用域**上（`packages/client/connection/src/rpc-host.ts:253-277` 的 `owner.webServer.register(route)`）。作用域属性访问要求该服务在作用域链上可注入，第三方 bundle 读到的 connection 服务副本带着「读取者作用域」——而 `webServer` 只挂在 web-app bundle 上，读取者作用域拿不到它的 inject 声明，注册必抛 `cannot get property "webServer" without inject`。dsh 内部也没有任何 `handle` 的使用者：官方 gateway 走的是 `rpc.intercept('/api', …)`，而 `/api` 每条通道只允许一个拦截器，第三方插不进去。

**可走的路：Typert 的 SRC 通道**。宿主 gateway 在 strict 生成描述符缺失时走 SRC 回退（`packages/api/gateway/src/index.ts:868-879` 的 `resolveDescriptor` → `resolveSrcDescriptor`），它按服务原型上的方法标记与实例上的服务绑定还原调用描述符，参数名从方法源码的形参解析。标记契约是**稳定字符串 + 版本化描述符**（协议包 `@deepseek-ai/dsh-typert-protocol` 把标记写在原型属性 `@deepseek-ai/dsh-typert-protocol/remote-methods` 上，值为 `{version:1, methods:[{method, invocation:{kind:'direct'}}]}`），宿主读标记时**不校验来源包的版本**——第三方手写同样的形状即可，不必安装 dsh 内部包。

**要满足的条件**（缺一即失败）：

- 服务必须以 Cordis 服务身份注册（`ctx.provide(key, instance)` 会把 `ctx.reflect.props[key]` 记为 `{type:'service'}`，SRC 回退按这个标记遍历）；
- 实例上要有 `typertRemote` 绑定，字段为 `{service, serviceKey, namespace}`，其中 `service` 必须指向实例本身（宿主拿它与调用时取到的实例比对）；
- 原型上要有方法标记，方法名与实例方法名逐字一致；
- 方法的形参名就是 wire 字段名，宿主按源码解析形参，客户端必须传同名字段，多一个少一个都会被 `gateway/arguments-invalid` 拒掉；
- 客户端侧 `$mount` 的贡献里每个入参都要带 strict codec（`requireStrictInputs` 会拒收没有 strict codec 的描述符），宿主侧的 SRC 描述符则一律 `src-json`。

**影响**：浏览器侧 → 宿主侧的调用不必自建 Web 路由（那条路要自己处理同源校验与错误形状，鉴权弱于官方 `/api`），也不必装 dsh 内部包（装它会被宿主的 peer/engines 校验卡住）。本仓取 Typert SRC 通道，见[项目作用域与角色槽位](.agents/notes/2026-10-23-project-scope-and-role-slots.md)。代价是手写的协议形状与宿主版本耦合——宿主改标记契约时本仓要同步改。

### 27. 左栏没有与工作区并列的区块槽——第三方只能靠 DOM 注入取位

**参照形态**：左栏是三个并列区块（项目类目 → 置顶区 → 工作区类目），项目是独立的一等公民。

**dsh 实测**：左栏正文区只有**一个** `sidebar.workspaces` 槽（single，已被宿主的 `WorkspaceBrowser` 占；重复注册抛 `single slot "sidebar.workspaces" already has a registration`，`packages/client/ui-slots/src/index.ts:1220-1222`），slot 机制没有 decorator/HOC 或包装能力（`packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx` 与 `deriveGroups` 都未导出，无法复用渲染逻辑）。左栏可用的 list 槽只有两个：`sidebar.panellist`（occupant 只放 glyph，须与 `main` 同 id 成对注册）与 `sidebar.footer.action`（occupant 可渲染任意内容，位置在工作区下方、设置按钮上方，`packages/client/ui-sidebar/src/client/SidebarRoot.tsx:405-412`）。

**可行的取位办法**：左栏的 DOM 结构是「面板列表 `nav` → 工作区滚动区 → 底部区」（同文件 `:395-412`）。footer occupant 里放一个锚点，向上找到第一个「直接子元素含 `nav`」的祖先作为左栏根，在 `nav` 之后插一个容器，用 React portal 把内容渲染进去，位置就是「自动化任务之下、工作区之上」。宿主结构变了导致找不到锚点时，内容退回原槽渲染，功能不受影响——降级路径必须留着。

### 28. Typert 远程方法的名字要避开官方命名空间服务的保留字

**dsh 实测**：客户端挂载贡献时，官方命名空间服务逐个检查方法名（`packages/api/gateway/src/client/index.ts` 的 `RemoteNamespaceService.assertMethodAvailable`）：撞上命名空间服务自身的字段（`ctx`、`name`、`methods`、`namespace` 等）、它原型上的成员（`:707` 的 `remove(kind, method, token)`），或 Cordis 服务原型的成员，即拒收整个命名空间，报 `client api: method "projects/remove" conflicts with its namespace service`。`remove` 命中的是 `RemoteNamespaceService.prototype.remove`——**不是** Cordis 服务原型的成员（`'remove' in Service.prototype` 在 vendor/cordis 上实测为 false），照后者判断会得出「没撞名」的错误结论。

**影响**：第三方远程方法要挑业务前缀足够远的名字（本仓叫 `deleteProject`），否则整个命名空间挂不上，表现为界面上一片「通道未就绪」而不是某个方法缺失。

### 29. 官方只有工作区树，没有项目树；「按项目排除会话」也没有扩展点

**参照形态**：项目与工作区是左栏里两个并列的区块，同一个会话只出现在项目下。

**dsh 实测**：官方左栏只有一棵按工作区分组的会话树，没有「项目」这个维度；`sidebar.workspaces` 槽是 single 且已被官方的 `WorkspaceBrowser` 占用，第三方既换不掉渲染也拿不到分组逻辑（见第 27 条）。官方会话行带 `data-row-key="session:<id>"`（`packages/client/ui-workspace/src/client/rows/Rows.tsx:666`），但没有「按外部集合排除行」的接口。

**唯一能用的官方接口是归档**：`workspaceRegistry.archiveSession` 会把会话从**所有**分组面里摘掉（`packages/workspace/workspace/src/index.ts:344-392`）。但归档是用户可见的持久状态——会话会出现在官方的归档视图里，注销项目时得逐个反归档，用户自己归档过的会话更不能被反归档。借用它做「排除」会把两件事搅在一起。

**可行的办法**：本仓自建项目树（一个项目 = 一个目录，项目下挂该目录的会话），与官方工作区树**并行**；重复出现的部分走**渲染层**排除——认 `data-row-key` 的会话 id，命中排除集的行加一个类，由样式表隐藏，官方数据层不动。排除集由宿主按目录判定后经远程方法下发：浏览器没有文件系统，做不了路径归一（见第 21b 条）。

**代价**（都记在 note 里）：官方分组行上的会话计数仍包含被隐藏的会话，数字与可见行数对不上；被隐藏的行仍在 DOM 里，官方搜索等按数据层工作的功能仍能命中它们。

### 30. Typert 的「通道就绪」通知只发一次，订阅晚于挂载就收不到

**dsh 实测**：客户端的命名空间服务在 `$mount` 完成之后才注册（服务键 `remote.<namespace>`），挂载完成前的调用拿不到命名空间，抛的是「通道不可用」而不是「方法不存在」。

**影响**：本仓的「就绪」通知只在挂载那一刻发一次。面板若在挂载完成之后才订阅（例如 React 首次挂载晚于插件 apply），就永远收不到那次通知——表现是「项目列表能出来，但另一个方法一直报通道不可用」，因为两者订阅时机不同。订阅时就必须判一次当前状态，已就绪则补一次通知。

### 31. web 端没有运行时图标 sprite——第三方 bundle 的 `<use>` 引用必然落空

**dsh 实测**：图标有两套渲染路径：源码里 `ui-primitives` 的 `Icon` 组件用 `<use href="#dsw-icon-<字形>-<字重>">` 指向文档级 sprite（`packages/client/ui-primitives/src/icons/index.tsx:18-24`），`ui-theme` 在 apply 时装 sprite（`packages/client/ui-theme/src/client/index.ts:602` → `icon-sprite.ts` 的 `installIconSprite`，把 symbol 挂进 `document.body`）。但 **web 端产物里 sprite 不存在**：探针实测运行时 DOM 里 `symbol` 数为 0、`[data-dsh-icon-sprite]` 不存在，宿主自己的图标全是内联 path（构建期就把 sprite 展开进了各组件产物）。

**影响**：第三方 bundle 是运行时才渲染的，拿不到那份构建期产物，`<use href="#dsw-icon-…">` 一律引用不到——图标尺寸为 0×0，**完全不可见且不报错**。第三方要出图标只能自带路径数据（本仓内联宿主 `artwork.ts` 的 regular 字重路径），代价是与宿主图标数据耦合。

### 32. 会话不归属工作区，官方 UI 就打不开它

**dsh 实测**：`session.create` 只在传 `workspaceId` 时才会把会话挂进工作区（`packages/api/session-controller/src/commands.ts:105-145` 里的 `workspace.attachSession(sessionId)`）；传 `cwd` 建出的会话**不归属任何工作区**。工作区实体的 `attachSession(sessionId)` 会校验会话头 cwd 与工作区 path 一致（`packages/workspace/workspace/src/entity.ts:102-130`），`WorkspaceRegistry.create(path, title?)` 是幂等的（`packages/workspace/workspace/src/index.ts:170-240`）。

**影响**：第三方自建的会话（协调者会话就是这类）在官方 UI 里没有位置——调用 `uiWorkspace.openSession(sessionId)` 后主区域仍停在欢迎页，官方工作区树里也找不到它。要让会话能被官方 UI 打开，必须把它挂进工作区；目录还不是工作区时得先注册一个（副作用：用户的工作区列表里会多出该项目目录）。

### 33. 官方工作区没有「隐藏」位——第三方注册的工作区只能从渲染层藏

**dsh 实测**：工作区记录是封闭 schema（`packages/workspace/workspace/src/spec.ts` 的 `workspaceRecord`：只有 `path` / `title` / `sessionIds` / `createdAt` / `updatedAt`），没有备注、标签或可见性字段；归档只作用于会话（`workspaceDomainState.archivedSessionIds`），工作区级别没有归档。工作区实体的公开接口（`packages/workspace/workspace/src/types.ts`）也只有 `setTitle` / `attachSession` / `insertSessionBefore` / `detachSession` / `status`，没有隐藏或删除可见性的方法。

**影响**：第三方为了让自己建的会话能被官方 UI 打开（见第 32 条）不得不注册工作区，那个工作区就会出现在官方左栏的工作区树里，而官方没有「按外部集合隐藏分组」的扩展点。可行的只有两条路：**归属**记在第三方自己的注册表里（第三方知道哪些工作区是自己建的，宿主的封闭 schema 不必改），**隐藏**走渲染层（官方工作区分组行带 `data-row-key="workspace:<id>"`，命中集合的行由样式表隐藏）。代价是隐藏只在左栏成立——欢迎页的工作区选择器与工作区管理面板仍列着它；官方的工作区控制器不走 `/api` 通道（`/api/workspaces/list` 与 `/api/workspaces/rename` 均 404），第三方只能经 `workspaceRegistry` 服务改它，删除入口因此放在第三方自己的项目菜单里（删除项目时把它一并删掉），并配二次确认弹窗——弹窗不能复用官方 `Modal` 组件（第三方 bundle 不得 import 宿主 UI 包），只能照 `packages/client/ui-primitives/src/Modal.tsx` 复制改写。

### 34. 空会话一律渲染欢迎页——没有「标记会话非空」的入口

**dsh 实测**：主区域的形态由 `conversationPhase(session, conversation)` 决定（`packages/client/ui-conversation/src/client/contract/snapshot.ts:26-33`）：会话为空时返回 `'blank'`，`ConversationMainPanel` 据此渲染居中的大标题与居中输入框（`packages/client/ui-conversation/src/client/skeleton/ConversationMainPanel.tsx:33-52`，形态同时写进主区域的 `data-phase` 属性）。会话「空」的真源是宿主投影 `sessionListMetadata.blank`，而它只被 `turn/start` 事件翻成 false（`packages/api/session-controller/src/list.ts:47-58`）；宿主没有提供「把会话标记为非空」的命令，客户端的 `promptAttempted` 是纯内存态（`packages/client/ui-conversation/src/client/session.ts:313` 的 `onEngaged` 只在本地 `prompt()` 成功后触发），刷新即失。

**影响**：第三方建的会话（协调者会话就是这类）打开后**默认是欢迎页**。绕开的路径逐条被排除：客户端伪提交会留下假的「用户已发送」态且刷新即失；零消息空轮次不可达（`agent-loop` 的 `turn()` 同步执行 `preStep`，而 `preStep` 第一步就是同步 `inbox.claim`，`claim` 非空则必然走模型调用）；`agent/pre-step` 拒答语义不诚实；fork 一个有 turn 的会话循环依赖；伪造 `turn/start` 等于伪造宿主历史。

**绕过（已实现，不动宿主投影）**：宿主判定的第一个条件是 `conversation.activeTargets.size > 0`——只要有一个会话视图目标处于激活态，外壳就切到 active 形态（输入框停靠底部），与「会话是否为空」无关。这条路径宿主明确对第三方开放（`docs/subsystems/conversation.zh.md:26,28`：「第三方 View 使用相同的选择与激活操作」），槽位目录也直接给了第三方注册 `conversation.view` 条目的示例（`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:2105`）。于是本仓注册一个只提供活动、不产出内容的视图目标，在协调者会话打开时激活它：会话**仍然是空的**（转录零节点、不跑首轮、不产生模型调用），外壳已经是「发了消息之后」的那个 View。代价是 `uiConversation` 不在机器可读的插件 API 目录 `api-catalog.ts` 里——宿主改这条契约时本仓要同步。


### 35. 「等你输入」档暂无数据源——宿主机制在，但当前没有域发布待处理交互

**参照形态**：信号灯五档——`waiting`（等你输入）、`attention`（需注意）、`running`（执行中）、`idle`（空闲）、`no-sessions`（无 worker），其中「未看 / 已看」还区分未看等待光环与已看等待慢脉冲。

**dsh 实测（更正此前结论）**：宿主**有**「等你输入」与「未读」两项，只是不在会话快照里。会话快照 `SessionSnapshot`（`packages/api/session-controller/src/client/contract/snapshot.ts:69-96`）确实只有 `running`、`lastAgentError`、`blank`、`awaitingFirstTurn`、`pendingSubmissions`——但那只是会话控制器的一层。客户端状态存储 `SessionStatus`（`packages/client/ui-session/src/client/index.ts:60-67`）有三项：`running`（宿主按 `api-session/status` 事件维护的权威运行态）、`pendingInteraction`（域发布的待用户交互请求）、`completionUnread`（会话停下且不在主视图，仍需确认）。这份存储由 ui-session 通过 `ctx.slots.provideRoot({ hooks: { sessionStatus } })` 提供，`sidebar.right.pane.tab` 的标准 prop 里就有 `useSessionStatus`（`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:3877`），第三方取用不需要 import 宿主 UI 包。官方 AgentTeam UI 读的就是它（`packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx:83-84`）。

**影响**：「未读」档已接上并实测跑通（worker 子会话跑完 → `completionUnread` 为 true → 蓝点；主视图里的会话未读被清）。「等你输入」档接的是 `pendingInteraction`，但宿主的 `SessionPendingInteractionMap`（同文件 50-51 行）是空的声明合并表——**当前没有任何域发布待处理交互**，这一档恒为不触发。机制留着，档位留着，等真有域发布时自动生效；现在不会亮。

### 36. 卡片没有写方法——详情只能只读

**目标形态**：卡片详情浮层带编辑能力（改标题、状态、链接、槽位、排序）。

**dsh 实测**：宿主官方未暴露通用远程方法注册面（`connection.rpc.handle` 对仓外插件不可用）。但浏览器侧 → 宿主侧的写通道**本仓已经有了**：自建的 Typert SRC 命名空间 `projects`（见第 26 条）在 P3 实测通过，8 个写方法（create / deleteProject / rename / replaceCoordinator / attachCoordinator 等）都跑通了。缺的不是通道，是**卡片自己的写方法**——而卡片的写入语义（revision 乐观并发、归档终态）住在 host 侧的卡片存储里，改卡要走那套规则。

**影响**：本轮卡片详情浮层只读，完成、置顶、重命名、删除都没做，卡面也不放操作按钮。补齐是本仓自己的活：在 `projects` 之外加一组卡片远程方法，宿主侧转调卡片存储的既有领域规则。属独立议题，不是宿主拦路。

### 37. 工具面只能按身份**同步**判定，而判定发生在建会话内部——身份必须先于会话存在

**目标形态**：协调者会话一出生就拿到编排工具（`spawn_worker` / `message_worker` / `list_cards`），不必等下一轮或重启。

**dsh 实测**（`0.2.1-rc.2`）：

- `tools.restrict()` 要求 scoped context，`ctx.tools` 上没有「首轮请求前再判一次」的钩子；agent 相关生命周期事件只有 `agent/created` 与 `agent/disposed`（声明在 `packages/core/agent/src/runtime-types.ts:290`、`:299`），没有 step 级事件可挂。
- `agent/created` 在 `agents.create()` / `sessionController.create()` **内部**就发出来了（`packages/core/agent/src/index.ts` 的 `CreateAgentOptions.setup` 更早：`setup` → `agent/created` → 首轮 prompt 组装）。
- `restrict()` 是**追加**一层限制并返回 disposer（`packages/core/tools/src/index.ts:162-189`）；能撤回，但没有「按新身份重算」的入口，撤回后要自己重新裁一遍，且必须拿到那个 agent。
- `sessionController.create(request)` 与 `agents.create({ sessionId })` **都接受调用方传入的 sessionId**；`sessionController` 侧逐层透传（`create` → `createSession({ sessionId })` → `claim(named)` → `createAgent(sessionId)` → `ctx.agents.create({ sessionId })`），`dsh-agent` 另有硬断言保证 `agent.id === session.id`。

**影响**：同进程内「先建会话、再登记身份」的顺序一定裁错档，且裁错的限制不会自己松开（要等该会话下次冷恢复重算）。绕法只有两条：让身份先于会话存在（预生成 `sessionId` 先登记，本仓采用），或保存 `restrict()` 的 disposer + `ctx.agents.get()` 事后重裁（多三个不确定点，还得赌重裁早于首轮请求组装）。前者是唯一不需要事后纠正的做法。

### 39. 轮次结束只有一个信号（`session/event` 的 `turn/end`），产出要自己从 `assistant/message` 折叠

**目标形态**：worker 那一轮结束时由机制侧取产出并回报，不要求模型调用任何「报告完成」的工具。

**dsh 实测**（`0.2.1-rc.2`）：

- `session/event` 是公开 emit 事件，回调收到 `(session, event)`，`event` 是完整的 `SessionEvent`（`{ type, seq, time, data }`，声明在 `packages/core/session/src/index.ts:76`）。宿主自己的 `agent-loop`、`token-meter`、`agent-instructions`、`agent-team` 等都在订阅它——仓外插件同样可用（第 8 条只禁**新增**事件类型）。
- `turn/end` 是真正的 session event（`packages/core/session/src/known-event-types.ts:79`），由 agent-loop 在 `finally` 里 append，payload 是 `{ turn, reason }`。`reason.kind` ∈ `completed` / `aborted` / `blocked` / `error` / `max-tokens` / `interrupted` / `forked`（`packages/core/session/src/types.ts:206-237`；`forked` 是 fork seed 关闭未结束的 turn 时用的），可直接当终态判据。
- 一个 turn 是 `agent.run()` 的一次调用，内部含多个 step（`packages/core/agent-loop/src/agent.ts:336-422`），所以「一次派工 = 一个 `turn/end`」。轮次内的 assistant 文本在 `assistant/message` 事件里（`data.message.content` 是块数组），同一 turn 有多条，取最后一条非空即可。
- 宿主 subagent 就是这么做的：`captureLocalResult()` 用 `finalAssistantOutput(events)` + `epochStopReason(events)` 从会话事件折叠产出与 stopReason（`packages/subagent/subagent/src/activation.ts:154`）。但那是内部包导出，仓外插件不能依赖——同样的折叠要自己写，量很小（文本块拼接 + `turn/end.reason` 映射）。

**影响**：不需要 worker 协作式回报（少一个工具、也少一个「模型忘了就不动」的失败模式），代价是结算点绑在 `turn/end` 上：进程在轮次结束前被杀，这一轮就不会结算（在飞表在内存里，重启即空）。原先「宿主没给第三方留读最后一轮产出的稳定 API」的判断不成立——`sessionQuery.readSession()` 返回完整 `SessionEvent[]`，只是读完整个会话不如订阅事件边攒边用。

---

### 38. 内建工具挂在 agent preset 组合里，`sessionController` 之外的建会话路径要自己挂

**目标形态**：自己用 `agents.create` 建的根会话（本 bundle 的 worker）能拿到 `bash` / `read` / `write` 这些内建工具。

**dsh 实测**（`0.2.1-rc.2`）：

- 内建工具按 **agent preset** 的组合挂载，preset 文件里逐条列插件行（`packages/bundle/web-app/presets/standard.patch.yml` 是 `- id: tool-bash` / `tool-pwsh` / `tool-fs` / `tool-fs-search` …）；`read` / `write` / `ls` 是 `tool-fs` 那个插件提供的**工具名**，没有 `tool-read` / `tool-write` 这样的行 id。没有 preset 层的会话只有全局注册的工具。
- 挂载只由 `sessionController` 的 `composeAgent()` 做，**创建与 resume 两条路径都走它**：`presets.resolve(id)` 之后以 `setup: agentCtx => presets.mount(agentCtx, resolvedId)` 交给宿主（`packages/api/session-controller/src/agent.ts`）。
- `agents.create({ sessionId, setup })` / `agents.resume({ resumeSessionId, setup })` 都接受 `setup`，但**不会**自己解析或挂 preset；不传 `setup` 的会话，工具面里没有这些内建工具。
- `agentPresets.mount(ctx, id?)` 在 rc.2 就有（`packages/preset/agent-preset-registry/src/index.ts`），省略 id 用 `defaultId`。
- 建会话时还要写 `meta.agentPreset`（`CreateAgentOptions.meta` 的公开字段）：`sessionController` 建会话就写，resume 与 UI 都从会话投影读回。只挂 `setup` 不写投影，会话能跑但投影是空的。
- 读回投影的入口在 rc.2 是 `ctx.get('sessionProjections').stateOf(session, 'agentPreset')`（registry 自己也这么读，`packages/preset/agent-preset-registry/src/index.ts:357`）。**registry 的 `presetForSession()` 是 0.2.2-alpha.2 才有的**，rc.2 上只有 sessionController 有同名方法——按下限写代码时别用它。

**影响**：绕开 `sessionController` 建会话时（本 bundle 为了 worker 常驻与冷恢复必须走 `agents.create`），必须自己把 `agentPresets.mount(agentCtx, id)` 塞进 `setup`、并把 id 写进 `meta.agentPreset`。漏了三处都中招：建 worker、冷恢复 worker、没有 `sessionController` 时建协调者——症状统一为「会话能建起来，但模型没有 bash / read，连 `pwd` 都跑不了」。

**相邻的坑**：`tools.get(name)` 省略 scope 等于**全局视图**。web-app 把 `tool-subagent` / `tool-subagent-control` / `tool-subagent-fork` 在宿主平面 `disabled: true`（`packages/bundle/web-app/cordis.patch.yml`），改由 preset 子树注册——用 `get(name)` 探测这三件会全部返回 undefined。工具名存在性只能靠 `restrict()` 的失败来判（见 `src/host/tools/gate.js` 的 `applyToolGate`）。

---

## 四、工具级（已验证可用，无缺口）

表里的工具名反映实测当时的版本：项目注册表工具（`add_project` 等）与 `init_project` 已在后续版本删除，项目改由左栏区块操作、初始化改为纯 skill；这些行保留为宿主能力的实测证据。

| 能力 | 实测结果 | 证据 |
|---|---|---|
| bundle 作为第三方 bundle 分发 | 通过 | `dsh plugin --profile headless add ../dsh-leader-kit` 后 `dsh.profile.bundles` 含 `dsh-leader-kit` |
| `ctx.tools.register` | 通过 | 模型调用 `init_project` 成功，目标目录生成 `AGENTS.md`（4307 字节，含受管区块） |
| `ctx.skills.registerProvider` | 通过 | `ctx.skills.list()` 返回 `leader-mode` 与 `init-project`，provider `dsh-leader-kit`，source `bundled` |
| 免凭据跑真实会话 | 通过 | dsh 自带 mock LLM server（`packages/test-support/llm-mock-server`）+ `DEEPSEEK_BASE_URL` 覆盖 |
| 包名子路径解析 | 通过 | `exports` 映射 `"./src/host": "./src/host/index.js"`；ESM 不支持目录索引，必须指到文件 |
| 后台派工（派完即返回） | 通过 | `spawn_worker` 立即返回子会话 id，父 turn 正常结束，worker 在后台继续 |
| 完成自动唤醒 | 通过 | 父 inbox 收到完成通知（正文不带说话人前缀）后状态 `idle → running → idle`，通知队列清空 |
| 协议层与工具对模型可见 | 通过 | 模型侧工具列表同时含 `init_project` 与 `spawn_worker`；skill catalog 含 `leader-mode` 与 `init-project` |
| 原生工具管理子会话 | 通过（源码核验） | base bundle 启用 `tool-subagent-control` 与 `tool-subagent-control/list-agents`；`agent_id` 即子会话 id |
| 卡片存储与领域规则 | 通过 | 49 例单测全绿；sdk profile + mock LLM 实测建卡/改卡/查卡/版本冲突 |
| 客户端取数通道 | 通过 | `output.presentationMeta` 投影的 `meta` 随 `tool/result` 事件持久化，实测携带完整卡片对象 |
| 右栏看板 client 半边 | 通过 | web profile boot manifest 含本包条目（71 条目）；浏览器右栏出现「看板」Tab 并显示卡片；插件行名须为纯包名（见第 18 条） |
| 面板读会话事件 | 通过 | `ctx.sessions.retain` → `binding.eventSource` → 筛 `tool/result` 事件取 `meta`（见第 20 条） |
| 项目注册表（host 侧） | 通过 | `add_project` 落盘 `projects.json` 并建协调者会话；`list_projects` 返回注册表条目并标注协调者是否存活（见第 26 条） |
| 解析目标项目（host 侧） | 通过 | `switch_project` 按 id 或名字返回该项目的协调者会话；协调者会话已删时如实说明需换新协调者 |
| 项目区块（client 侧） | 通过 | web profile 实测：左栏「项目」区块位于「自动化任务」之下、工作区之上，列出已注册项目（含目录路径）；数据走 Typert SRC 通道，浏览器实测取回列表（见第 26 条） |
| 项目树（client 侧） | 通过 | 点行首槽位展开，列出该项目目录下的会话（协调者不在其中，会话行为纯文字行、无左右图标）；归属由宿主按 realpath 判定后经远程方法下发（见第 21b、29 条） |
| 点项目打开协调者会话 | 通过 | 点项目行 → 先由宿主把协调者会话挂到项目目录的工作区，再打开会话；协调者会话注册并激活了第三方会话视图目标，官方外壳因此切到 active 形态（见第 34 条），浏览器实测主区域 `data-phase` 由 `hero` 变 `active`、页面无「Into the Unknown」、转录零节点、输入框几何与官方 active 布局一致 |
| 项目删除（连同工作区） | 通过（接口层已验、GUI 未取证） | 项目菜单只有一条「删除」，先弹二次确认：项目记录删掉，插件注册的工作区随 `workspaceRegistry.delete` 一并移除（只删注册，会话与目录全保留，会话落到工作区树的「未分组」下）；复用的用户工作区不碰（见第 33 条）。隔离 `DSH_HOME` 的 web 实例上按接口层实测过删带工作区与不带工作区两种项目（`workspace.json` / `projects.json` 终态对得上）；菜单三项的渲染、两支弹窗文案与提示条样式仍待一次绑定工作区的浏览器会话 |
| 官方工作区树排除项目会话 | 通过 | 浏览器实测：官方树里 `test` 工作区下的项目会话行被加隐藏类，`getComputedStyle` 为 `display:none`；官方数据层未动（见第 29 条） |
| 产品图标 | 通过（内联路径） | 宿主 web 端运行时无 sprite，`<use>` 引用必然落空（见第 31 条）；改为内联路径后浏览器实测图标尺寸 14×14 / 16×16、path 齐全 |
| 角色槽位注入 | 通过 | `ctx.systemPrompt.context()` 注册运行时上下文（见第 24–25 条）；改 `SLOTS.md` 正文后下一轮 turn 注入新正文；注入前后两轮请求的工具定义数组逐字节一致（32 个工具） |
| 看板卡面与详情浮层 | 通过 | P4 重做卡面（active 三层 / done 单行 / 链接 chip 实测排布 / 信号灯七档 / 只读详情浮层 / 已完成折叠区）；mock LLM 触发真实卡片工具建卡后浏览器实测渲染，console 无报错（见第 35、36 条） |

---

## 五、待验证

- **worktree 隔离**：team 明确不提供 worktree；`dsh-experimental-worktree` 是否能接入编排约定，未实测。
- **真实模型下的协议遵循**：本轮用 mock 触发的工具调用验证了工具通路，未验证模型在真实推理下是否按协议层派工。
- **web 组合下的唤醒**：P1 的完整链路在 sdk profile 验证；web profile 的组合更接近真实使用，但其会话由 UI 创建，尚未用同一套探针跑通。
- **`list_agents` 能不能列出 worker**：已于 2026-10-29 定论——worker 是 `ctx.agents.create` 建的根会话，不在 subagent 目录里，`list_agents` 列不到（见第 13 条）。
- **看板的信号灯**：信号灯纯投影已在 P4 实现（七档：等你输入 / 需注意 / 执行中 / 未读 / 空闲 / 状态未知 / 无信号，聚合自槽位会话状态，不落存储）。运行态与未读读宿主会话状态存储（`useSessionStatus`），已实测跑通；「等你输入」档暂无数据源（见第 35 条）。

