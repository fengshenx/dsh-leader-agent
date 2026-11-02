# dsh-leader-kit

DeepSeek Harness 的协调者/执行者编排 bundle：多 Agent 编排协议 skill、项目初始化 skill、后台派工与完成唤醒、任务看板卡片，以及交付看板 UI。

当前状态：**P5 已完成**，累计交付：骨架 + 协议层 + 初始化 + 派工唤醒 + 卡片存储与卡片工具 + 右栏看板 UI + 项目注册表与左栏项目区块 + 角色槽位注入 + 看板卡面重做 + 看板按项目组织 + 建卡后自动打开看板。此后删除了项目注册表工具与卡片检查点（见[笔记](.agents/notes/2026-10-29-drop-project-tools-and-card-checkpoint.md)），并把看板开放给项目会话（协调者与 worker）、右栏入口按会话过滤（见[笔记](.agents/notes/2026-10-30-board-entry-per-session.md)）。

阶段编号（本 README 与 `docs/capability-gaps.md`、`.agents/notes/` 通用）：P0 调研与能力缺口实测 · P1 协议层、初始化与派工唤醒 · P2 卡片存储与右栏看板 · P3 项目注册表与角色槽位 · P4 看板卡面 · P5 查卡分页、卡片项目归属、项目看板与项目树 worker 会话。

## 组成

| 部件 | 位置 | 说明 |
|---|---|---|
| 协议层 skill | `skills/leader-mode/` | `SKILL.md` + 4 个 playbook + 2 份参考：派工、接力、事件调度、卡片维护、传话纪律、验收裁决、进度说明 |
| 初始化 skill | `skills/init-project/` | 一次性把仓库工程约定写入目标项目：skill 给出方法与正文，模型用宿主的文件能力写 `AGENTS.md` 受管区块，幂等 |
| `spawn_worker` 工具 | `src/host/tools/spawn-worker.js` | 建一个常驻 worker 会话并即刻派活，**立即返回**会话 id，不等结果 |
| `message_worker` 工具 | `src/host/tools/message-worker.js` | 给 worker 续聊：活着就直接投，进程重启后冷恢复再投；可顺手 `rename` 改名 |
| worker 会话 | `src/host/worker-sessions.js` | worker 的创建、投递、销毁：`agents.create` 建的**普通根会话**，常驻、可被人下钻对话、进程重启后能冷恢复 |
| worker 登记表 | `src/host/worker-registry.js` | 会话 id → 父会话与名字的落盘映射（`workers.json`）：续聊跨进程也要找得到归属 |
| 派工与唤醒 | `src/host/dispatch.js` | 建会话、在 worker 轮次结束时从会话事件结算产出、落盘完成通知、唤醒父会话开新 turn |
| 通知落盘队列 | `src/host/notification-store.js` | 完成通知先写盘再唤醒；投递失败留队，父会话重开时补投 |
| 卡片工具 | `src/host/tools/cards.js` | `create_card` / `update_card` / `list_cards`：建卡、改卡、查卡。卡片按项目归属（宿主按调用方会话判定，模型不传项目参数），`list_cards` 默认只列本项目，`scope=all` 才跨项目 |
| 卡片存储 | `src/host/cards/store.js` | 卡片落盘与领域规则：编号不复用、revision 乐观并发、归档终态、项目归属字段 |
| 项目存储与服务 | `src/host/projects/` | 项目注册表（`projects.json`）与项目服务：建项目连带建协调者会话并绑定，失败整体回滚。注册表只经左栏项目区块读写，模型没有对应工具 |
| 项目通道 | `src/host/projects/remote.js` | 浏览器侧 → 宿主侧的 Typert 远程通道（命名空间 `projects`，走官方 `/api` 共享通道） |
| 工具面分配 | `src/host/tools/gate.js` | 按调用方角色裁剪工具：协调者全有，普通会话与 worker 都没有编排与全库查询 |
| 会话归属 | `src/host/projects/session-index.js` | 按 realpath 把会话归到项目目录，得出「项目 → 会话」映射 |
| 角色槽位 | `src/host/slots/` | 读项目目录的 `SLOTS.md`，按卡片 `slots` 字段绑定到会话，作为运行时上下文注入 |
| 协调者手册 | `src/host/coordinator-context.js` | 读项目目录的 `COORDINATOR.md`，注入该项目的协调者会话：按身份决定，不需要卡片绑定 |
| skill provider | `src/host/skills.js` | 把 bundle 内的 skill 注册进 `ctx.skills`，让模型能通过 dsh 的 `skill` 工具发现与加载 |
| 右栏看板 Tab | `src/client/index.js`、`src/client/board-guide-entry.js` | 浏览器侧注册「看板」Tab 类型与面板主体；「开始」页的入口由本插件接管渲染，只在项目会话（协调者与 worker）里画出来 |
| 看板面板 | `src/client/board.js` | 项目维度的任务看板：按当前会话解析出所属项目，再按项目拉卡片；**只对项目会话（协调者与该项目派出的 worker）展示**，同目录里的普通会话只看到提示；分组、排序、已完成折叠区与空态/骨架 |
| 看板取数 | `src/client/project-board-data.js` | 解析会话所属项目、判定项目会话（协调者 / worker）、拉该项目的卡片、算出新增卡片 id（纯函数，可单测） |
| 看板监视器 | `src/client/project-board-monitor.js` | 建卡后自动打开（或聚焦）右栏看板 tab：只跟随项目协调者会话（worker 不自动弹），轮询项目卡片，出现新卡才开 |
| 看板卡面 | `src/client/board-card.js`、`src/client/board-styles.js` | active 卡三层（标题行 / 链接行 / 槽位行）、done 卡单行变体、链接 chip 按实测宽度排布、信号灯七档、卡面零操作铬 |
| 卡片详情浮层 | `src/client/card-detail.js`、`src/client/modal-shell.js` | 只读详情浮层（说明 / 链接）；浮层外壳（portal、遮罩、ESC、Tab 焦点陷阱、初始焦点、关闭回焦）与确认弹窗共用 |
| 左栏项目区块 | `src/client/project-panel.js` | 左栏「项目」区块：在「自动化任务」之下、工作区之上（DOM 注入取位），加项目（选目录即建好）、点项目行打开协调者会话、换新协调者、删除项目 |
| 项目树 | `src/client/project-section.js` | 点标题折叠/展开整个项目列表，点行首槽位展开/收起该项目的会话行（worker 与被换下的协调者；当前协调者与用户手动开的会话都不在其中，会话行是纯文字行，无左右图标）；点项目行本身是打开该项目的协调者会话；项目名后面不跟路径。行首槽位与官方工作区行同款：平时是目录图标，悬停整行换成展开箭头，展开时箭头旋转朝下；「更多」在行右端，悬停时出现。项目下的会话列表按水位折叠（见下一行） |
| 会话水位折叠 | `src/client/session-watermark.js` | 复刻宿主工作区树的口径：默认露出 5 条，每次「展开其余 N 个会话」再加 5 条，剩余不足 5 条时一次放完；运行中的会话把水位抬到它所在位置（只在前 50 条内生效）；水位只升不降，收起回落到基线；每个项目各算各的，状态不持久化 |
| 会话归档 | `src/client/project-panel.js`、`src/host/cards/store.js` | 悬停会话行，右端露出归档按钮（与官方会话行的 hover 动作同形：24×24、三级标签色）。归档走宿主的 `workspaces.archiveSession`，成功后摘掉卡片上指向该会话的槽位、删掉派工登记；会话正在跑时弹「停止并归档」确认，其余失败直接报错 |
| worker 回报气泡 | `src/client/worker-report-view.js`、`src/client/worker-report-styles.js` | 回报正文默认折两行（`-webkit-line-clamp`），内容真的超两行时下方才出现「展示更多」，展开后变「收起」；气泡底色是前景色 2% 的极淡一层，边界由 1px 边框交代 |
| 产品图标 | `src/client/icons.js` | 内联图标路径（宿主 web 端运行时没有 sprite，`<use>` 引用必然落空） |
| 官方树排除 | `src/client/workspace-exclusion.js` | 把项目的协调者与 worker 会话从官方工作区树里隐藏（渲染层，官方数据层不动）。worker 是普通根会话，官方树不会自己滤掉，按会话 id 排除。项目自建的工作区整组藏掉、组内行一起（见边界「项目自建的工作区从官方树里藏掉」）。当前会话就是被排除的那条时，它所在工作区行的激活图标压回普通色 |
| 删除项目确认弹窗 | `src/client/confirm-dialog.js` | 「删除」的二次确认弹窗：讲清项目连同插件注册的工作区一起删、文件夹与会话记录保留（复用 `modal-shell.js` 的浮层外壳：遮罩点击 / Escape / Tab 焦点循环 / 初始焦点 / 关闭后焦点返回） |
| 协调者会话形态 | `src/client/coordinator-view.js`、`src/client/coordinator-view-logic.js` | 协调者会话注册一个第三方会话视图目标并激活它，官方外壳因此切到 active 形态——输入框停靠底部、会话区保持空白。没有消息、没有模型调用，也没有欢迎页 |

