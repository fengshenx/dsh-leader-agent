# 已知限制与取舍

本文件是「本 bundle 有哪些限制、为什么这么取舍」的唯一归属。README 的[当前限制](../README_ZH.md#当前限制)是给使用者的概览，只列最要紧的几条；决策的完整推演在对应的 [Agent Note](../.agents/notes/)，宿主为什么做不到在某处能力上，见 [capability-gaps.md](capability-gaps.md)。行为与实现见[架构文档](architecture.md)与[使用手册](usage.md)。

## 宿主语义与运行形态

- **后台编排只适用于长驻组合**（web / desktop / sdk）。headless 是一次性 CLI，会话在 turn 结束后即被销毁，届时没有载体接收完成通知——这是宿主语义，不是本 bundle 的缺陷。
- **报告结算依赖轮次正常结束**：结算点在宿主的 `turn/end` 事件上。进程在 worker 跑完之前被杀，那一轮就不会结算（在飞表在内存里，重启即空），leader 也就收不到这次通知；重启后它会看到 worker 会话还在，可以自己打开看或续聊。订阅 `session/event` 不做运行期能力探测——cordis 的 `Context` 永远有 `on`，而宿主低于 `engines.dsh` 下限时本来就没有这个事件；下限 rc.2 已提供 `session/event` 与 `turn/end`，这是版本契约，不是装配期能判定的错误。
- **不能新增 session event 类型**：dsh 要求仓外事件带 `ignorable` 标记且不进读路径，因此卡片与通知状态走自有落盘文件。
- **项目级手册没有 watcher，改动只在下一次模型请求生效**。正在跑的那一轮不会变；两者都是增量信息，不生成兜底正文（协议层 skill 已覆盖通用方法）。leader 手册只对项目注册表里指到该会话的 leader 生效——项目索引还没重建完的那一轮不注入，下一轮补上。求值机制与缺失时的处理见[项目级提示词与协议层](architecture.md#项目级提示词与协议层)。
- **历史消息不追溯**。改造之前发出的通知在 session log 里就是普通用户消息，重放时仍按老形态渲染（右对齐、无头像）。
- **worker 回报不进会话标题、turn 摘要与 markdown 转录导出**。宿主只把 `source.kind === 'user'` 的消息算作真人输入；本仓的回报用自定义 source kind（`dsh-leader-kit/worker-report`），因此会话自动标题不取它、turn 摘要 prompt 不取它、markdown 转录导出会跳过它。换来的是它不会被误当成用户说的话——标题、摘要、导出这三处都只认真人输入。
- **worker 回报的渲染依赖宿主的会话节点扩展位**。本仓注册一个独立的 Chat node kind 并用 exclusive claim 接管这类消息（见 [worker 回报气泡](../.agents/notes/2026-10-27-worker-report-bubble.md)）。宿主若改了 claim 或分组语义，这条消息会退化成普通的右对齐用户气泡——内容不会丢。
- **worker 回报要等父会话空闲才送达**。否则它会像用户自己发的消息一样，以「一条待发消息」的形态挂在输入框上方的「消息队列」条里（对照实验：busy 时直接投，面板显示「2 queued messages」，把人的消息和 worker 回报混在一起）。代价是 leader 正忙时，回报要多等它这一轮结束（投递边界见 [笔记](../.agents/notes/2026-10-27-worker-report-delivery-boundary.md)，机制见[派工与唤醒](architecture.md#派工与唤醒)）。
- **worker 头像在深色主题下轮廓弱**（既定取舍，不是待修项）。气泡底是前景色混出的 4% 一层，36% 的蓝紫色相落上去只有 1.35:1，块的外轮廓看不出边界；头像本身仍可辨。头像池只有 63 个 seed，worker 多时会有撞图（3 个约 4.7%，5 个约 15%），名字就在头像旁边，不影响身份识别。

## worker 的控制面

- **leader 没有中止 worker 的手段，也没有模型侧的名录工具**。worker 是普通根会话，宿主的 `list_agents` / `send_message` / `interrupt_agent` 都作用在 subagent 体系上，对它无效（`interrupt_agent` 还会返回一个假的成功回执）。worker 卡住或跑偏时，只能请人去那个会话里处理；要看项目里有哪些 worker，看项目树（那一层在前端，模型看不到）。这是常驻化的直接代价：换掉 subagent 换来常驻与可下钻，也就换掉了宿主的这套控制面。
- **worker 的权限是派工那一刻的快照**。leader 在派工之后切换 preset 不影响已派出的 worker；后台 worker 的 `ask` 没人应答，一律落到 `unavailable`，所以需要审批的调用会被直接拒绝（继承 `ask` 给后台 worker 仍是死路，只有打开这个会话才可能应答）。
- **`read_worker_session` 是只读视图，不是会话导出**。它读宿主的 `sessionQuery.readSession()`（live 会话读内存快照）并折叠成「一回合一段」：leader 投递的任务、人下钻说的话、worker 说过的正文、调过哪些工具、失败原因、终态。三类 `user/message` 按 `source.kind` 分开——宿主注入的上下文（换目录、plan 模式等）只记条数、不渲染正文，免得冒充任务或挤掉它的预算。正文有条目上限（单条 2000 字符、失败原因 200）与总量上限（12000 字符，按最新优先保留），超出部分丢弃并标注条数与成因（窗口外 / 体积溢出）；截断按码点边界退让，不会切出孤立代理。`turns` 默认 2、最多 20。工具参数与成功结果不返回——那是给排障解释「哪一步失败」，不是完整转录（要完整日志用宿主的会话导出）。权限按项目 leader + 本体系登记归属判，与 `message_worker` 同档；退役 leader 在调用时被判掉。读取路径不调用任何写方法（夹具对 `send` / `append` 等写了硬断言）。
- **读 worker 会话与 worker 是否在跑无关**：会话日志已落盘的部分随时可读，最后一轮缺 `turn/end` 时标「进行中」并按当前已追加的事件展示——不要把半截输出当结论。worker 还没投过第一条消息时没有日志，工具会说明这一点而不是返回空视图。


## 看板与卡片

- **看板在非项目会话里只是提示**。项目目录里的普通会话与被换下的 leader 打开看板，看到的是「看板只在项目会话中打开」；不属于任何项目的会话连这块呈现面都没有。leader 会话被归档或替换后项目绑定不会自动改：项目摘要带 `leaderAlive`，面板每 30 秒复核一次，旧 leader 会话与项目里的执行会话切到「该项目的 leader 会话已失效，请在左栏项目区块换新 leader」的提示，不再展示卡片。呈现面归属见[卡片与看板](architecture.md#卡片与看板)。
- **「看板」入口按会话画，残余在 More 菜单**。右栏 tab 类型与「开始」页的入口是静态注册，宿主没有按会话过滤的扩展点；本插件接管 `sidebar.right.tab.guide.entry` 里自己那一枚胶囊的渲染，只在项目会话（leader 与 worker）里画出来，样式复刻宿主 `EntryBox`。`sidebar.right.tab.guide.actions` 是 root scope、不带会话，「开始」页的 More 菜单仍会列出「看板」；自动弹出仍只跟随 leader 会话（worker 不能建卡）。
- **普通会话与退役 leader 都不能写卡**。卡片是项目里的任务事实，普通会话没有项目归属，建出来的卡没有槽位、没有 leader 认领：在普通会话里让模型「把这个记成卡」不再能落盘，要切到该项目的 leader 会话。退役 leader 的写入工具在会话重建前仍留在工具列表里，但每次写入都按当前身份判一次，调用当场被拒（闸门与 worker 的写入范围见[工具面分配](architecture.md#工具面分配)）。
- **存量卡片不迁移**。存量卡片记录里没有创建会话 id，无法可靠反推归属，所以不迁移——它们不出现在任何项目看板，只能用 `list_cards`（`scope=all`）看到（归属判定见[卡片与看板](architecture.md#卡片与看板)）。
- **非 `active` 卡不能绑槽位**。给已关闭或归档的卡绑执行者会被拒绝；同一次调用里「关掉卡 + 绑定」的组合也拒绝，避免调用方以为绑定生效而实际被释放。同次把状态改回 `active` 是显式重新指派，放行。
- **卡片编号仍是全局的**。按项目过滤后编号会有空洞，但全局唯一，`@#n` 不歧义——比按项目编号更好（见[卡片存储与编号作用域](../.agents/notes/2026-10-23-card-storage-and-numbering-scope.md)）。归档与删除都不回收编号，跨项目也不复用。
- **卡片详情只写链接**。链接编辑走项目通道的 `updateCardLinks`（整体替换 `links`，宿主侧按共享的 `card-links.js` 重新校验、把 http(s) 地址按 WHATWG URL 归一化后落盘并补条目 id）；完成、置顶、重命名、删除仍归 leader 的卡片工具，卡面也不放操作按钮。归档卡是终态，详情不给编辑入口。**跨项目判定不在这条通道上**：远程方法拿不到调用方会话（`direct` 调用不带 ctx），归属之下的写卡限制仍只由工具层执行；这条通道经官方 `/api` 同源链路到达宿主，任何能调 `/api` 的本机页面或进程都能按 id 改任意项目的卡——这是单机单用户威胁模型下的取舍，不比工具更宽，只是少了「防误用」的一致性检查。
- **卡片详情浮层是打开瞬间的快照**。卡片随后被 leader 更新，浮层不会跟着刷新，要关掉重开；本浮层自己保存的链接会立刻回填到浮层与卡面。链接编辑不进乐观并发：详情里的 revision 是打开时的，用它做 `expectedRevision` 会在 leader 改过卡后稳定冲突，而用户表达的意图就是「这些链接现在是这样」。
- **卡面不显示所属项目/工作区**。看板已经按项目过滤，卡面不必再重复标注（无 workspace chip）。
- **会话折叠只认运行态**。宿主的工作区树还会为「有子代理在跑」「等你输入」「未读完成」「当前会话」四种注意力抬高水位，我们手里只有会话行的 `running`，所以只按它抬。收起只在全部放完时出现，与宿主 `sessionsExpanded = hiddenCount === 0` 的口径一致——会话很多时要点若干次「展开其余 N 个会话」，而不是随时能收。
- **「等你输入」档暂无数据源**。宿主的待处理交互机制在（`pendingInteraction`），但当前没有任何域发布它，这一档不会亮；机制与档位都留着，等真有域发布时自动生效。「未读」档已实测跑通。
- **气泡折叠没有布局单测**。折叠水位按 compact 行高算 `max-height`（2 × 20px 行高 + 22px padding/border），是否出现「展示更多」要在 DOM 上量 `scrollHeight` 与 `clientHeight`；本仓不引 jsdom，真实布局只能用浏览器取证（[e2e-testing.md](e2e-testing.md)）。实现形态有源码断言：`tests/markdown.test.js` 钉住折叠不再用 `-webkit-line-clamp`、行高取 compact 值。旧回报走纯文本 `pre-wrap`：没有 `report` 的（回退整条通知正文，协议行）与多行 `report` 既无块级标记又无空行的（早期落盘多块用单个换行连接，Markdown 会折成一段），都不被 Markdown 折行；有空行或块级标记的照常走 Markdown。
- **归档入口只在有 hover 的设备上出现**。按钮的显示挂在 `@media (hover: hover)` 上（与官方会话行一致），触屏上不会出现；归档本身是宿主能力，也可以在别处完成，本区块会跟着 `archivedSessionIds` 快照把行藏掉。

## 项目、树与工作区

- **模型没有项目注册表工具**。`add_project` / `list_projects` / `switch_project` / `remove_project` 都不存在；仓库工程约定也没有专用工具，初始化走 `init-project` skill 的文件写入。宿主注册工作区不校验目录：挂在已删目录上会抛一句英文技术错（本仓的前置检查见[项目与会话归属](architecture.md#项目与会话归属)）。目录选择器不可用时（宿主缺 web-app 的导航服务）无法建项目，需要换用 web profile。
- **项目树是自建的，与官方工作区树并存**。官方只有按工作区分组的会话树，没有「项目」维度。本仓的项目树列出该项目的 worker 与退役 leader，判据分开：worker 看登记表（「登记表说它是本 bundle 派出的 worker」）加 cwd 与项目目录的 realpath 精确相等（worker 是普通根会话，会话头没有身份标记，只能按登记判）；退役 leader 看项目记录的 `retiredLeaderSessionIds`。当前 leader（入口在项目行上）与用户在项目目录里手动开的会话都不算：前者由项目入口打开，后者留在官方工作区树里。
- **「项目会话不出现在官方工作区树」是渲染层排除，不是数据层**。官方没有按外部集合排除行的扩展点，本仓认 `data-row-key="session:<id>"` 给命中排除集的行加隐藏类。排除集含项目的 leader 会话与全部 worker 会话（worker 是普通根会话，官方树不会自己滤掉，不排除就会同时出现在两棵树里）。代价：官方分组行上的会话计数仍包含被隐藏的会话；被隐藏的行仍在 DOM 里，官方搜索仍能命中。
- **子目录里的 worker 不算项目下的 worker**（判据与名单来源见[项目的服务层语义](architecture.md#项目与会话归属)）。
- **项目会话必须归属一个工作区**。本仓把项目会话行藏掉之后，「未分组」里只剩一棵空组头——这是本仓自己引入的约束（注册与复用的机制见[项目的服务层语义](architecture.md#项目与会话归属)）。worker 的挂载是 fire-and-forget：归属只影响分组，挂失败只记日志、不拖累派工，下次点项目行自愈。
- **工作区被用户删掉后按需重建**。用户可能在工作区管理面板里删掉插件注册的那个（左栏与工作区管理面板里都有）。此时项目会话变成松散会话、落回「未分组」，点项目行会重建工作区并把 leader、退役 leader 与该项目的 worker 会话一起挂回去，并给一条顶部提示。只恢复插件自己建的会话，用户在项目目录里手动开的会话不碰；重建的触发与名单见[项目的服务层语义](architecture.md#项目与会话归属)。
- **「未分组」组头留给用户自己**。项目会话都归属工作区，正常情况下「未分组」里没有插件的东西；唯一的例外是工作区被删、又还没点过项目行的窗口期——那时组头会露出来，会话行仍被藏着。本仓不为了这个窗口去复刻宿主的可见性规则（空会话只在它是当前会话时渲染、归档会话默认不进组），那等于把会话生命周期搬进插件。
- **被隐藏的会话不再点亮它所在的工作区**。官方按「当前会话属于哪个分组」给工作区目录图标上主色；leader 与 worker 会话在渲染层被隐藏后，点亮的分组里找不到对应的会话行——分组看着是开着的，却找不到是谁。本仓在当前会话属于排除集时，给承载它的工作区行加类，把图标压回三级标签色（同为渲染层，官方数据层不动）。只在分组视图下压当前会话所属的那一组；树模式下祖先分组仍会点亮。
- **项目目录的工作区行照常显示**。加项目会顺带把目录注册成工作区（原因见[项目的服务层语义](architecture.md#项目与会话归属)），这行就留在官方工作区树里：它是有用的入口，用户可以在项目目录里手动开会话。代价是同一个目录在左栏出现两次（项目区块一行、工作区树一行），且组内的 leader 与 worker 会话行仍被排除、计数比可见行多。早先版本按项目记录的 `workspaceId` 整组藏掉，那是渲染层判定，用户既无法从界面看出它属于哪个项目，也没法在项目目录里找到手动开的会话；后来改成一直可见。
- **项目区块靠 DOM 注入取位**。dsh 的左栏正文区只有 `sidebar.workspaces` 一个槽且已被宿主占用，slot 机制没有包装能力，第三方插不进并列区块——本仓在左栏的「面板列表 nav」之后插容器并用 portal 渲染，位置是「自动化任务之下、工作区之上」；宿主结构变化导致找不到锚点时内容退回原槽，功能不受影响。

## 客户端与宿主耦合

- **客户端依赖解析走宿主的冻结模块表**。`PLATFORM_MODULES`（`packages/client/web/src/platform.ts:8`）是宿主共享给所有 bundle 的冻结模块表，`react` / `react-dom` 也在表里；rc.2 的宿主自有包有四个——`dsh-client-store` / `dsh-client-ui-slots` / `dsh-client-ui-primitives` / `dsh-client-ui-dockkit`，由 `seed.ts:9-19` 静态 import 进 `:26` 的 `getStaticModules`（文件头写明是 shell 共享进冻结模块表的**唯一**集合）。这些 `src/` 文件不在 npm 安装包里（`files` 只发 `lib/`），核对要对着源码仓的同 tag。基线模块由构建期 `BASELINE_EXTERNALS` 留在产物外，运行时 `require` 解析到同一实例；基线里的宿主包可直接复用，本仓用到了 `ui-primitives` 的 `MarkdownText`（卡片说明与 worker 回报气泡）与 `StateDot`（项目行与会话行的运行中加载圈）。`StateDot` 另带两笔代价：`.spinner` 固定 `label-tertiary`（与宿主会话行同款），项目行运行中不再像自绘版那样用 `currentColor` 跟随激活色——运行中槽位只有灰圈、目录图标不渲染，组内激活态在整条项目行上完全消失；它的样式来自宿主 `apps/web` 产物的 `StateDot.module.css`，插件不自带。插件 `dsh.client.platform` 是 `web`，ACP / headless / SDK 的宿主组合不加载客户端半边、组件不会渲染，风险只在自建壳/裸壳（宿主样式未随 web bundle 到达）：那时组件只剩 SVG 默认填充，按规范推导 `<circle>` 初始 `fill: black`、`stroke: none`，会画成黑色实心圆（未实测）。组件与样式分属两个产物是既有宿主契约，本仓不做兜底复刻。**这张表没有跨版本承诺，风险方向是宿主把条目移出基线**：删掉 `ui-primitives` 后产物里的外部 `require` 解析失败，插件客户端半边在模块求值阶段整个起不来——`engines.dsh` 下限升级时按 tag 对照 `platform.ts`，不按本机最新版。**基线之外的宿主 UI 包不保证可用**——不是宿主禁止引用（`dsh.client.external` 可引入由另一个插件行 supplier 的模块，见 `scripts/verify-client-packages.ts:352-381`），而是这些包不承诺运行时可解析。`Modal` / `Menu` 本来就是 `ui-primitives` 的导出、在基线内；确认弹窗与菜单仍照 `packages/client/ui-primitives/src/Modal.tsx`、`Modal.module.css`、`Menu.tsx` 复制改写（类名换 `dsh-leader-kit-modal-*` 前缀、按本仓交互调整行为），动机是定制而不是「用不了」。代价是宿主改这些组件（含 `MarkdownText` 的签名与排版）时本仓要同步。
- **leader 会话形态依赖宿主的会话视图服务**。宿主没提供 `uiConversation` 服务时（它不在机器可读的插件 API 目录里，属于版本耦合面），leader 会话退化成官方欢迎页（居中输入框），本 bundle 不阻断打开会话，也不自绘替代界面。
- **引导卡没有「打开文档」能力**。第三方 bundle 拿不到打开本地文件的通道，发布白名单也把 `docs/` 整目录排除，所以「看上手文档」只能把 `docs/getting-started.md` 复制到剪贴板：从仓库或用源码安装时路径直接可用，从 npm 装的用户拿到的只是一句位置提示——那个文件不在包里。
- **图标数据与宿主 `artwork.ts` 耦合**。宿主 web 端把图标在构建期内联进产物，运行时 DOM 里没有 sprite 节点，第三方 bundle 在运行时渲染只能自己带路径数据——本仓内联的路径取自宿主 `dsh-client-ui-primitives` 的 `artwork.ts`（regular 字重），宿主改图标时本仓要同步。
- **工具面裁剪靠宿主的 `tools.restrict()`**。已发布的最新 dsh（`0.2.1-rc.4`）里 `tools.register()` 仍只收一个参数，按步求值的 `when` 只在源码仓 HEAD 上，所以裁剪落在 `agent/created` 时对 `agent.ctx` 调一次 `restrict({ deny })`。leader 身份来自项目注册表——**索引重建完成前不裁**：这时候问不出谁是 leader，而少给工具会让 leader 首轮干不成活；工具面这一层的宽松只对读类工具安全，派工前另行 `awaitIndex()` 并复核身份。
- **浏览器侧 → 宿主侧走 Typert 远程通道**（命名空间 `projects`，经官方 `/api` 共享通道）。dsh 的 `connection.rpc.handle` 对仓外插件不可用（注册作用域拿不到 `webServer`），`/api` 又被官方 gateway 占用；Typert 的 SRC 回退通道允许第三方按协议形状注册服务，但代价是**手写的协议形状与宿主版本耦合**——本仓对齐宿主 `0.2.1-rc.2`（标记属性名、`version:1` 描述符、`typertRemote` 绑定字段、方法形参即 wire 字段名），宿主改契约时本仓要同步改。远程方法名还要避开官方命名空间服务的保留字（撞名会让整个命名空间挂不上）。

## 发布

- **发布不可撤回**：npm 上同一个版本不能重发或删除，只能 `deprecated`；tag 一推上去 workflow 就会尝试发布。所以门禁全挂在上传之前（见[发布与打包](development.md#发布与打包)），别跳过 `release:check`。只从无参 `npm publish` 发布：带路径的 `npm publish <tgz>` 不跑生命周期脚本，整段门禁被跳过。
- **provenance 只在 CI 里生成**：本地 `npm publish` 没有 OIDC 身份，包页面不会显示「Built and signed on GitHub Actions」。前提是仓库 public 且 `package.json` 的 `repository` 与 workflow 所在仓库一致。首次发布用 `NPM_TOKEN`（包在 npm 上还不存在时无法配 trusted publishing），发过一次后可以改成 OIDC 发布并删掉 secret。
- **git 直装拿不到客户端产物**：`lib/client.js` 不入库，仓里也没有 `prepare` 钩子。`dsh plugin add git+…` 只适合验证宿主侧；要连客户端一起验证就装 npm 版本，或本地构建后用路径装。
- **不预检 npm 上的版本占用，幂等跳过也不比内容**：`verify:pack` 不查 registry，重复版本由 npm 自己拒；workflow 的 `npm view` 探测只为跳过已发布，不比对 digest——内容一致性由「发布前同一个提交跑过 `release:check`」保证。
- **`verify:pack` 验的是磁盘上已有的 `lib/client.js`**：没先 `build:client` 时它把上一次的产物装进临时目录。`release:check` 先构建，所以发布链路不受影响；单跑门禁时自己保证构建过。
- **装机 smoke 只覆盖宿主侧**：`src/client/**` 依赖 React 与宿主基线模块，装出来的 `node_modules` 里没有它们，所以客户端只验产物形状（closure-factory 外壳）；浏览器里的真实行为靠 `npm run e2e`。
