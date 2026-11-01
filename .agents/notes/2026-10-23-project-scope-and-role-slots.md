# 项目作用域与角色槽位

**状态**：revised（P3 返工，2026-10-25；同日再修订：通道改走 Typert、左栏改 DOM 注入取位；2026-10-26 再修订：项目树自建、官方树排除走渲染层、点项目行打开协调者会话；2026-10-26 再修订：移除工作区加二次确认弹窗、归属同步回客户端列表、菜单支持 Escape 关闭；2026-10-26 再修订：协调者会话改用第三方会话视图目标顶进 active 形态，不再跑首轮；2026-10-27 再修订：项目树只列 worker 会话、加项目直接建好不再走注册确认、取消项目工作区的隐藏；2026-10-30 再修订：项目自建工作区的隐藏按 `workspaceId` 恢复、被隐藏会话不再点亮它的工作区）
**范围**：`src/host/projects/`、`src/host/tools/projects.js`、`src/host/slots/`、`src/shared/projects.js`、`src/client/project-panel.js`、`src/client/project-panel-logic.js`、`src/client/project-section.js`、`src/client/confirm-dialog.js`、`src/client/project-remote.js`、`src/client/coordinator-view.js`、`src/client/coordinator-view-logic.js`、`src/client/workspace-exclusion.js`、`src/client/icons.js`

## 背景

P0–P2 已交付协议层、初始化工具、派工唤醒、卡片存储与右栏看板。剩下两件 dsh 缺的东西：**项目作用域**与**角色槽位**。

项目是显式持久实体：`id`/`name`/`directory`/`coordinatorSessionId?`，落盘在独立注册表。建项目 = 建实体 + 建协调者会话 + 绑定，任一步失败则删会话、删实体并重抛；「换新协调者」把旧会话降级为普通会话保留历史。切项目 = 打开该项目的协调者会话。角色槽位是项目根的 `SLOTS.md`，按 `## <槽位名>` 分节，正文作为 role_context 注入会话；每次 turn 构造时重读文件，无 watcher。

dsh 侧最容易误认的是 `workspace` 家族——`ctx.workspaceRegistry`，「提供命名且有序的项目，并按目录归组在其中运行的会话」（`packages/workspace/workspace/README.zh.md:27`）。它是**工作区**语义（目录 + 会话归组），不是项目语义：工作区管代码语境，项目管编排语境（协调者 / 卡 / worker / 手册），同一个目录可以挂多个项目，二者不合并。且 `workspace` 只在 web-app bundle 挂载（`packages/bundle/web-app/cordis.patch.yml:91`），第三方 bundle 不能把它写进 `inject`——声明成必需依赖会让 headless 等 profile 整个插件挂起（P1 已踩过 `sessionController` 的同类坑）。

**本轮返工的起因**：P3 首版实现把「项目」做成「有会话的目录集合」（不建实体，项目标识即目录路径）。该方向是错的——项目是显式注册、有名字、可注销、与协调者会话硬绑定的实体，目录只是它的一个属性。首版实现已整体废弃，本轮按此模型重做。

## 决策

**项目 = 显式注册的持久实体**，落盘在 `$DSH_HOME/dsh-leader-kit/projects.json`（结构 `{version, projects[]}`，与卡片库同域）。字段：`id` / `name` / `directory` / `coordinatorSessionId?` / `createdAt` / `updatedAt`。存储域自建而非用 dsh storage domain：后者要 zod schema 与 `@deepseek-ai/dsh-storage-domain` peer 依赖，仓外 bundle 带内部 peer 会周期性失效（`agent-team` 是活例，见[卡片存储与编号作用域](2026-10-23-card-storage-and-numbering-scope.md)）。原子写（tmp + rename）+ 全部读-改-写走同一条 promise 链串行化 + 库损坏时备份并写回空库。

**项目 ↔ 协调者会话硬绑定**。dsh 的 `SessionHeader` 是封闭字段、没有自由元数据槽（`packages/core/session/src/types.ts:95-138`），第三方无法给会话塞 `projectId`；`coordinatorSessionId` 指针因此存在**项目记录**里，这是绑定关系的唯一真源。`SessionHeader.cwd` 是 readonly 且创建时定死（`:106`），`session.create` 接受 `workspaceId` 或 `cwd` 二选一（`packages/api/session-controller/src/commands.ts:112-124`）——所以「切项目」在 dsh 里天然是「切到另一个 cwd 的会话」。

**建项目 = 建实体 + 建协调者会话 + 绑定，失败整体回滚**。顺序是「先建会话（失败不落盘）→ 再落盘（落盘失败则尽力撤销会话）」。协调者会话创建走双路径：优先 `ctx.get('sessionController').create({cwd})`（仅 web-app bundle 有），降级 `ctx.get('agents').create({sessionId:'session-'+randomUUID(), meta:{cwd}, agentOptions: 默认模型})`（base bundle 全 profile 有）。两条路径都拿不到时如实报错，不静默降级。

**worker 目录由项目决定，协调者不能指定**。派工时用 `resolveWorkerCwd(parentSessionId)` 查项目目录，注入 `subagents.startActivation` 的 `cwd`（`packages/subagent/subagent/src/manager.ts:525-531` 对绝对路径原样采用）。worker 是协调者 spawn 的对等独立会话，授权真源是项目目录而非 cwd 约定。

**项目 ↔ 会话归属自建映射**。宿主侧维护内存镜像 `coordinatorIndex: Map<sessionId, directory>`（落盘是真源，启动时 `loadIndex()` 重建），因为提示词组装与派工都是同步路径，而存储层是异步的。索引只服务读侧，落后一版只影响当轮派工目录。

