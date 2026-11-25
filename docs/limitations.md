# 已知限制与取舍

本文件是「本 bundle 有哪些限制、为什么这么取舍」的唯一归属。README 的[当前限制](../README_ZH.md#当前限制)是给使用者的概览，只列最要紧的几条；决策的完整推演在对应的 [Agent Note](../.agents/notes/)，宿主为什么做不到在某处能力上，见 [capability-gaps.md](capability-gaps.md)。行为与实现见[架构文档](architecture.md)与[使用手册](usage.md)。

## 宿主语义与运行形态

- **后台编排只适用于长驻组合**（web / desktop / sdk）。headless 是一次性 CLI，会话在 turn 结束后即销毁，没有载体接收完成通知——这是宿主语义，不是本 bundle 的缺陷。
- **派工回报按回合归属，或迟一轮**：用户回合不结算；leader 消息下轮回报，取走即丢弃。
- **报告结算依赖轮次正常结束**：结算点在宿主的 `turn/end` 上。进程在 worker 跑完前被杀，那一轮不会结算（在飞表在内存里，重启即空），leader 收不到通知；重启后能看到 worker 会话还在，可以打开看或续聊。订阅不做能力探测：下限 rc.2 已提供 `session/event` 与 `turn/end`。
- **续聊消息在 worker 的下一步才进上下文**：`message_worker` 走 inbox 的 next-step 边界，worker 正在跑时消息要等当前 step 结束才被取走——卡在长工具调用里的 worker 不会立刻看到，本 bundle 也没有中止它的手段（见 [worker 的控制面](#worker-的控制面)）。这与完成通知的 next-turn 边界是两件事。
- **会话被别的进程持有时不能冷恢复**。同进程里被 GUI 打开或启动恢复的 worker，`message_worker` 会复用宿主已有的活 agent 直接投递（[修法](../.agents/notes/implemented/bug-fix/2026-11-11-session-write-handle-reuse.md)，#126）；写句柄在别的 dsh 进程手里时，`agents.resume()` 仍会撞上 `SessionAlreadyOwnedError`，本 bundle 只能提示「先关闭占用它的窗口」，不能跨进程接管。
- **不能新增 session event 类型**：dsh 要求仓外事件带 `ignorable` 标记且不进读路径，因此卡片与通知状态走自有落盘文件。
- **项目级手册没有 watcher，改动只在下一次模型请求生效**。正在跑的那一轮不会变；两者都是增量信息，不生成兜底正文（协议层 skill 已覆盖通用方法）。leader 手册只对项目注册表里指到该会话的 leader 生效——项目索引还没重建完的那一轮不注入，下一轮补上。机制与缺失处理见[项目级提示词与协议层](architecture.md#项目级提示词与协议层)。
- **历史消息不追溯**。改造前发出的通知在 session log 里就是普通用户消息，重放仍按老形态渲染（右对齐、无头像）。leader 任务消息是例外，但有边界：#112（`478232a`，包名改为 `dsh-leader-agent`）之后落盘、且带 `source.parentSessionId` 的任务消息，旧记录同样按新的用户气泡渲染；改名前的 `dsh-leader-kit/worker-task` 记录不认领，退回官方上下文行。
- **worker 回报不进会话标题、turn 摘要与 markdown 转录导出**。宿主只把 `source.kind === 'user'` 的消息算作真人输入；本仓的回报用自定义 source kind（`dsh-leader-agent/worker-report`），因此这三处全部跳过它，也不会被误当成用户说的话。
- **worker 回报的渲染依赖宿主的会话节点扩展位**。本仓注册一个独立的 Chat node kind 并用 exclusive claim 接管这类消息（见 [worker 回报气泡](../.agents/notes/implemented/feature/2026-10-27-worker-report-bubble.md)）。宿主若改了 claim 或分组语义，这条消息会退化成普通的右对齐用户气泡——内容不会丢。
- **leader 任务气泡没有身份头**。它按用户消息的形态渲染（右侧、无头像与名字，正文与 assistant 内容同套 Markdown（`MarkdownText` compact），单换行按 Markdown 合并、不复原日志式换行；需要断行用空行或 Markdown 语法），所以不显示 leader 是谁，也不能从气泡跳到 leader 会话；`source.parentSessionId` 仍是来源凭证，没有它的历史消息不认领，退回官方上下文行（不是右侧气泡）。
- **worker 回报要等父会话空闲才送达**。否则它会像用户自己发的消息一样挂进输入框上方的「消息队列」条（实测 busy 时直接投会显示「2 queued messages」，与人的消息混在一起）。代价是 leader 正忙时回报要多等这一轮（边界见 [笔记](../.agents/notes/implemented/architecture/2026-10-27-worker-report-delivery-boundary.md)，机制见[派工与唤醒](architecture.md#派工与唤醒)）。
- **自动续行上限可调，积压不可见**：设置页只写上限，不显示用量与待投数；撞上限的回报带 `lastError` 留在 `notifications.json`；调高释放，调低不释放。`resumeCounts` 与等待表里的 `exhausted` 都只在进程内存，重启归零——默认 200 不是跨重启累计。
- **调高释放有已知未覆盖的并发窗口**：`flushWaiting` 先摘等待表再投递，投递期间保存设置触发的 `releaseExhausted()` 看不到这些条目；条目随后被标回 `exhausted` 时可能漏释放，直到下一次调高或人工开口。没有受控延迟用例，按已知未覆盖处理，不声称已验证。
- **看板模式可能滞后，设置页不跨窗口刷新**：旧选择不迁移，升级后从 work 起；多窗口保存后，另一窗口需重挂/聚焦刷新。设置页只在挂载时读宿主设置，另一窗口停在旧草稿时失焦/Enter 可能把旧值写回；看板 `focus` 重读没有请求序号，较旧响应可能覆盖较新的保存。多窗口与并发场景没有可复现用例，按已知未覆盖处理。
- **worker 头像只开放五种形状**：round / organic / boxy / droplet / hexagon；capsule 在 20px 下是扁条，triangle 偏小且锐利，nub / cloud / sun 的凸起会连成串，因此不进入白名单。颜色只取 mid / bright 两档，pale / ink 会退成灰点或暗块；同屏形状重复比全量十种更多，名字在头像旁，不影响身份识别。头像内联渲染，hover 只做一次眨眼，不提供持续动画或表情切换。
- **桌面脚本的 `DSH_HOME` 比 CLI 多一次 trim**。`scripts/desktop-plan.mjs` 取值 trim（`home-paths.js` 照抄宿主：判空 trim、取值不 trim），因为它算出的绝对路径要经 `--env DSH_HOME=` 交给应用。代价：`DSH_HOME=' /x '` 在桌面侧得 `/x`、CLI 侧得 `<cwd>/ /x `。

## worker 的控制面

- **leader 能查模型目录、纠偏，不能中止**。派工用 `list_worker_models` 查 route；纠偏走 `message_worker` 的 `steer`：正在跑时消息插进当前轮次的下一步，续派、改名与换卡同一条路径。中止是缺口——宿主的 `Agent.cancel(cause)` 能停掉当前活动，本 bundle 持有 `AgentHandle` 却没接成工具，只能引导 worker 自己收尾，停不了一轮死循环。宿主的 `list_agents` / `send_message` / `interrupt_agent` / `wait_agent` 对 worker 无效（subagent 体系工具，worker 是根会话；`interrupt_agent` 还返回假成功，`wait_agent` 只是阻塞空等）；要看项目里有哪些 worker，看项目树（那一层在前端，模型看不到）。
- **用户 claim 失败保留的在飞记录不会自动过期**。用户 claim 的轮次失败后记录会留到任务真正进入下一轮；如果用户不再发话、leader 也不重投，它会一直留到进程重启。15 分钟巡查会周期性重复提醒（每次入队后重置 `lastAlertAt`），会话 disposed 只跳过巡查、不删在飞记录；重启才清空。
- **worker 的权限与模型都是派工那一刻的快照**。leader 在派工之后切换 preset 不影响已派出的 worker；后台的 `ask` 没人应答，一律落到 `unavailable`，需要审批的调用因此被拒（只有打开这个会话才可能应答）。`spawn_worker` 的 `model` / `effort` 与 `SLOTS.md` 槽位默认只在建会话时用，之后改文件或 leader 换模型都不影响。
- **`read_worker_session` 是只读视图，不是会话导出**。它读宿主 `sessionQuery.readSession()`（live 会话读内存快照），折成「一回合一段」：任务、人下钻的话、worker 正文、工具与终态。三类 `user/message` 按 `source.kind` 分开——宿主注入的上下文只记条数、不渲染正文，免得冒充任务或挤预算。正文有条目上限（单条 4000 码元、回合终态失败原因 4000 码元、工具失败原因 200 码元）与单页总量上限（12000 码元），超出部分标注原长（码元）与下一页 `offset`；截断按码点边界退让，不会切出孤立代理。`turns` 默认 2、最多 20；`offset` 跳过最新回合往更早翻，翻页期间新增回合会让页框后移、可能重复，最终可读全。完成通知与气泡也按 4000 码元截断并指向本工具；超出部分只能让 worker 复述。工具参数与成功结果不返回，要完整日志用宿主会话导出。权限与 `message_worker` 同档（项目 leader + 登记归属）；退役 leader 调用时被判掉。读取路径不调用任何写方法（夹具断言 `send` / `append` 为空）。
- **读 worker 会话与 worker 是否在跑无关**：会话日志已落盘的部分随时可读，最后一轮缺 `turn/end` 时标「进行中」并按当前已追加的事件展示——不要把半截输出当结论。worker 还没投过第一条消息时没有日志，工具会说明这一点而不是返回空视图。
- **无回报巡查有延迟、也不追溯过去**：`dispatch.js` 每 60 秒扫一次 leader 发起、尚未 `turn/end` 的轮次，基线超过 15 分钟才提醒，因此提醒落在阈值后一分钟内，不是精确的第 15 分钟。进程重启后内存里没有正在跑的轮次，不重新生成提醒，补投时也会丢弃盘上已过期的巡查提醒；人下钻跟 worker 聊的轮次不进在飞记录，不重置计时（提醒可能在你正跟它对话时出现）。提醒是例行检查的普通文本注入：不一定是卡住，也不代表任务失败；本插件不再注册会话节点，会话里始终按官方上下文行展示（裸 kind 标签 + 摘要 + 正文）。它只是「去查」：本流程仍没有中止手段，确认卡死要请人在它的会话里处理。同一 worker 盘上已有未消费提醒时不再入队，leader 长期缺位时只留一条。


## 看板与卡片

- **看板在非项目会话里只是提示**。项目目录里的普通会话与被换下的 leader 打开看板，看到的是「看板只在项目会话中打开」；不属于任何项目的会话连这块呈现面都没有。leader 会话被归档或替换后项目绑定不会自动改：项目摘要带 `leaderAlive`，面板每 30 秒复核一次，旧 leader 会话与项目里的执行会话切到「该项目的 leader 会话已失效，请在左栏项目区块换新 Leader」的提示，不再展示卡片。呈现面归属见[卡片与看板](architecture.md#卡片与看板)。
- **「看板」入口按会话画，残余在 More 菜单**。右栏 tab 类型与「开始」页的入口是静态注册，宿主没有按会话过滤的扩展点；本插件接管 `sidebar.right.tab.guide.entry` 里自己那一枚胶囊的渲染，只在项目会话（leader 与 worker）里画出来，样式复刻宿主 `EntryBox`。`sidebar.right.tab.guide.actions` 是 root scope、不带会话，「开始」页的 More 菜单仍会列出「看板」；自动弹出仍只跟随 leader 会话（worker 不能建卡）。
- **普通会话与退役 leader 都不能写卡**。卡片是项目里的任务事实，普通会话没有项目归属，建出来的卡没有槽位、没有 leader 认领：在普通会话里让模型「把这个记成卡」不再能落盘，要切到该项目的 leader 会话。退役 leader 的写入工具在会话重建前仍留在工具列表里，但每次写入都按当前身份判一次，调用当场被拒（闸门与 worker 的写入范围见[工具面分配](architecture.md#工具面分配)）。
- **存量卡片不迁移**。存量卡片记录里没有创建会话 id，无法可靠反推归属，所以不迁移——它们不出现在任何项目看板，只能用 `list_cards`（`scope=all`）看到（归属判定见[卡片与看板](architecture.md#卡片与看板)）。
- **非 `active` 卡不能绑槽位**。给已关闭或归档的卡绑执行者会被拒绝；同一次调用里「关掉卡 + 绑定」的组合也拒绝，避免调用方以为绑定生效而实际被释放。同次把状态改回 `active` 是显式重新指派，放行。
- **卡片编号仍是全局的**。按项目过滤后编号会有空洞，但全局唯一，`@#n` 不歧义——比按项目编号更好（见[卡片存储与编号作用域](../.agents/notes/implemented/architecture/2026-10-23-card-storage-and-numbering-scope.md)）。归档与删除都不回收编号，跨项目也不复用。
- **卡片详情的人工写操作只有链接与删除**。链接编辑走项目通道的 `updateCardLinks`（整体替换 `links`，宿主侧按共享的 `card-links.js` 重新校验、把 http(s) 地址按 WHATWG URL 归一化后落盘并补条目 id）；删除走同一通道的 `deleteCard`，转调 `cards.remove` 硬删（不可恢复、编号不复用、槽位绑定随索引重建解除），卡片已不在时按幂等成功收尾。完成、置顶、重命名仍归 leader 的卡片工具，卡面不放操作按钮，删除入口只在详情页脚。归档卡不在看板渲染（看板只渲染 active / done），界面上没有详情与删除入口；归档又是卡片库的终态、不接受改回，所以界面里清不掉一张归档卡。**跨项目判定不在这条通道上**：远程方法拿不到调用方会话（`direct` 调用不带 ctx），归属之下的写卡限制仍只由工具层执行；这条通道经官方 `/api` 同源链路到达宿主，任何能调 `/api` 的本机页面或进程都能按 id 改或删任意项目的卡——这是单机单用户威胁模型下的取舍，不比工具更宽，只是少了「防误用」的一致性检查。
- **卡片详情浮层是打开瞬间的快照**。卡片随后被 leader 更新，浮层不会跟着刷新，要关掉重开；本浮层自己保存的链接会立刻回填到浮层与卡面。链接编辑与删除都不进乐观并发：详情里的 revision 是打开时的，用它做 `expectedRevision` 会在 leader 改过卡后稳定冲突，而用户表达的意图就是「这些链接现在是这样」或「这张卡现在删掉」。
- **卡面不显示所属项目/工作区**。看板已经按项目过滤，卡面不必再重复标注（无 workspace chip）。
- **「等你输入」档暂无数据源**。宿主的待处理交互机制在（`pendingInteraction`），但当前没有任何域发布它，这一档不会亮；机制与档位都留着，等真有域发布时自动生效。「未读」档已实测跑通。
- **worker 回报气泡的折叠没有布局单测**。折叠水位按 compact 行高算 `max-height`（2 × 20px 行高 + 22px padding/border），是否出现「展示更多」要在 DOM 上量 `scrollHeight` 与 `clientHeight`；本仓不引 jsdom，真实布局只能用浏览器取证（[e2e-testing.md](e2e-testing.md)）。实现形态有源码断言：`tests/markdown.test.js` 钉住折叠不再用 `-webkit-line-clamp`、行高取 compact 值。leader 任务按用户消息形态全文展示，不折叠。旧回报走纯文本 `pre-wrap`：没有 `report` 的（回退整条通知正文，协议行）与多行 `report` 既无块级标记又无空行的（早期落盘多块用单个换行连接，Markdown 会折成一段），都不被 Markdown 折行；有空行或块级标记的照常走 Markdown。
- **归档入口只在有 hover 的设备上出现**。按钮的显示挂在 `@media (hover: hover)` 上（与官方会话行一致），触屏上不会出现；归档本身是宿主能力，也可以在别处完成，本区块会跟着 `archivedSessionIds` 快照把行藏掉。

## 项目、树与工作区

- **模型没有项目注册表工具**。`add_project` / `list_projects` / `switch_project` / `remove_project` 都不存在；仓库工程约定也没有专用工具，初始化走 `init-leader-agent` skill 的文件写入。宿主注册工作区不校验目录：挂在已删目录上会抛一句英文技术错（本仓的前置检查见[项目与会话归属](architecture.md#项目与会话归属)）。目录选择器不可用时（宿主缺 web-app 的导航服务）无法建项目，需要换用 web profile。
- **初始化提示的拒绝只在本会话生效**。`LEADER.md` 缺失时注入的那段提示要求模型在用户明确拒绝后「本轮及本会话不再追问」，并明确不要为记录这个拒绝写任何文件；换一个新会话仍会再问一次。想持久停用就得创建 `LEADER.md`（或跑 `init-leader-agent`，之后只留少量内容）。插件不做拒绝标记，两条路都不通：宿主默认 preset 是 `workspace-write`，`fs-sandbox` 只放行 workspace root 与平台 temp，模型写 dsh 数据域会拿 `FS_SANDBOX_DENIED`，用 `sandbox_permissions` 申请升权则要为一个「别再问」的标记弹一次审批——比重复问一次更烦；写进项目目录又会让 `git status` 多出未跟踪目录，跟着 `git add -A` 进提交。
- **项目树是自建的，与官方工作区树并存**。官方只有按工作区分组的会话树，没有「项目」维度。本仓的项目树列出该项目的 worker 与退役 leader，判据分开：worker 看登记表（「登记表说它是本 bundle 派出的 worker」）加 cwd 与项目目录的 realpath 精确相等（worker 是普通根会话，会话头没有身份标记，只能按登记判）；退役 leader 看项目记录的 `retiredLeaderSessionIds`。当前 leader（入口在项目行上）与用户在项目目录里手动开的会话都不算：前者由项目入口打开，后者留在官方工作区树里。
- **「项目会话不出现在官方工作区树」是渲染层排除，不是数据层**。官方没有按外部集合排除行的扩展点，本仓认 `data-row-key="session:<id>"` 给命中排除集的行加隐藏类。排除集含项目的 leader 会话与全部 worker 会话（worker 是普通根会话，官方树不会自己滤掉，不排除就会同时出现在两棵树里）。官方按数据层算「展开其余 N 个会话」，同一层渲染补丁把这个数字改成排除后的真实剩余数，全部被排除时收起按钮；但点击步长仍是宿主的（一次 5 条），一次点击新增的可见行可能少于文案的变化量。被隐藏的行仍在 DOM 里，官方搜索仍能命中。
- **子目录里的 worker 不算项目下的 worker**（判据与名单来源见[项目的服务层语义](architecture.md#项目与会话归属)）。
- **项目会话不归属 dsh 工作区**。项目不注册工作区、不把 leader / worker 挂进去（机制见[项目的服务层语义](architecture.md#项目与会话归属)）。旧版本挂过，启动时一次性摘掉：只处理目录（realpath 归一后）等于项目目录的工作区，按目录配对——只摘该项目自己的 leader / 退役 leader 与登记 worker；用户手动分到别处的会话、别项目拖进本项目目录工作区的 leader 都不动。`detachSession` 幂等，重跑不写盘；用户在项目目录里手开的会话不碰。摘掉是因为宿主「新建会话」会把工作区里第一个空白会话当可复用草稿，空着的 leader 正好符合——在项目目录的工作区新建会话会直接打开 leader。目录被删或改名 realpath 解析失败回落原字符串，老挂载可能漏摘（只影响已打不开的项目会话）。
- **「未分组」组头在组内只剩被排除行时藏起来**。项目会话落进「未分组」，行被渲染层隐藏后组头就孤零零挂着。判据只问「组里剩下的会话是不是全在排除集里」——这个问题只取决于会话 id 与工作区归属，不依赖宿主怎么排版、也不复刻它的 `sessionVisible`，宿主换渲染实现不会把整组藏掉。反向的取舍固定成「宁可多显示」：快照还没到、组里一条会话都没有、或存在空会话时都不藏（空组头只是多一个标题，误藏整组等于会话找不到入口）；只有 subagent 与已归档不参与判定，这两类宿主一定不渲染。DOM 上只留一条保护——还有可见的「展开其余 N 个会话」就不藏。
- **项目目录临时不可用时会出现重复行**。`isDirectoryUsable` 把 `ENOENT`、`EACCES` 与网络盘挂起一律当「不可用」，降级成多显示而不是少显示：目录一读不到，该项目的会话就不再从官方树排除，左栏同时出现项目行与「未分组」里的同一个 leader，目录恢复后自动消失。每次 `list` 对每个项目做一次 `stat`（并行、无超时），慢卷上左栏刷新会慢；判完即删的目录下一轮才反映（TOCTOU 窗口存在，结果只是多显示一拍）。目录被删不产生会话事件也不产生焦点事件，所以左栏每 5 秒重读一次项目列表兜底，页面不可见时跳过、切回可见立刻补一次——最坏多显示一拍 5 秒。
- **同一个目录在左栏可能出现两次**。用户自己把项目目录注册成工作区时，左栏既有项目区块一行、也有工作区树一行。那行属于用户，插件不动它；组内的项目会话行仍被排除（折叠数字已按排除后的真实剩余修正，见「项目会话不出现在官方工作区树」那条）。
- **项目区块靠 DOM 注入取位**。dsh 左栏正文区只有 `sidebar.workspaces` 一个槽且被宿主占用，slot 没有包装能力，第三方插不进并列区块——本仓在「面板列表 nav」之后插容器并用 portal 渲染，位置在「自动化任务之下、工作区之上」。`0.2.2` 起宿主把面板列表与工作区包进同一滚动网格，容器改插工作区容器顶部，会跟着该区域滚动，不再固定在栏中；宿主结构再变、找不到锚点时内容退回原槽，功能不受影响。
- **会话折叠认运行态、完成未读与当前会话**。宿主还认「有子代理在跑」「等你输入」，我们没有数据源；`currentSessionId` 参与水位，刚点开的行不会因完成标记清除而消失；绿点在前 50 条内不折。收起只在全部放完时出现（同宿主 `hiddenCount === 0`）——会话多时多次点「展开其余 N 个会话」，不能随时收。收起项目清掉水位，再展开回默认一页：条数不跨收起、不落盘。
- **撤销 leader 会话只能让它不再活跃，不能删掉落盘记录**。宿主没有「按 id 彻底拆除/摘除已存在会话」的公开能力（`agents.get()` 返回裸 `Agent`，`sessions` 没有 dispose 入口；`Agent.cancel()` / `archiveSession({ stopActivity: true })` 只能停活动、不摘注册表）；`dispose()` 只摘活会话、close/drain 持久化句柄，不删会话日志，宿主也没有删除会话的公开 API。所以 leader 会话改由本 bundle 用 `agents.create` 建（与 worker 同一条路），落盘失败时靠创建时的 `dispose()` 停掉活会话；建会话的实现没交回句柄时只记日志，活会话留在左栏「未分组」里。**已落盘的空会话在进程重启后可能重新出现（按宿主源码推断，未端到端复现）**。宿主依据见[capability-gaps 第 46 条](capability-gaps.md)。

## 客户端与宿主耦合

- **客户端依赖解析走宿主的冻结模块表**：`PLATFORM_MODULES`（rc.2 的宿主自有包为 `dsh-client-store` / `dsh-client-ui-slots` / `dsh-client-ui-primitives` / `dsh-client-ui-dockkit`）没有跨版本承诺，宿主把条目移出基线后，产物里的外部 `require` 解析失败，客户端半边在模块求值阶段整个起不来——`engines.dsh` 下限升级时按 tag 对照 `platform.ts`，不按本机最新版。本仓复用 `ui-primitives` 的 `MarkdownText`（卡片说明与两个气泡）与 `StateDot`（项目行与会话行的运行中加载圈）；`StateDot` 的代价是运行中只有灰圈、项目行激活态消失（`.spinner` 固定 `label-tertiary`，样式随宿主 `apps/web` 产物，插件不自带）。基线之外的宿主 UI 包不保证可用；`Modal` / `Menu` 虽在基线内，仍照宿主源码复制改写（类名换 `dsh-leader-agent-modal-*`，动机是定制而非「用不了」），宿主改 `MarkdownText` 的签名与排版、或改弹窗/菜单时要同步；组件与样式分属两个产物是既有宿主契约，本仓不做兜底复刻。ACP / headless / SDK 不加载客户端半边；自建壳缺宿主样式时组件只剩 SVG 默认填充（`<circle>` 初始 `fill: black`，未实测）。机制与基线清单见[客户端构建约束](../.agents/notes/implemented/architecture/2026-10-23-client-side-findings-and-build-constraints.md)。
- **leader 会话形态依赖宿主的会话视图服务**。宿主没提供 `uiConversation` 服务时（它不在机器可读的插件 API 目录里，属于版本耦合面），leader 会话退化成官方欢迎页（居中输入框），本 bundle 不阻断打开会话，也不自绘替代界面。
- **图标数据与宿主 `ui-primitives` 耦合**。宿主 web 端把图标在构建期内联进产物，运行时 DOM 里没有 sprite 节点，第三方 bundle 在运行时渲染只能自己带路径数据——本次新增的 `apps-add-outline` 路径取自宿主 `ui-primitives`（regular 字重）：`0.2.1-rc.5` 在 `packages/client/ui-primitives/src/icons/index.tsx`（`IconAppsAddOutlineRegular`），`0.2.2-alpha.2+` 的 sprite 重构把它移到 `icons/artwork.ts`。内联本身不依赖宿主版本，版本锚点只为可追溯；宿主改图标时本仓要同步。
- **会话标签栏靠 DOM 注入主面板**。宿主没有原生会话标签，本仓在主面板所在列（`mainPanel` 的父列；`data-slot="main"` 时取外层槽位列）插一条顶行栏（内容与右栏 chip 同带，底部留白给分隔线）；栏可见时给主面板/会话体加 flex 收缩标记，普通会话与栏隐藏时摘掉，不影响宿主布局。宿主改主面板结构或标记时，标签栏可能不显示或落位错误，会话本身不受影响。右栏开关钉在顶行，会话「更多」走宿主 `contextMenus`；都依赖宿主会话头与右栏结构。隐藏宿主标题行原「更多」依赖 `headerMenuButton` 这个 CSS module 类名；宿主改类名时原按钮不再隐藏，会出现两个「更多」入口（标签栏这枚仍可用），这是降级。同页多个主面板只处理第一个（`querySelector`），当前宿主单主面板；分屏/多窗口不保证第二个也落位。标签打开集合按项目存浏览器 localStorage，不随 `$DSH_HOME` 迁移，清缓存或换浏览器后 worker 标签要重新点开；顺序固定为项目树顺序，没有拖拽重排。看板跟随只从 leader 的前台看板发起：从 worker 切到另一个 worker 时目标会话用自己的右栏布局。
- **leader 会话不显示宿主的改动文件卡片，靠渲染层隐藏**。宿主的 `ui-deliverables` 把「已编辑 N 个文件」卡片注册进 `conversation.chat.turnTail`，那个列表槽没有按会话过滤的参数，宿主唯一的开关是全局「显示代码工作视图」（会连带轨迹视图与完整预设列表）。本仓在 leader 会话当前时给**实际主面板节点**（class 含 `mainPanel`；`data-slot="main"` 仅旧版兜底）加 `data-dsh-leader-agent-hide-changed-files`，样式表按宿主的 `data-changed-files` 属性隐藏卡片——只隐藏 DOM，不阻止组件挂载与摘要请求；普通会话照常显示。隐藏用 `display:none`，卡片退出可访问树与 Tab 序，未做完整键盘序回归；同页多个主面板只处理第一个。隐藏 watcher 只认 `mainPanel`，不落到 `data-slot="main"` 旧标记：宿主去掉 class 后 observer 通过属性变化摘掉标记，卡片恢复可见；恢复 class 后重新隐藏。宿主改 `mainPanel` 类名或 `data-changed-files` 标记时卡片会重新出现，这是期望的降级。
- **保留的看板 body 在后台不是完全停摆**。`keepMounted` 让切走的看板不卸载；不可见时停掉 2s 卡片刷新、30s 项目复核、60s 时钟与 `focus` 监听，并关掉 portal 到 `document.body` 的详情/删除确认浮层，剩下的只有宿主的 `tabInfo` / 会话状态订阅、一份按项目的内存卡片快照（不落盘），以及 `useSlotStates` 对卡面槽位会话的 `sessions.retain`——保留同时让宿主不回收这些会话，所以隐藏的看板仍会占住它们，这是圆点状态来源的代价。切回可见时立刻重取一次。弹层打开时经宿主快捷键切会话的路径未能用真实交互复现：宿主没有直接切既有会话的全局快捷键，能新建并切换的 `session.new` 在 `aria-modal` 浮层打开时被宿主的 modal 规则挡下，遮罩也挡住指针；这条清理按防御性处理。
- **工具面裁剪靠宿主的 `tools.restrict()`**。已发布的最新 dsh（`0.2.1-rc.4`）里 `tools.register()` 仍只收一个参数，按步求值的 `when` 只在源码仓 HEAD 上，所以裁剪落在 `agent/created` 时对 `agent.ctx` 调一次 `restrict({ deny })`。leader 身份来自项目注册表——**索引重建完成前不裁**：这时候问不出谁是 leader，而少给工具会让 leader 首轮干不成活；工具面这一层的宽松只对读类工具安全，派工前另行 `awaitIndex()` 并复核身份。
- **浏览器侧 → 宿主侧走 Typert 远程通道**（命名空间 `projects`，经官方 `/api` 共享通道）。dsh 的 `connection.rpc.handle` 对仓外插件不可用（注册作用域拿不到 `webServer`），`/api` 又被官方 gateway 占用；Typert 的 SRC 回退通道允许第三方按协议形状注册服务，但代价是**手写的协议形状与宿主版本耦合**——本仓对齐宿主 `0.2.1-rc.2`（标记属性名、`version:1` 描述符、`typertRemote` 绑定字段、方法形参即 wire 字段名），宿主改契约时本仓要同步改。远程方法名还要避开官方命名空间服务的保留字（撞名会让整个命名空间挂不上）。

## 发布

- **发布不可撤回**：npm 上同一个版本不能重发或删除，只能 `deprecated`；tag 一推上去 workflow 就会尝试发布。所以门禁全挂在上传之前（见[发布与打包](development.md#发布与打包)），别跳过 `release:check`。只从无参 `npm publish` 发布：带路径的 `npm publish <tgz>` 不跑生命周期脚本，整段门禁被跳过。
- **provenance 只在 CI 里生成**：本地 `npm publish` 没有 OIDC 身份，包页面不会显示「Built and signed on GitHub Actions」。前提是仓库 public 且 `package.json` 的 `repository` 与 workflow 所在仓库一致。首次发布只能用本地交互式发布（包不存在时无法登记 trusted publisher），所以首个版本没有 provenance；发过首个版本后改走 OIDC 并禁掉 token 发布。
- **包名与数据目录改名不提供兼容**：`dsh-leader-agent` 是新包，trusted publisher 绑包名、不随仓库改名迁移——新包名要重走首次发布流程（本地首发 → 登记 → bump 新版本打 tag 验 OIDC）；旧包手工 `npm deprecate` 指向新包，不进 CI。用户侧不迁移：`dsh.profile.bundles` 里的旧条目会让两个 bundle 同时 `apply`（工具注册两次、两个 dispatcher 结算同一个 `turn/end`），装前必须 `dsh plugin remove dsh-leader-kit`；旧的看板与 worker 登记也不读不迁。
- **git 直装拿不到客户端产物**：`lib/client.js` 不入库，仓里也没有 `prepare` 钩子。`dsh plugin add git+…` 只适合验证宿主侧；要连客户端一起验证就装 npm 版本，或本地构建后用路径装。
- **不预检 npm 上的版本占用，幂等跳过也不比内容**：`verify:pack` 不查 registry，重复版本由 npm 自己拒；workflow 的 `npm view` 探测只为跳过已发布，不比对 digest——内容一致性由「发布前同一个提交跑过 `release:check`」保证。
- **`verify:pack` 验的是磁盘上已有的 `lib/client.js`**：没先 `build:client` 时它把上一次的产物装进临时目录。`release:check` 先构建，所以发布链路不受影响；单跑门禁时自己保证构建过。
- **装机 smoke 只覆盖宿主侧**：`src/client/**` 依赖 React 与宿主基线模块，装出来的 `node_modules` 里没有它们，所以客户端只验产物形状（closure-factory 外壳）；浏览器里的真实行为靠 `npm run e2e`。