bundle **零运行时依赖**：只用 Node 内置模块与 Cordis 注入的 `ctx`，不 peer 依赖任何 dsh 内部包——避免宿主解析失败导致整个 bundle 加载失败。

## 编排动作与工具

| 动作 | 工具 | 来源 |
|---|---|---|
| 派工给后台 worker | `spawn_worker` | 本 bundle |
| 给 worker 续聊 / 改名 | `message_worker` | 本 bundle |
| worker 轮次结束的自动回报 | `session/event` → `turn/end` | 宿主 |
| 读 worker 回报 | 完成通知 | 本 bundle 的唤醒器 |
| 建卡 / 改卡 / 查卡 | `create_card` / `update_card` / `list_cards` | 本 bundle |

`spawn_worker` / `message_worker` 这套接口是为「协调者派活、worker 干活并自动回报」设计的：会话由 `agents.create` 建，生命周期归本 bundle 管，不经 dsh 的 subagent 机制（subagent 结算即销毁，界面上还只读，既不能常驻也不能让人下钻对话）。

`agents.create` 不会自己挂 **agent preset**，而内建工具（`bash` / `read` / `write`…）就在 preset 组合里——建 worker 与冷恢复 worker 都要显式把 `agentPresets.mount()` 交给 `setup`，并把 preset id 写进 `meta.agentPreset`（宿主从会话投影读回），漏了就只剩全局工具（见 [capability-gaps 第 38 条](docs/capability-gaps.md)）。