**槽位读项目目录的 `SLOTS.md`**，目录优先级是「项目目录 → 会话头 cwd → 外部回调」。槽位注入落点是 `ctx.systemPrompt.context()` 注册的运行时上下文而非 `section()`：section 进的是会话级固定的系统提示词消息，槽位改了不会重写；运行时上下文每轮组装时重新求值（`packages/core/system-prompt/src/index.ts:660-664`），「变更在下一轮 turn 生效」是结构性的。**上下文必须注册成 provider**：`refreshContext` 按注册表重新求值，临时追加的项在可选运行时被关掉时会被丢弃（`:591`），声明 `required` 才稳定。**槽位不授予工具权限**——它只贡献一段提示词文本，不注册工具、不改工具可见性，这是结构性保证而非运行时校验。

**client → host 走 Typert 的 SRC 远程通道**（命名空间 `projects`，经官方 `/api` 共享通道）。这条路是首版自建 HTTP 通道（`/coordinator` 前缀 + 同源校验）之后改选的：用户要求复用官方工作区控制器（`WorkspaceController extends TypertRemoteService` + `@Remote` 装饰器）的做法。自建 Web 路由的两条路对仓外插件都不成立——`connection.rpc.handle` 把路由注册到**读取 connection 的那个作用域**上，而该作用域拿不到 webServer 的 inject 声明，注册必抛 `cannot get property "webServer" without inject`（dsh 内部也没有任何 `handle` 的使用者）；`rpc.intercept('/api', …)` 每条通道只允许一个拦截器，官方 gateway 已占用 `/api`。

Typert 侧的关键发现是：**宿主 gateway 在 strict 生成描述符缺失时走 SRC 回退**（`packages/api/gateway/src/index.ts:868-879` 的 `resolveDescriptor` → `resolveSrcDescriptor`），它按服务原型上的方法标记与实例上的服务绑定还原描述符，参数名从方法源码的形参解析。协议包的标记是**稳定字符串 + 版本化描述符**（原型属性 `@deepseek-ai/dsh-typert-protocol/remote-methods`，值 `{version:1, methods:[{method, invocation:{kind:'direct'}}]}`），宿主读标记时不校验来源包的版本——第三方手写同样形状即可，不必装 dsh 内部包（装了会被宿主 peer/engines 校验卡住，且形成两个副本）。于是本仓手写标记、绑定与客户端贡献：宿主侧 `ctx.provide(PROJECT_REMOTE_SERVICE_KEY, remote)`（Cordis 会把反射属性记为 `{type:'service'}`，SRC 回退按这个标记遍历）、实例上 `typertRemote = {service, serviceKey, namespace}`（`service` 必须指向实例本身）、方法形参名即 wire 字段名；浏览器侧 `ctx.remote.$mount(贡献)`，每个入参带 strict codec（`requireStrictInputs` 会拒收没有 strict codec 的描述符）。

**远程方法名要避开官方命名空间服务的保留字**：客户端挂载时官方逐个检查方法名，撞上命名空间服务自身字段或它原型上的方法即拒收**整个命名空间**（`RemoteNamespaceService.assertMethodAvailable`），报 `client api: method "projects/remove" conflicts with its namespace service`——`remove` 撞的是 `RemoteNamespaceService.prototype.remove(kind, method, token)`（rc.2 的 `packages/api/gateway/src/client/index.ts:707`），不是 Cordis 服务原型的成员。本仓因此把 `remove` 改名 `unregister`。（2026-10-30：删除与移除工作区两个入口合并后，方法改叫 `deleteProject`，`unregister` 已删——见[项目删除合并为一个入口](2026-10-30-project-delete-merged.md)、capability-gaps 第 28 条。）

**左栏项目区块靠 DOM 注入取位**：左栏正文区只有 `sidebar.workspaces` 一个槽（已被宿主的工作区浏览占用），slot 机制没有 decorator/HOC 或包装能力，第三方无法在它旁边插入并列区块（`packages/client/ui-sidebar/src/client/SidebarRoot.tsx:295-302`）。用户要求区块落在「自动化任务之下、工作区之上」——该位置在 slot 体系里没有对应槽，只能取 DOM：左栏结构是「面板列表 `nav` → 工作区滚动区 → 底部区」（`:395-412`），footer occupant 里放一个锚点，向上找到第一个「直接子元素含 `nav`」的祖先作为左栏根，在 `nav` 之后插容器并用 React portal 渲染内容。窄栏（导轨）放不下列表，退化为图标入口 + `position: fixed` 浮层。

**client 侧的会话导航走惰性获取 + 降级**。`ctx.uiWorkspace.openSession()` / `pickDirectory()` 由 web-app bundle 提供，第三方 bundle 不把它们写进 `inject`，改用 `ctx.get('uiWorkspace')` 惰性获取，缺失时降级为提示用户在目标目录新建会话。

**项目树自建，与官方工作区树并行；重复部分在渲染层排除**。官方左栏只有一棵按工作区分组的会话树，没有「项目」维度；`sidebar.workspaces` 槽是 single 且已被官方的 `WorkspaceBrowser` 占用，第三方既换不掉渲染也拿不到分组逻辑。于是自建项目树（项目 = 一个目录，展开后列该项目的 worker 会话），与官方树并存，重复出现的会话在渲染层隐藏：官方会话行带 `data-row-key="session:<id>"`，命中排除集的行加一个类，由样式表隐藏，官方数据层不动。

**项目下只列 worker 会话**（2026-10-27 修订）。原先按目录归组，把协调者会话与用户在项目目录里手动开的会话都算成了项目会话——项目树该回答的是「这个项目有哪些 worker」，混进别的会话就答不明白了。判据加上会话头的 `origin: 'subagent'`（子代理会话，协调者派出的 worker 就是这一类）：目录相同**且**是子代理会话才算项目的 worker。协调者会话的入口在项目行上，用户手动开的会话属于用户自己。

> **2026-10-29 修订**：身份判据改成「登记表说它是本 bundle 派出的 worker」，不再看 `origin`——worker 现在是普通根会话，会话头没有这个标记（见 [worker 常驻化与交作业](2026-10-29-worker-as-root-session.md)）。目录相等这一半不变，并且 `isWorkerSession` 现在是 `groupSessionsByProject` 的必需参数。

**取消项目工作区的隐藏**（2026-10-27 修订，与上一条同批）。工作区隐藏与「项目下只列 worker」是连着的：插件注册的项目工作区一旦在渲染层被整棵藏掉，用户在项目目录里手动开的会话（不属于项目、因此不在项目树里）就两边都看不到，无处可寻。取消隐藏后它们回到官方树——项目目录是一个普通工作区，里面是用户自己的会话；项目的 worker 与协调者会话仍由渲染层排除，不在那里重复出现。代价：官方左栏里多出项目目录这一项。渲染层隐藏工作区的整套机制（`workspace-hiding.js`）随之删除，未使用的代码不留。

> **2026-10-30 再次反转**：插件注册的工作区又在渲染层藏回去了，见 [项目自建工作区的可见性](2026-10-30-quiet-workspace-activation.md)。本次只藏**插件自己注册的**那一个（项目记录里有 `workspaceId`），用户自己加的同目录工作区照常显示——正是这一段提到的「被整棵藏掉」的代价，反转后仍然存在：项目目录里手动开的会话不在项目树、也不在左栏分组视图里，只剩宿主搜索与「在一个列表里」视图两条入口。上面「`workspace-hiding.js` 随之删除」这句仍然成立，恢复的隐藏写在 `workspace-exclusion.js` 里（与会话排除同一套观察器）。

**没有借用官方的归档接口做排除**。官方 `workspaceRegistry.archiveSession` 能把会话从所有分组面里摘掉，但归档是用户可见的持久状态——会话会进官方归档视图，注销项目时得逐个反归档，用户自己归档过的会话更不能被反归档。借用它会把「排除」与「归档」两件事搅在一起。

**排除器的观察回调按帧去抖**。排除器观察整棵文档（官方树重绘、虚拟滚动新增行、React 重写 className 都会触发），而聊天消息流式渲染与看板投影更新会让观察回调连续触发——每次回调都全文档扫一遍会话行，在主线程上是重复开销。观察回调改为「同一帧只扫一次」（rAF 去抖），排除集变化仍立即生效（低频事件）。取消时必须一并取消待执行的扫描，否则它会在清理之后把隐藏标记又加回去。

**会话归属判定放在宿主侧**。浏览器没有文件系统，做不了路径归一。宿主按 realpath 归一后（官方 `packages/workspace/workspace/src/entity.ts:125` 的 `realpathNormalize` 同样要求：实测 `/tmp` 与 `/private/tmp` 指向同一目录），把项目目录与全部会话的 cwd 比对，得出「项目 → 会话 id」映射，经远程方法 `sessionsByProject` 下发。子目录里的会话不算这个项目的会话；两个项目指向同一目录时先注册的那个归属。协调者会话不在项目的子会话列表里——它的入口在行的「更多」菜单里，重复列出会让入口含糊。

**项目树两处折叠**：点区块标题「项目」折叠/展开整个项目列表；点项目行的行首槽位折叠/展开该项目下的子会话列表。项目名后面不跟目录路径（路径放进悬停提示）——路径占一行会把项目行撑成两行，与官方工作区行不齐。**点项目行本身是「打开该项目的协调者会话」**——项目行的主用途就是切项目，折叠动作挪到行首槽位（官方工作区行的槽位就是展开箭头，位置天然合适）。「更多」菜单里保留「打开协调者会话」与重命名、换新协调者、注销项目并列。

**项目行的形态照抄官方工作区行**（`packages/client/ui-workspace/src/client/rows/Rows.tsx:288-330` 与 `Rows.module.css:107-166`）。官方的行首是一个 16×20 的槽位：槽里叠着两个元素，平时显示目录图标（展开 `folder-open` / 收起 `folder-close`），`@media (hover: hover)` 下把目录图标 `display:none`、换成展开箭头（实心三角 `triangle-right-fill`，展开时 `rotate(90deg)` 指向下）。用 `display` 互换而不是 opacity，是为了不因两图宽度不同而抖动。点行（或点行首槽位）即折叠/展开。官方把操作按钮放在独立的 `rowActions` 槽里（`display:none`，悬停整行时显示），项目名所在的 `projectText` 是 `flex: 1`，所以按钮天然贴行右端——三点右对齐就是这么来的，不是靠额外的 margin。本仓照搬这一套：行首槽位 16px、悬停换箭头、箭头展开时旋转、`rowActions` 悬停显示、项目名 `flex: 1`。

**图标自己内联，不引用宿主 sprite**。宿主源码里图标有两种渲染：运行时的 `<use href="#dsw-icon-…">` sprite，与 web 端**构建期内联**后的 path。web 端产物里没有 sprite 节点——探针实测运行时 DOM 里 `symbol` 数为 0、`[data-dsh-icon-sprite]` 不存在，宿主自己的图标也都是内联 path。第三方 bundle 是运行时才渲染的，拿不到那份构建期产物，于是 `<use>` 引用一律落空（图标尺寸 0×0，完全不可见且不报错）。因此本仓内联需要的字形路径，数据取自宿主 `dsh-client-ui-primitives` 的 `artwork.ts`（regular 字重，描边 1px），代价是与宿主图标数据耦合。