挂上的是**整个标准组合**，不只一两个工具：persona、`agent-instructions`（会读项目 `AGENTS.md`）、time-context、`subagent` / `workflow`、`ask_user_question`、`todo`、`web` 等一起进来。worker 是常驻后台会话，因此它现在也能向用户提问。

**worker 不走宿主的三件 subagent 控制工具**：`list_agents` 只列 subagent 目录里的子会话（worker 是根会话，列表里没有它）；`send_message` 要校验子会话的 `parentSession` 血统（worker 没有，走不通）；`interrupt_agent` 找不到目标时**静默返回成功**——拿它当中止手段会得到一个假回执。worker 的一切交互只经 `spawn_worker` 与 `message_worker`。

**工具面按角色分配**（会话创建时裁剪，不是靠参数隐藏）：协调者拿到全部工具但没有 `list_agents` / `send_message` / `interrupt_agent`（下面一段解释了它们为什么对 worker 无效——从工具面直接摘掉，模型就不会照描述去用一个拿不到效果的东西）；普通会话与 worker 都没有 `spawn_worker` / `message_worker` / `list_cards`（没进项目语境，看不到项目里有哪些卡，也不该派工）。完成回报不占工具面：worker 那一轮结束时由 `dispatch.js` 从会话事件结算。`create_card` / `update_card` 对所有会话开放——worker 边干活边把状态写回卡片。普通会话保留那三件宿主工具：它可能真的用官方 subagent，那时它们是有效的。

dsh 另有一套同名的同伴模型工具（`tool-agent-team`，experimental，base bundle 未启用），按 teammate 名字寻址，与本流程的 worker 不是同一批，不要混用。

## 安装

开发期用 profile link 安装（改代码即生效）：

```sh
dsh plugin --profile web add ../dsh-leader-kit
```

快速试跑（不装进 profile）：

```sh
cd /path/to/deepseek-harness
pnpm dsh web --patch ../dsh-leader-kit/cordis.patch.yml
```

分发到 npm 后：

```sh
dsh plugin --profile web add dsh-leader-kit
```

profile 名用 `web`：插件 manifest 声明 `platform: web`，而 `dev` 这类自定义名字不在 dsh 的 `PROFILE_TEMPLATES` 里，`dsh plugin` 会按默认模板只装 `@deepseek-ai/dsh-base`——没有 web-app bundle，插件客户端半边根本不加载。

`engines.dsh` 声明了支持的 dsh 版本范围；不满足时安装与启动会被拒绝——dsh 处于 developer preview，版本范围需随 dsh 跟进。

## 开发

在 worktree 里开发时，一条命令起一个**挂当前工作树插件版本**的 dsh 实例：

```sh
npm run worktree:spawn my-task    # 建 .worktrees/my-task + feature/my-task（base 取最新 origin/main）
cd .worktrees/my-task
npm run dev                       # 起开发实例
```

`npm run dev` 不碰你日常的 `~/.dsh`：数据根落在工作树内的 `.dev/home`（会话、项目、卡片都在那里，删掉即重置），profile 从 `~/.dsh/profiles/web` 派生，`node_modules` 逐条符号链接到源 profile、只有 `dsh-leader-kit` 指向当前工作树。所以几个工作树可以同时跑，各自的插件版本与数据互不干扰；源 profile 升级 dsh 或改插件组合时，开发实例跟着走。

- 端口默认交给系统分配，启动日志里打印带 token 的 URL；要固定就 `DEV_PORT=3210 npm run dev`。
- 改客户端代码（`src/client/`）要重跑 `npm run dev` 或 `npm run build:client` 再刷新；宿主侧（`src/host/`）由 Node 直接加载，重启实例即可。
- 依赖共享主 checkout 的 `node_modules`（本仓库只有 esbuild 与 minidenticons），改 `package.json` 请在主 checkout 安装。
- 覆盖项：`DSH_HOME`（数据根，**不能等于 `DSH_HOME_SOURCE`**——那条路径会把日常 profile 改写成自指死链，脚本直接拒绝）、`DSH_HOME_SOURCE`（源 HOME，默认 `~/.dsh`）、`DSH_PROFILE`（源 profile 名，默认 `web`；那个 profile 的 bundles 里必须有 `@deepseek-ai/dsh-web-app`，否则脚本拒绝——缺它的 profile 跑 `dsh web` 不监听、不打印、也不报错）、`DEV_PORT`、`DEV_NO_OPEN=1`（不自动开浏览器）。

收尾时清掉已合并的 worktree：

```sh
npm run worktree:prune                 # 只打印结论（dry-run）
npm run worktree:prune -- --apply      # 真删：worktree 目录 + 本地分支
npm run worktree:prune -- --apply --delete-remote   # 连远端分支一起删（--remote 指定远端，默认 origin）
```

守卫：有未提交改动的、当前所在的、分支没进 `main` 且 PR 未合并的，一律拒绝。分支是否已合并看两条判据——`merge-base --is-ancestor main`（merge 合并成立）与 PR 状态（squash 合并只有这条成立）。删 worktree 时 `.dev/home` 的数据与 `node_modules` 链接随之清掉，链接指向主 checkout，删的只是链接本身。

也可以不用脚本、手工把插件装进某个 profile：`dsh plugin --profile web add ../dsh-leader-kit`（改代码即生效，但会与装进同一 profile 的其他工作树互相覆盖）。