**协调者会话必须归属工作区，否则官方 UI 打不开**。宿主 `session.create` 只在传 `workspaceId` 时才会把会话挂进工作区（`packages/api/session-controller/src/commands.ts:105-145` 的 `workspace.attachSession(sessionId)`）；传 `cwd` 建出的会话**不归属任何工作区**，官方树里没有它的位置，调用 `uiWorkspace.openSession()` 后主区域仍停在欢迎页。本仓建协调者会话时先按 realpath 归一后的目录找既有工作区，找到就复用、没有就 `workspaceRegistry.create(canonical, 目录末段)` 注册一个，然后把 `workspaceId` 交给 `sessionController.create`（`workspaceId` 与 `cwd` 二选一，宿主会拒收同时传）。注册是幂等的，宿主侧已有同名工作区直接复用。旧项目的协调者会话建于本机制之前、无法事后变成工作区会话，改由打开时补挂：工作区实体有 `attachSession(sessionId)`（校验会话头 cwd 与工作区 path 一致，`packages/workspace/workspace/src/entity.ts:102-130`），挂不上就把原因报给用户，不静默失败。**代价**：点一次项目会在 dsh 的工作区列表里多出该项目目录——这是「会话能被官方 UI 打开」的必要条件，不注册就没有任何 UI 路径能打开它。

**「更多」菜单复刻官方材质，不用官方 Menu 组件**。仓外插件不能 import 宿主 UI 包（`docs/subsystems/web-client.zh.md:93` 禁止为绕过规则而添加 `dsh.client.external`），官方的 `Menu` 组件用不了。于是照官方 `packages/client/ui-primitives/src/Menu.tsx` 与 `MenuSurface.module.css` 的变量与数值复刻：容器 `position:fixed`、`padding:4px`、`min-width:144px`、`max-width:360px`、`border-radius:var(--dsw-radius-lg)`、`background:var(--dsw-menu-surface-fill)`、`backdrop-filter:var(--dsw-menu-backdrop-filter)`、`box-shadow:var(--dsw-elevation-prominent)`，并带 `data-menu-material="translucent"` 让宿主全局材质选择器接管；菜单行 `min-height:34px`、`padding:6px 8px`、`font-size:13px`、`border-radius:var(--dsw-radius-md)`、图标槽 14×14，危险项用 `--dsw-alias-state-error-primary` 与 `--dsw-alias-interactive-bg-hover-danger`。菜单用 portal 挂到 `document.body`，避免被左栏的 `overflow` 裁掉。

**会话行是纯文字行**。子会话行左侧的会话图标与右侧的执行者标记都不画：项目树里会话名已经能看清，加图标只会挤占标题宽度。行首只保留一个 10×10 的状态位，运行中的会话在里面转圈——它是状态反馈而非图标。

**插件工作区的归属记进项目记录**。项目目录必须在宿主里有工作区（会话归属工作区才能被官方 UI 打开），这些工作区是插件自己注册的还是复用了用户自己的，需要分得清——项目记录多一个 `workspaceId` 字段，写明这个项目的工作区是插件注册的那个，「从 dsh 移除工作区」这个入口也据此判断是否该出现。官方的工作区标题保持原样——标题是用户可见数据，把插件的实现名塞进去既不必要，也会让用户以为工作区坏了。（2026-10-27 修订：原先这里还有一段「从官方工作区树隐藏工作区」的机制——宿主的**工作区记录是封闭 schema**（`path` / `title` / `sessionIds` / 时间戳，`packages/workspace/workspace/src/spec.ts`），没有隐藏位，只能走渲染层隐藏（官方工作区分组行带 `data-row-key="workspace:<id>"`）——已随工作区隐藏一起取消，见「取消项目工作区的隐藏」。**2026-10-30 再次反转**：这套渲染层隐藏按 `workspaceId` 恢复，理由与实现见 [项目自建工作区的可见性](2026-10-30-quiet-workspace-activation.md)。）

**只有插件自己注册的工作区才记进项目记录**。复用的工作区不记——用户自己加的工作区即便目录与项目相同也不是我们的，插件对它没有「移除」的立场。判据因此统一成「项目记录里有 `workspaceId` 即插件工作区」，项目列表只对这类工作区给出 `workspaceId`。代价：用户手动删掉工作区后记录悬空，下次打开项目会重新注册并把记录更新到新 id。

**移除工作区要先问一句，弹窗照抄宿主 Modal 改写**。移除工作区本身是可逆的（宿主 `delete` 只删注册，目录与全部会话日志留着，协调者会话仍在），但它动的是用户在 dsh 里看得见的列表，误点就少一个工作区。因此菜单项只发请求，弹窗确认后才执行。第三方 bundle 不能 import 宿主 UI 包（`docs/subsystems/web-client.zh.md:93`），官方的 `Modal` 组件用不了，于是照 `packages/client/ui-primitives/src/Modal.tsx`（91 行）与 `Modal.module.css`（131 行）复制一份改写：结构与样式数值照抄（380px 宽、28px 圆角、`rgba(0,0,0,0.24)` 遮罩、`--dsw-mask-blur` 遮罩模糊），类名换成 `dsh-leader-kit-modal-*` 前缀，`clsx` 换成字符串拼接。保留的行为有遮罩点击关闭、Escape 关闭、Tab 焦点循环、初始焦点落在 `data-modal-autofocus` 元素、关闭后焦点返回触发元素；省略的是 IME 组合输入保护（确认框没有可输入控件，只在按键判断里留 `event.isComposing` 检查）与 `observeComposition`。焦点样式仍借用宿主主题的 `[data-dsh-automatic-focus]:focus` 抑制规则（`packages/client/ui-theme/src/styles/base.css:36`）——这条规则由宿主主题提供，不是本仓定义的。

**归属要同步回客户端的列表**。工作区可能是这次打开才注册的（之前被移除过），归属记在宿主侧的项目注册表里，客户端那份列表是打开前的快照——不同步的话「从 dsh 移除工作区」这个入口要等页面刷新才出现。所以 `attachCoordinator` 返回的是**项目记录里的**工作区 id（复用的用户工作区不在记录里，返回 undefined），客户端拿它更新列表里那一项。服务端回读时要用 `store.get` 重读一次记录：`store.update` 刚写进去的 `workspaceId` 不在调用方开头取到的旧对象上，直接读旧对象会漏掉。

**菜单按 Escape 要关**。官方 `Menu` 明确支持 outside click / Escape 关闭（`packages/client/ui-primitives/src/Menu.tsx:135`），本仓的菜单原本只认点击外部，Escape 无反应——与官方不一致，补上。

**协调者会话靠第三方会话视图目标顶进官方 active 形态，不跑首轮**。dsh 对空会话渲染欢迎页（hero）：主区域形态由 `conversationPhase(session, conversation)` 决定（宿主 `packages/client/ui-conversation/src/client/contract/snapshot.ts:26-34`），它在 `conversation.activeTargets` 非空时返回 `'active'`，`ConversationMainPanel` 据此把输入框从居中改成停靠底部（`packages/client/ui-conversation/src/client/skeleton/ConversationMainPanel.tsx:33-52`，形态同时写进主区域的 `data-phase` 属性）。`activeTargets` 是「已激活且 `isActive` 为真」的会话视图目标集合（`packages/client/ui-conversation/src/client/conversation/assembler.ts:443-455`），而宿主明确写了这条路对第三方开放：「其他消费者则通过 target source 的首个订阅激活 target」「第三方 View 使用相同的选择与激活操作」（`docs/subsystems/conversation.zh.md:26,28`），槽位目录也直接给了第三方注册 `conversation.view` 条目的示例（`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:2105`）。于是本仓注册一个只提供活动、不产出内容的视图目标（`ctx.uiConversation.views.register`），在协调者会话被打开时激活它（`ctx.uiConversation.binding(sessionId).activate(target)`）——官方外壳自己切到 active 形态：输入框停靠底部，会话区保持空白。**不跑首轮、不产生模型调用、转录里不留任何消息**，用户看到的正是「发了消息后的那个 View，只是还没有消息」。目标**不注册成可见 tab**：`conversation.view` 是 list 槽位，条目只支持 `id`/`order`/`label`，没有按会话过滤的能力，可见 tab 会出现在所有会话的头部。

**激活动作挂在 `conversation.input.dock` 槽位**（list 槽位、session 作用域、宿主注释 "Full-width entries above the composer card"，`packages/client/ui-conversation/src/client/contract/slots.ts:304`）：那里按会话渲染，入口拿得到 `sessionId`，而宿主在会话打开后才建绑定——正好是激活时机。条目渲染空内容（不占空间），激活放在 layout effect 里——它在浏览器绘制前执行，「先闪一帧居中欢迎页再跳到底部」不会发生。激活是 per-binding 的（binding 重建后已激活集合归零），所以每次条目挂载都重新激活一次。

**协调者会话名单独立拉取**。名单来自 `projects/list`，但不能挂在项目面板上——侧栏收起时面板会卸载，索引会空，协调者会话会退化成欢迎页。于是另起一个 watcher 独立拉名单，并在通道就绪与窗口重新获得焦点时补拉。

## 边界

- **卡片不按项目分区，编号仍全局递增**。按项目编号要迁移存量卡片的编号作用域（已在[卡片存储与编号作用域](2026-10-23-card-storage-and-numbering-scope.md)里记为已知代价），本轮不做，列 P4。因此跨项目的卡片在同一个库里混列，`@#n` 引用在跨项目场景下会歧义。
- **项目实体只有 name 与 directory 可变**。更新走字段白名单（`name` / `coordinatorSessionId`），目录在创建时定死——目录变了就等于换了一个项目。
- **点项目会把项目目录注册成 dsh 工作区**。官方 UI 只能打开归属工作区的会话，不注册就没有打开路径。工作区不再从官方左栏的工作区树里隐藏（2026-10-27 修订，理由见上）；工作区仍在宿主的数据里，用户可在 dsh 的工作区管理面板里看到并删除它。
- **项目工作区在官方 UI 里没法直接删**。删除入口放在项目自己的「更多」菜单里（「从 dsh 移除工作区」），走宿主 `workspaceRegistry.delete(id)`——它只删工作区注册，目录与全部会话日志都留着，协调者会话仍在，只是不再归属工作区；下次打开项目会重新注册并挂上。宿主侧的工作区注册表与本仓的项目注册表是两份数据，删除时两边同步清。（2026-10-27 修订：原先的理由是「工作区被隐藏后官方树里没法删」，隐藏已取消，入口保留是因为插件注册的工作区归项目管。2026-10-30 隐藏又按 `workspaceId` 恢复了，但入口不因此恢复——理由已经与隐藏无关。）
- **官方工作区控制器不走 `/api` 通道**——删除入口只能经 host 侧的 `workspaceRegistry`，机制细节见 capability-gaps 第 33 条。
- **用户自己加的同目录工作区不受影响**。复用来的工作区不写进项目记录，既不改标题也不隐藏（2026-10-30 的隐藏按项目记录的 `workspaceId` 认身份，不记就不藏，见 [项目自建工作区的可见性](2026-10-30-quiet-workspace-activation.md)）；它的会话计数会因我们的协调者会话而多一个（那一条会话在渲染层被排除，官方数字仍计入）。
- **两个项目指向同一目录时，子会话归属先注册者**。demo 与 demo2 都指向 `/tmp/dsh-demo-project`（realpath 归一后同一目录），后者的协调者会话会出现在前者的子会话列表里——归属按目录判定，不按项目判定。
- **注销项目保留协调者会话**。注销只移除注册表条目，会话留在会话库；本轮不做级联删除，避免误删历史。
- **协调者会话与 worker 会话在官方工作区树里都不出现**。它们属于项目目录，落在排除集里；worker 另有一层过滤（subagent 会话官方左栏本就不显示）。两者的可见入口都在自建的项目树下。

  > **2026-10-29 修订**：worker 不再是 subagent，官方左栏不会自己滤掉它们，排除集必须显式包含 worker 会话（`collectExcludedSessionIds`）。