## 使用

1. **让模型加载协议层**：`skill` 工具会列出 `leader-mode`。协调者会话先读 `playbooks/program.md`，再按阶段读对应 playbook。
2. **初始化项目**：让模型加载 `init-project` skill，按 skill 指令读 `references/conventions.md`，用宿主的文件编辑能力把正文并入目标项目 `AGENTS.md` 的受管区块（没有专用工具）。dsh 读取 `AGENTS.md` 作为系统提示段落，因此写入即对模型生效。重复执行只替换受管区块，不动项目已有内容。
3. **派工**：调用 `spawn_worker`，参数 `name` 与 `initialMessage` 都必填。`name` 是 worker 的显示名（角色-任务短名，如 `research-sources`），同时钉成它的会话标题：不钉的话宿主按首条消息自动起名，侧栏看到的是任务正文前几个字。工具立即返回会话 id；worker 是**常驻根会话**——它在左栏项目树下有自己的会话行，你能像开别的会话一样打开它、直接输入新指令，也能在 `message_worker` 里给它续聊。worker 那一轮结束时协调者随即被唤醒，收到一条完成通知——回报由机制侧从会话事件结算，worker 不需要调用任何工具。通知在会话里渲染成 **worker 的发言**：左侧气泡，气泡上方是头像与 worker 名字，正文里没有「谁在说话」的前缀——和用户自己的输入（右侧气泡）区分得开。气泡里只显示 worker 最后一次回报的内容（产物摘要或失败原因），协议字段（会话、状态、下一步）留给模型读；气泡下方是时间与复制按钮，点 worker 名字可跳到它的会话。通知排进 inbox 的 **next-turn** 边界（下一个 turn 的一次输入），且**父会话正忙时先不投**——它留在落盘队列里，等父会话空闲后再投，因此不会挂在宿主输入框上方的「消息队列」面板上。
4. **记任务事实**：调用 `create_card` 建卡（`title` 必填），`update_card` 改卡（`id` 必填，改内容带 `expectedRevision` 做乐观并发），`list_cards` 查卡（默认只列 active，一页 20 张；传 `cardId` 读单卡完整规格与链接）。卡片落盘在 `$DSH_HOME/dsh-leader-kit/cards.json`，编号全局递增不复用。**卡片按项目归属**：宿主按调用方会话反查项目（协调者会话走项目注册表的指针，其它会话按 cwd 与项目目录的 realpath 相同），模型不传项目参数。`list_cards` 默认只列本项目，要看全部项目传 `scope=all`；跨项目改卡会被拒绝。
5. **续聊 worker**：再调 `message_worker`（`sessionId` 与 `message` 必填，`sessionId` 就是 `spawn_worker` 返回的会话 id；可选的 `rename` 顺手改名，登记表与会话标题同次改到新名字）。会话还活着就直接投进去（返回 `merged`），进程重启后不在内存就先冷恢复再投（返回 `sent`）——两种形态对调用方是同一步。新的一轮结束时同样唤醒协调者，收到一条格式一致的汇报气泡。

   **人自己下钻跟 worker 聊天不经过这条路径**：那种轮次不会登记在飞记录，因此不会被结算，协调者不会被打扰。派工要求组合里有会话持久化与查询后端（`sessionPersistence` / `sessionQuery`）：缺任一就拒绝派工，而不是悄悄降级成只能跑一轮的一次性 worker。