- **官方分组行上的会话计数与实际可见行数对不上**。排除只发生在渲染层，官方分组行上的数字仍按数据层算。
- **被排除的行仍在 DOM 里**。官方搜索等按数据层工作的功能仍能命中它们，只是不可见。
- **项目区块靠 DOM 注入取位，不是 slot 能力**。dsh 没有与工作区并列的区块槽，这是扩展点的硬限制；本仓取「面板列表 nav 之后」这个位置靠的是宿主 DOM 结构，宿主改版会让区块位置漂移。找不到锚点时内容退回原槽渲染，功能不丢。
- **图标路径数据与宿主 `artwork.ts` 耦合**。web 端运行时没有 sprite，第三方只能自带路径数据；本仓内联的路径抄自宿主 `dsh-client-ui-primitives`（regular 字重），宿主改图标时本仓要同步。这与「手写 Typert 协议形状」是同一类版本耦合。
- **图标渲染层没有单测**。`src/client/icons.js` 依赖宿主注入的 `react`（本仓 `dsh.client.external` 声明），`node:test` 环境里无法 import，因此该文件靠浏览器实测取证（图标尺寸与 path 数已量），不进单测覆盖。
- **项目与 workspace 会互相吸收**。用户若把项目目录加入 workspace，官方树里那棵工作区分支下的会话行仍被排除——排除集按项目目录判定，与 workspace 归属无关；项目树也不受影响（它读注册表与宿主的归属判定，不读官方会话树）。
- **手写的 Typert 协议形状与宿主版本耦合**。本仓对齐宿主 `0.2.1-rc.2` 的标记属性名、`version:1` 描述符、`typertRemote` 绑定字段与「形参名即 wire 字段名」的解析规则；宿主改这几处契约时本仓要同步改，且要重跑契约测试（宿主升级后必做）。
- **槽位变更对在途 turn 不生效**。dsh 在 step 前组装提示词，组装结果对该 step 固定；生效边界是下一个模型请求。槽位只对绑定了卡片槽位的会话生效，未绑定时注入为空串。
- **运行时上下文是增量快照**。宿主只在快照文本变化时追加新消息（`packages/core/agent-loop/src/runtime-context.ts:155`），槽位正文没变的那一轮不重复注入。
- **协调者形态依赖宿主的会话视图服务**。宿主没提供 `uiConversation` 服务时（它不在机器可读的插件 API 目录 `api-catalog.ts` 里，属于版本耦合面），协调者会话退化成官方欢迎页（居中输入框），插件不阻断打开会话，也不自绘替代界面。
- **视图目标只提供活动，不产出内容**。会话区仍是官方那个空 Chat 视图，本仓不画任何东西；协调者会话因此**不进官方转录**，历史为空，直到用户自己发出第一条消息。
- **激活只覆盖协调者会话**。条目对每个会话都渲染，但只有命中协调者名单的会话才激活目标；官方普通空白会话仍是 hero（实测反例）。
- **不改动宿主投影**。宿主对空会话的形态判定仍按自己的规则走，本仓只是让外壳命中另一条判定分支，不伪造会话历史。

## 证据

机制结论来自 dsh 0.2.1-rc.2 源码阅读，引用位置逐条标在正文；两条实现期修订（项目模型、注入落点）的实测证据如下。

- **项目实体落盘与回滚**：mock LLM 实测调 `add_project` → `~/.dsh/dsh-leader-kit/projects.json` 写出完整记录（id / name / directory / coordinatorSessionId / 时间戳），协调者会话目录即项目目录；建会话失败时注册表不落盘。
- **worker 目录跟随项目**：在项目协调者会话内调 `spawn_worker` → worker 子会话落在项目目录对应的会话目录。
- **左栏渲染与位置**：web profile 实测宽栏 AX 快照顺序为「全局面板（插件 / 自动化任务）→ 项目（标题 + 加项目按钮）→ 工作区（搜索 / 视图选项 / 添加工作区 / 会话树）」——区块落在「自动化任务之下、工作区之上」。
- **排除标记在去抖后仍然生效（浏览器实测，探针已删）**：真实实例展开官方工作区分组 → 该组 19 个会话行里，项目下的 5 行被加隐藏类且 `getComputedStyle` 为 `display:none`，其余 14 行可见；无 console error。（展开分组走的是观察回调路径，正是去抖生效的那条。）
- **项目树与排除（浏览器实测，探针已删）**：探针驱动窄栏入口与项目展开按钮 → 渲染出 3 个子会话行（`ourRows: 3`）；造一条 `data-row-key="session:<项目会话id>"` 的行验证排除器 → 被加隐藏类且 `getComputedStyle` 为 `display:none`；官方树里 `test` 工作区下的真实会话行（`session-090d74bf-…`，即 `test` 项目的会话）同样 `hidden:true / display:none`。
- **交互（浏览器实测，探针已删）**：点项目行的行首槽位 → 展开 4 个子会话行，再点 → 收起（0 行）；点标题「项目」→ 项目行清空（列表折叠）；项目行内不再有路径文本（`hasMeta: false`），路径在悬停提示里；「更多」菜单四项为「打开协调者会话 / 重命名 / 换新协调者 / 注销项目」。
- **行首槽位与三点对齐（浏览器实测，探针已删）**：探针读样式表与几何——行首槽宽 16px（官方 `.slot` 同值）；静止态目录图标 `display: block`（flex item 被 blockify）、箭头 `display: none`；`@media (hover: hover)` 规则与官方逐条对应（悬停时箭头 `inline-flex`、目录图标 `none`），箭头展开态 `transform: rotate(90deg)`；「更多」容器右边缘距行右边缘 8px＝官方行的 `padding: 0 8px`，即三点贴行右端。点行首槽位（探针记到的点击目标是 `SPAN.dsh-leader-kit-project-lead`）→ 该行 `aria-expanded` 由 `false` 变 `true`、子会话行数 4 → 再点回 `false`、子会话行数 0。
  ⚠️ 未取证的部分：真实鼠标悬停时的画面（悬停规则本身已按官方实现，但浏览器会话不在前台时点击与截图都无效，取不到悬停态截图）。