6. **看交付看板**：浏览器右栏打开「看板」Tab。**看板按项目组织且只对项目会话展示**：面板先按当前会话解析出所属项目、确认它是该项目的协调者或 worker，再按项目拉卡片（被换下的协调者已降级为项目里的普通会话，拿不到看板入口）——协调者建的卡与 worker 建的卡在同一处；项目目录里的普通会话打开看板只看到「看板只在项目会话中打开」。卡片不另存一份，看板直接读宿主的卡片库（不是重放会话事件流），因此跨会话聚合成立，worker 会话被回收后卡也不会消失。协调者会话里建卡后右栏会自动打开（或聚焦到已有的）「看板」Tab，出现新卡才打断你，改卡不会。卡面只做信息与导航：点卡面开只读详情（说明 / 链接），点链接 chip 新标签打开，点槽位 chip 打开该槽位绑定的会话。信号灯由槽位会话状态实时投影（不落盘），七档为「等你输入 / 需注意 / 执行中 / 未读 / 空闲 / 状态未知 / 无信号」。运行态来自**保留会话的快照**：面板所在的右栏座只注入 tab 信息，不提供宿主的会话状态 hook，因此「执行中」与「上次执行失败」成立，「等你输入」「未读」两档在这条路径上无从表达。「状态未知」表示读不到该会话（例如会话已被删除），不谎称空闲。worker 会话是普通根会话，客户端会话目录里通常有独立条目；宿主给不出条目时（历史 subagent 时代的 worker，或会话刚建还没同步）恢复时会用它所属的建卡会话补一个子代理地址再保留——这也是卡片上 worker 槽位圆点能亮起来的前提。
7. **管理项目**：项目是显式注册的实体，不是目录。**左栏的「项目」区块是唯一入口**（模型没有项目注册表工具）：一条项目记录有名字、目录并绑定一个协调者会话；删除项目会连同插件为它注册的工作区一起移除，协调者会话本身保留，历史留在会话库里。区块在「自动化任务」之下、工作区之上：点右上角的「加项目」选一个目录，项目**当场建好**并出现在列表里（名字默认取目录名，要改用行上的「重命名」）——不再多一道「起名 + 点注册」的确认手续，建好时也不弹成功提示（新项目行本身就是回执，只有失败才在区块尾部给提示；列表收着时建项会自动展开，保证新行当场可见）；目录名当不了项目名时（选到根目录、目录名超过 200 字）退回一个能改名字的输入框，因为那时直接提交只会换回一条没有出口的报错；同名目录会依次建成 `repo`、`repo-2`、`repo-3`。点标题「项目」收起或展开整个列表，点项目行打开该项目的协调者会话（主区域切到该会话），点行首槽位展开或收起该项目的会话（worker 与被换下的协调者；当前协调者与用户手动开的会话都不在其中），行的「更多」菜单里是重命名、换新协调者、删除；「删除」会先弹二次确认，讲清工作区会从 dsh 的工作区列表移除、文件夹与会话记录保留（其会话落到工作区树的「未分组」下）；复用来的用户工作区不属于项目，不会被碰。项目名后面不跟路径（悬停可见）。项目的 worker 与协调者会话（含被换下的协调者，它降级为项目里的普通会话、和 worker 同列；换人之后它不再指挥这个项目：`spawn_worker`、`message_worker` 与跨项目的 `list_cards` 都在调用时按当前身份判，退役会话一律被拒；原班 worker 的父会话仍记着旧会话，换人后也投递不了——要续用就在新协调者里重新派工，或由人下钻直接对话）不在官方工作区树里重复出现。会话行悬停时右端露出归档按钮：归档后该会话从项目树消失，卡片上指向它的槽位一并摘掉（死引用会让看板挂着一个点开没有去处的执行者），派工登记也删掉（否则 `message_worker` 会走进一条注定被宿主拒绝的路径）；会话正在跑时先问「停止并归档」，因为宿主的归档闸门会拒绝运行中的会话。行的形态照官方工作区行：行首平时是目录图标，鼠标悬停整行时换成展开箭头（展开时箭头朝下），「更多」在行右端、悬停时出现。打开协调者会话时，它的形态是**输入框停靠底部的对话视图，但转录里一条消息都没有**——dsh 对空会话默认渲染居中大标题的欢迎页，本 bundle 注册一个第三方会话视图目标并在协调者会话打开时激活它（宿主据此把外壳切到 active 形态），不产生任何模型调用，也不往转录里塞任何开场白。
8. **配角色槽位**：在项目目录写 `SLOTS.md`，按 `## <槽位名>` 分节写角色的工作方法与人设；在卡片的 `slots` 字段把槽位名绑到会话 id，该会话每轮 turn 都会注入对应槽位正文，改动 `SLOTS.md` 在下一轮 turn 生效。槽位只贡献提示词文本，不授予工具权限。没写 `SLOTS.md` 的项目回落默认三角色 `discuss` / `dev` / `review`（正文为空）。
9. **写协调者手册**：在项目目录写 `COORDINATOR.md`，写这个项目的协调者该怎么指挥——职责边界、派工要求、验收口径、本仓硬约束。**协调者会话每轮 turn 自动注入**，不需要卡片绑定，也不用加载任何 skill 才生效；改动在下一轮 turn 生效。它只贡献提示词文本，与 `SLOTS.md` 一样不授予工具权限。

协议层也随 bundle 分发到 `skills/` 下；项目内若自行放置 `.agents/skills/leader-mode/`，项目副本优先（dsh 的 skill 发现按来源层级取优）。

## 已知限制

- **后台编排只适用于长驻组合**（web / desktop / sdk）。headless 是一次性 CLI，会话在 turn 结束后即被销毁，届时没有载体接收完成通知——这是宿主语义，不是本 bundle 的缺陷。
- **协调者没有中止 worker 的手段，也没有模型侧的名录工具**。worker 是普通根会话，宿主的 `list_agents` / `send_message` / `interrupt_agent` 都作用在 subagent 体系上，对它无效（`interrupt_agent` 还会返回一个假的成功回执）。worker 卡住或跑偏时，只能请人去那个会话里处理；要看项目里有哪些 worker，看项目树（那一层在前端，模型看不到）。这是常驻化的直接代价：换掉 subagent 换来常驻与可下钻，也就换掉了宿主的这套控制面。
- **报告结算依赖轮次正常结束**：结算点在宿主的 `turn/end` 事件上。进程在 worker 跑完之前被杀，那一轮就不会结算（在飞表在内存里，重启即空），协调者也就收不到这次通知；重启后它会看到 worker 会话还在，可以自己打开看或续聊。订阅 `session/event` 不做运行期能力探测——cordis 的 `Context` 永远有 `on`，而宿主低于 `engines.dsh` 下限时本来就没有这个事件；下限 rc.2 已提供 `session/event` 与 `turn/end`，这是版本契约，不是装配期能判定的错误。
- **看板按项目组织，不按会话，且只对项目会话展示**。一个项目一个看板：面板按当前会话解析出所属项目，再确认它是该项目的协调者或该项目派出的 worker，才按项目拉卡片——协调者建的卡与 worker 建的卡在同一处。项目目录里的普通会话与已经被换下的协调者打开看板只看到「看板只在项目会话中打开」的提示；它们仍然能解析到项目（卡片归属要用），只是不拥有看板的呈现面。数据源是宿主的卡片库，不再重放会话事件流（跨不了会话，也扛不住宿主回收）。不属于任何项目的会话也没有看板，面板会说明这一点。协调者会话被归档或替换后项目绑定不会自动改：项目摘要带 `coordinatorAlive`，面板每 30 秒复核一次，旧协调者会话与项目里的执行会话切到「该项目的协调者会话已失效，请在左栏项目区块换新协调者」的提示，不再展示卡片。
- **「看板」入口按会话画，残余在 More 菜单**。右栏 tab 类型与「开始」页的入口是静态注册，宿主没有按会话过滤的扩展点；本插件接管 `sidebar.right.tab.guide.entry` 里自己那一枚胶囊的渲染，只在项目会话（协调者与 worker）里画出来，样式复刻宿主 `EntryBox`。`sidebar.right.tab.guide.actions` 是 root scope、不带会话，「开始」页的 More 菜单仍会列出「看板」；自动弹出仍只跟随协调者会话（worker 建卡不弹）。
- **项目注册表只经左栏区块操作**。模型没有 `add_project` / `list_projects` / `switch_project` / `remove_project`；仓库工程约定也没有专用工具，初始化走 `init-project` skill 的文件写入。目录选择器不可用时（宿主缺 web-app 的导航服务）无法建项目，需要换用 web profile。
- **卡片按项目归属，归属由宿主判定**。`create_card` 时宿主按调用方会话反查项目，把 `projectId` 写进卡片记录，模型不传项目参数——它未必知道自己在哪个项目的语境里调工具。`list_cards` 默认只列本项目，`scope=all` 才跨项目；有归属的卡只能被本项目的会话改，跨项目改卡会被拒绝。**存量卡片不迁移**（记录里没有创建会话 id，无法可靠反推归属），它们不出现在任何项目看板，只能用 `list_cards`（`scope=all`）看到。
- **卡片编号仍是全局的**。按项目过滤后编号会有空洞，但全局唯一，`@#n` 不歧义——比按项目编号更好（见[卡片存储与编号作用域](.agents/notes/2026-10-23-card-storage-and-numbering-scope.md)）。
- **工具面裁剪靠宿主的 `tools.restrict()`**。已发布的最新 dsh（`0.2.1-rc.4`）里 `tools.register()` 仍只收一个参数，按步求值的 `when` 只在源码仓 HEAD 上，所以裁剪落在 `agent/created` 时对 `agent.ctx` 调一次 `restrict({ deny })`。协调者身份来自项目注册表——**索引重建完成前不裁**：这时候问不出谁是协调者，而少给工具会让协调者首轮干不成活；工具面这一层的宽松只对读类工具安全，派工前另行 `awaitIndex()` 并复核身份。
- **会话折叠只认运行态**。宿主的工作区树还会为「有子代理在跑」「等你输入」「未读完成」「当前会话」四种注意力抬高水位，我们手里只有会话行的 `running`，所以只按它抬。收起只在全部放完时出现，与宿主 `sessionsExpanded = hiddenCount === 0` 的口径一致——会话很多时要点若干次「展开其余 N 个会话」，而不是随时能收。
- **「等你输入」档暂无数据源**。宿主的待处理交互机制在（`pendingInteraction`），但当前没有任何域发布它，这一档不会亮；机制与档位都留着，等真有域发布时自动生效。「未读」档已实测跑通。
- **卡片详情只读**。完成、置顶、重命名、删除都要新增宿主远程方法才能做，本轮不做；卡面也不放操作按钮。
- **归档入口只在有 hover 的设备上出现**。按钮的显示挂在 `@media (hover: hover)` 上（与官方会话行一致），触屏上不会出现；归档本身是宿主能力，也可以在别处完成，本区块会跟着 `archivedSessionIds` 快照把行藏掉。
- **气泡折叠没有单测**。折几行靠 `-webkit-line-clamp`，是否出现「展示更多」要在 DOM 上量 `scrollHeight` 与 `clientHeight`；本仓不引 jsdom，这段只能用浏览器取证（`docs/e2e-testing.md`），逻辑本身没有可单测的纯函数。
- **卡片详情浮层是打开瞬间的快照**。卡片随后被协调者更新，浮层不会跟着刷新，要关掉重开。
- **卡面不显示所属项目/工作区**。看板已经按项目过滤，卡面不必再重复标注（无 workspace chip）。
- **弹窗与菜单是复制官方源码改写的，不是复用宿主组件**。第三方 bundle 不能 import 宿主 UI 包，官方 `Modal` / `Menu` 组件用不了，因此确认弹窗照 `packages/client/ui-primitives/src/Modal.tsx` 与 `Modal.module.css` 复制一份改写（类名换 `dsh-leader-kit-modal-*` 前缀），菜单照 `Menu.tsx` 的材质与数值复刻。代价是宿主改这两个组件时本仓要同步。
- **协调者会话形态依赖宿主的会话视图服务**。宿主没提供 `uiConversation` 服务时（它不在机器可读的插件 API 目录里，属于版本耦合面），协调者会话退化成官方欢迎页（居中输入框），本 bundle 不阻断打开会话，也不自绘替代界面。
- **项目区块靠 DOM 注入取位**。dsh 的左栏正文区只有 `sidebar.workspaces` 一个槽且已被宿主占用，slot 机制没有包装能力，第三方插不进并列区块——本仓在左栏的「面板列表 nav」之后插容器并用 portal 渲染，位置是「自动化任务之下、工作区之上」；宿主结构变化导致找不到锚点时内容退回原槽，功能不受影响。
- **项目树是自建的，与官方工作区树并存**。官方只有按工作区分组的会话树，没有「项目」维度。本仓的项目树只挂该项目的 worker 会话——判据是「登记表说它是本 bundle 派出的 worker」加上 cwd 与项目目录的 realpath 精确相等（worker 是普通根会话，会话头没有身份标记，只能按登记判）。协调者会话（入口在项目行上）与用户在项目目录里手动开的会话都不算项目会话：前者由项目入口打开，后者留在官方工作区树里。
- **「项目会话不出现在官方工作区树」是渲染层排除，不是数据层**。官方没有按外部集合排除行的扩展点，本仓认 `data-row-key="session:<id>"` 给命中排除集的行加隐藏类。排除集含项目的协调者会话与全部 worker 会话（worker 是普通根会话，官方树不会自己滤掉，不排除就会同时出现在两棵树里）。代价：官方分组行上的会话计数仍包含被隐藏的会话；被隐藏的行仍在 DOM 里，官方搜索仍能命中。
- **子目录里的 worker 不算项目下的 worker**。归属按会话 cwd 与项目目录的 realpath 精确相等判定；两个项目指向同一目录时先注册的归属。
- **点项目会把项目目录注册成 dsh 工作区**。dsh 的官方界面只能打开归属工作区的会话（建会话时传目录而不是传工作区，会话不归属任何工作区，官方树里没有它的位置）。本仓因此在打开项目时把协调者会话挂到项目目录对应的工作区上，目录还不是工作区就注册一个（幂等）。
- **被隐藏的会话不再点亮它所在的工作区**。官方按「当前会话属于哪个分组」给工作区目录图标上主色；协调者与 worker 会话在渲染层被隐藏后，点亮的分组里找不到对应的会话行——分组看着是开着的，却找不到是谁。本仓在当前会话属于排除集时，给承载它的工作区行加类，把图标压回三级标签色（同为渲染层，官方数据层不动）。只在分组视图下压当前会话所属的那一组；树模式下祖先分组仍会点亮。
- **项目自建的工作区从官方树里藏掉**。加项目会顺带把目录注册成工作区（上一条的技术原因），左栏工作区树里于是凭空多出一行用户没加过的目录——项目区块里已经有同一个目录了。本仓按项目记录的 `workspaceId` 认出「这个工作区是我们注册的」，在渲染层整组藏掉（分组行 + 组内属于它的会话行与「展开其余 N 个会话」按钮；嵌套分组各自显示）；用户自己加的同目录工作区不记这个字段，照常显示。代价：项目目录里用户手动开的会话不在项目树（项目树只列 worker），左栏也看不到——宿主搜索仍能命中它们，「在一个列表里」视图也照常列出。想彻底解决得让项目树列出整个目录的会话，那是另一件事。
- **图标数据与宿主 `artwork.ts` 耦合**。宿主 web 端把图标在构建期内联进产物，运行时 DOM 里没有 sprite 节点，第三方 bundle 在运行时渲染只能自己带路径数据——本仓内联的路径取自宿主 `dsh-client-ui-primitives` 的 `artwork.ts`（regular 字重），宿主改图标时本仓要同步。
- **worker 回报不进会话标题、turn 摘要与 markdown 转录导出**。宿主只把 `source.kind === 'user'` 的消息算作真人输入；本仓的回报用自定义 source kind（`dsh-leader-kit/worker-report`），因此会话自动标题不取它、turn 摘要 prompt 不取它、markdown 转录导出会跳过它。换来的是它不会被误当成用户说的话——标题、摘要、导出这三处都只认真人输入。
- **worker 回报的渲染依赖宿主的会话节点扩展位**。本仓注册一个独立的 Chat node kind 并用 exclusive claim 接管这类消息（见 [worker 回报气泡](.agents/notes/2026-10-27-worker-report-bubble.md)）。宿主若改了 claim 或分组语义，这条消息会退化成普通的右对齐用户气泡——内容不会丢。
- **worker 回报要等父会话空闲才送达**。完成通知排进 inbox 的 next-turn 边界（下一个 turn 的一次输入），父会话正忙时先不投、留在落盘队列里，检测到空闲再投。否则它会像用户自己发的消息一样，以「一条待发消息」的形态挂在输入框上方的「消息队列」条里（对照实验：busy 时直接投，面板显示「2 queued messages」，把人的消息和 worker 回报混在一起）。代价是协调者正忙时，回报要多等它这一轮结束（见 [worker 回报的投递边界](.agents/notes/2026-10-27-worker-report-delivery-boundary.md)）。
- **历史消息不追溯**。改造之前发出的通知在 session log 里就是普通用户消息，重放时仍按老形态渲染（右对齐、无头像）。
- **worker 头像在深色主题下轮廓弱**（既定取舍，不是待修项）。气泡底是前景色混出的 4% 一层，36% 的蓝紫色相落上去只有 1.35:1，块的外轮廓看不出边界；头像本身仍可辨。头像池只有 63 个 seed，worker 多时会有撞图（3 个约 4.7%，5 个约 15%），名字就在头像旁边，不影响身份识别。
- **项目级手册都是每轮读文件，没有 watcher**。`COORDINATOR.md` 与 `SLOTS.md` 每轮 turn 重新读取，改动在下一轮生效；正在跑的那一轮不会变。两者都是增量信息：文件缺失、读失败或正文为空时注入空串，不阻断会话，也不生成兜底正文（协议层 skill 已覆盖通用方法）。协调者手册只对项目注册表里指到该会话的协调者生效——项目索引还没重建完的那一轮不注入，下一轮补上。
- **卡片编号跨项目不复用**。编号全局递增，归档与删除都不回收。
- **不能新增 session event 类型**：dsh 要求仓外事件带 `ignorable` 标记且不进读路径，因此卡片与通知状态走自有落盘文件。
- **浏览器侧 → 宿主侧走 Typert 远程通道**（命名空间 `projects`，经官方 `/api` 共享通道）。dsh 的 `connection.rpc.handle` 对仓外插件不可用（注册作用域拿不到 `webServer`），`/api` 又被官方 gateway 占用；Typert 的 SRC 回退通道允许第三方按协议形状注册服务，但代价是**手写的协议形状与宿主版本耦合**——本仓对齐宿主 `0.2.1-rc.2`（标记属性名、`version:1` 描述符、`typertRemote` 绑定字段、方法形参即 wire 字段名），宿主改契约时本仓要同步改。远程方法名还要避开官方命名空间服务的保留字（撞名会让整个命名空间挂不上）。