- **图标（浏览器实测，探针已删）**：改动前 12 个 `<use>` 全部 0×0（`symbolCount: 0`、`[data-dsh-icon-sprite]` 不存在，宿主自己的图标是内联 path）→ 改为内联路径后：标题区 3 个图标、项目行 9 个图标，尺寸分别为 14×14 与 16×16，path 数 1~3 不等。窄栏浮层与宽栏的截图均确认图标可见、展开/收起状态由 chevron 方向区分。
- **通道行为（Typert）**：`curl` 打官方 `POST /api/projects/list` 返回 200 与完整项目列表；多传字段被宿主拒为 `gateway/arguments-invalid`（说明严格字段校验生效）；不带会话 cookie 返回 401（官方鉴权生效，强度高于首版的同源校验）。`POST /api/projects/sessionsByProject` 返回 200 与「项目 → 会话 id」列表，其中裸 uuid 的 id 是 subagent 会话（worker 会话确实归到项目下）。
- **浏览器侧链路**：浏览器 console 实测取回项目列表（`list 返回 [...]`，探针已删），证明 `ctx.remote.$mount` 挂载成功且宿主服务可被 SRC 回退发现。
- **「就绪通知只发一次」是实测踩出来的**：面板首次挂载早于通道挂好时，报「项目通道不可用」且不会自愈——订阅就绪事件时若通道已就绪必须补一次通知。修完这一处，界面上不再出现该错误。
- **点项目行打开协调者会话（浏览器实测，探针已删）**：点 `demo` 项目行 → 主区域 `innerText` 里的「选择一个工作区开始」消失，出现会话标题与输入框占位「描述你想要构建的内容, / 调用指令, @ 文件或对话」，`notices=[]`（无报错提示）。
- **协调者会话挂工作区（curl + 文件校验）**：`POST /api/projects/attachCoordinator`（payload `{"args":{"id":"9ec30436-02e5-495d-b095-c0d1b519e760"}}`）→ `{"ok":true,"value":{"attached":true,"workspaceId":"536ecde4-47ea-4e4d-a59c-167da1ac6c53"}}`；`~/.dsh/storages/workspace.json` 里该工作区 `path=/private/tmp/dsh-demo-project`、`title=dsh-demo-project`，且协调者会话 `session-3949fcda-…` 已在它的 `sessionIds` 里。
- **会话行去图标（浏览器实测，探针已删）**：5 个子会话行的 `svg` 数为 `[0,0,0,0,0]`——左侧会话图标与右侧执行者标记都没了。
- **菜单几何（浏览器实测，探针已删）**：菜单在 `document.body` 下、`position: fixed`、`data-menu-material="translucent"`、背景 `rgba(248,249,250,0.58)`、`backdrop-filter: blur(40px) saturate(1.5)`、阴影为官方 elevation 组合、`border-radius: 16px`、`padding: 4px`、`min-width: 144px`；菜单行 `min-height:34px` / `font-size:13px` / `padding:6px 8px` / `border-radius:12px` / `gap:6px`，菜单项图标 5 个（打开协调者会话 / 重命名 / 换新协调者 / 从 dsh 移除工作区 / 注销项目，其中移除工作区只在项目有插件注册的工作区时出现），危险项颜色 `rgb(236,19,19)`。定位用「更多」按钮的矩形，宽为 0（该按钮悬停才显示，脚本点击时量不到）时退回行首槽位的矩形——否则菜单会贴到视口左上角 (0,4)。
- **插件工作区隐藏（浏览器实测，探针已删）**：注入一条 `data-row-key="workspace:536ecde4-…"` 的行 → 探针读到 `cls="dsh-leader-kit-hidden-workspace"`、`data-dsh-leader-kit-workspace="true"`、`display:none`；`curl` 打 `POST /api/projects/list` → demo 的 `workspaceId` 为 `dcdf0a59-…`，test（用户自己的工作区 `72b91e02-…`）为 `undefined`（不隐藏）。点 demo 项目行后主区域切到会话视图、`notices=[]`。
  ⚠️ 这条取证描述的是**当时**的机制：2026-10-27 取消工作区隐藏、2026-10-30 又按 `workspaceId` 恢复（收窄到插件自己注册的那些，见 [项目自建工作区的可见性](2026-10-30-quiet-workspace-activation.md)）。判据（`data-row-key="workspace:<id>"` + 「项目记录里有 `workspaceId` 才藏」）至今未变，只是类名与实现文件换了。
  ⚠️ 未取证的部分：宽栏下**官方真实工作区行**被隐藏的画面——当前实例窗口是窄栏，官方工作区树一行都不渲染（探针 `real=[]`），真实行只能靠源码确认 `data-row-key` 格式（`packages/client/ui-workspace/src/client/rows/Rows.tsx:290`）+ 假行验证。