## Agent Notes

设计决策与实测记录在 `.agents/notes/`。**文件名一律用英文**（`YYYY-MM-DD-<英文标题>.md`），正文中文。

| 笔记 | 内容 |
|---|---|
| [派工与唤醒机制](.agents/notes/2026-10-23-dispatch-and-wakeup.md) | P1：派工、完成通知落盘、父会话唤醒（worker 已换常驻根会话，见下一条） |
| [worker 常驻化与交作业](.agents/notes/2026-10-29-worker-as-root-session.md) | 为什么换根会话、人下钻对话不打搅协调者（完成回报已改为下一条的机制） |
| [worker 回报由机制侧结算](.agents/notes/2026-10-29-worker-report-by-session-events.md) | 为什么删掉 `worker_done`：订阅 `session/event`、在 `turn/end` 折叠产出与终态 |
| [卡片存储与编号作用域](.agents/notes/2026-10-23-card-storage-and-numbering-scope.md) | P2：卡片落盘、编号不复用、乐观并发 |
| [客户端半边的发现与构建约束](.agents/notes/2026-10-23-client-side-findings-and-build-constraints.md) | P2：浏览器侧可用的注入点与构建约束 |
| [项目作用域与角色槽位](.agents/notes/2026-10-23-project-scope-and-role-slots.md) | P3：项目实体、协调者会话硬绑定、槽位注入 |
| [看板卡片视觉与交互](.agents/notes/2026-10-27-board-card-visual-and-interaction.md) | P4：卡面三层结构、信号灯档位、交互三语义、详情浮层 |
| [查卡工具的列表摘要与分页口径](.agents/notes/2026-10-27-list-cards-brief-and-paged.md) | P5：列表给摘要、单卡给全文、分页与输出预算 |
| [worker 回报气泡的呈现](.agents/notes/2026-10-27-worker-report-bubble.md) | worker 回报的 source 标记、独立会话节点、左侧气泡与头像、只渲染最后一次回报、淡底、名字下钻、时间与复制 |
| [worker 回报的投递边界](.agents/notes/2026-10-27-worker-report-delivery-boundary.md) | 通知排进 next-turn 边界、父会话空闲才投：不进消息队列 |
| [看板按项目组织](.agents/notes/2026-10-27-project-bound-board.md) | 一个项目一个看板、卡片归属判据、数据源从事件流换成宿主、建卡后自动打开看板 |
| [槽位圆点的状态来源与保留失败的处理](.agents/notes/2026-10-28-board-slot-status-source.md) | 座不注入会话状态 hook、子代理会话用地址保留、保留失败要报告 |
| [删除项目工具与卡片检查点](.agents/notes/2026-10-29-drop-project-tools-and-card-checkpoint.md) | 项目注册表只经 UI、初始化改为纯 skill、checkpoint 无协议消费方、看板收紧到协调者会话 |

## 开发

```sh
npm test           # node --test
npm run check      # 语法检查 + 测试
npm run build:client  # 构建浏览器侧产物 lib/client.js（esbuild）
```

浏览器侧取证的执行流程（隔离实例、场景标记、断言外部世界、双向验证）见 [浏览器侧取证的执行规范](docs/e2e-testing.md)。

运行时依赖只有 `minidenticons`（worker 头像）；宿主侧代码只用 Node 内置模块。

浏览器侧产物不入库（`.gitignore` 忽略 `lib/`），发布时由 `prepublishOnly` 重建。`cordis.patch.yml` 的插件行名必须是**纯包名**——写成子路径，浏览器侧定位不到包 manifest，宿主便不下发 client bundle。

协议层的相对链接完整性由测试守住——搬动文件后链接断裂会直接测试失败。