- **工作区归属改记项目注册表，官方标题保持原样（接口实测）**：`POST /api/projects/list` → demo 的 `workspaceId` 为 `dcdf0a59-…`（记录里的值），test（用户自己的工作区 `72b91e02-…`）为 `undefined`；欢迎页的「选择工作区」显示 `dsh-demo-project`，无前缀。
- **移除工作区可逆（接口实测）**：`POST /api/projects/removeWorkspace` → 对 test 返回 `{removed:false, reason:"该项目没有由插件注册的工作区。"}`（无副作用）；对 demo 返回 `{removed:true}` → `~/.dsh/storages/workspace.json` 里该工作区记录与全局顺序里的 id 都没了，项目记录里的 `workspaceId` 被清空；再 `attachCoordinator` → 重建出 `dcdf0a59-…`，标题 `dsh-demo-project`，会话重新挂上（`sessionIds` 长度 1）。
- **移除工作区的二次确认弹窗（Playwright 无头实测，探针已删）**：菜单五项「打开协调者会话 / 重命名 / 换新协调者 / 从 dsh 移除工作区 / 注销项目」；点「从 dsh 移除工作区」→ 弹窗 `role="dialog" aria-modal="true"`、`aria-label="从 dsh 移除工作区"`、标题同文案、描述「将把项目「demo」的工作区从 dsh 里移除。文件夹与全部会话记录都会保留，协调者会话仍在；下次打开这个项目会重新挂上。」、按钮为关闭图标 / 取消 / 移除工作区；计算样式 `width=380px`、`border-radius=28px`、`background=rgb(255,255,255)`、`box-shadow=rgba(0,0,0,0.16) 0px 0px 0px 0.5px, rgba(0,0,0,0.04) …`、`padding=0px 0px 24px`、遮罩底色 `rgba(0,0,0,0.24)`、`backdrop-filter: none`（宿主 `--dsw-mask-blur` 就是 none），与官方 `Modal.module.css` 逐项一致；初始焦点落在「移除工作区」按钮上且带 `data-dsh-automatic-focus`。取消 → 弹窗数 0、工作区仍在；确认 → 弹窗关闭、面板提示「已从 dsh 移除项目「demo」的工作区。协调者会话保留，下次打开项目会重新挂上。」、`~/.dsh/storages/workspace.json` 里该工作区记录消失。
- **归属同步回列表（Playwright 无头实测，探针已删）**：移除工作区后菜单四项（无「从 dsh 移除工作区」）；再点项目行打开协调者，菜单恢复五项；改用菜单里的「打开协调者会话」触发同样恢复。两条入口都验过。修复前这一步不恢复——服务端 `attachCoordinator` 报的是旧对象里的 `workspaceId`（`store.update` 刚写入的值不在那个对象上）。
- **菜单 Escape 关闭（Playwright 无头实测，探针已删）**：菜单打开时可见菜单数 1，按 Escape 后 0，与官方 `Menu.tsx` 的 outside click / Escape 一致。
- **一次无法复现的失败**：给菜单加 Escape 监听后立刻跑 `npm run check` 报 1 例失败，随后连跑 15 次（含逐文件单跑）全绿。改动内容与该失败无因果关系，但如实记下。
- **单元测试**：196 例全绿（基线 200：删掉首轮机制相关的 17 例，新增视图目标与会话索引 12 例，另有面板用例合并）。新增覆盖：视图目标 id 固定 / `isActive` 为真 / builder 快照恒定 / 会话索引订阅即刻回调 / 名单没变不通知 / 退订后不通知 / 从项目列表取协调者会话 id / 非数组返回空 / 绑定存在时激活 / 未绑定不激活 / 服务缺失不激活；另有「建项目不发起任何模型调用」与「打开协调者只挂工作区再开会话」两条回归。
- **worktree 里的改动也进不了 bundle 产物**：client 产物由 web 进程启动时打包，改动后必须重建产物并重启 web 进程，刷新页面才会生效。
- **空会话的欢迎页根因（Playwright 无头实测，探针已删）**：空会话渲染 hero 不由插件决定，而是宿主 `conversationPhase` 的判定：会话为空（`sessionListMetadata.blank`）且没有激活中的视图目标时返回 `blank`/`engaging`，主区域即居中欢迎页。首轮机制曾试图用一次真实模型调用把会话变非空，本轮已整体撤销——那条路既消耗模型调用，又在转录里留下用户没要求的消息。
- **协调者会话视图目标顶进 active 形态（隔离 mock 实例，Playwright 无头实测，探针已删）**：`DSH_HOME` 隔离 + 独立 profile + 自建 mock provider（默认模型指向 `mock/mock-echo`，全程零真实 API 调用）→ 新建项目 `mockproj4`（协调者会话 `session-c891099c-…`，从未产生任何 turn）→ 点项目行 → 主区域 `data-phase="active"`、页面无「Into the Unknown」、转录节点数 0（一条消息都没有）、Chat tab 被选中；无 pageerror、无 console error。
- **没有欢迎页闪烁（逐帧 rAF 采样）**：逐帧记录 `data-phase` 与欢迎页存在性，点击时刻（Δ0ms）还是点击前的「未选会话」hero，点击后第一帧（Δ31ms）已是 `active`，中间没有「会话已打开但仍是 hero」的帧——layout effect 激活方案成立。
- **普通空白会话不受影响（反例实测）**：用官方「New session in Default workspace」建出的空白会话仍是 `data-phase="hero"`、欢迎页在、输入框居中（top=451 / bottom=503 / h=52）——机制只作用于协调者会话。
- **输入框位置与官方 active 布局一致（逐元素 dump）**：空白协调者会话的 composer 座位是 `top=794 bottom=900`，输入框 `top=802 bottom=838 h=36`；同一实例里发过消息的会话座位是 `top=772 bottom=900`，输入框 `top=780 bottom=816 h=36`——两者的 22px 差是宿主自己的**用量统计条**（座位文本里的「3 turns 3 steps·31500 tok/s 93 tok·Cache hit 0%」，跑过 turn 的会话才有），与本机制无关。
- **截图证据**：PR #3 的评论「截图证据」条（图片以附件形式给出，不入仓库）——隔离 mock 实例，点项目行打开空白协调者会话后拍摄；画面是官方标题栏 + Chat/Trajectory tab + 空白会话区 + 底部官方 composer，无欢迎页。
