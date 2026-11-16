# Agent Note: 项目会话标签栏

Status: implemented

## Problem

宿主主区域一次只挂一条会话，没有原生多标签。项目树能把人送进 worker 会话，但进去之后想回 leader 或换另一个 worker，只能回左栏重新找行。需求是：项目会话有一条自己的标签栏，点开 worker 形成标签，普通会话没有栏，worker 标签带状态灯。

宿主不提供多标签能力，只能在主面板上补一层呈现，同时不能动宿主的会话本体与项目数据。

## Decision

- **只认项目会话**：当前会话是项目 `leaderSessionId` 或登记表里的 worker 才显示；同目录的普通会话、退役 leader、`leaderAlive === false` 的项目都隐藏。没有 live worker 的项目也不显示——只有 leader 时没有可切换对象。
- **第一条标签是项目名**（文件夹图标），点它打开 leader，不单列 Leader 标签。worker 标签只在点开过之后出现，顺序跟项目树的会话顺序，不跟点开先后。
- **关标签不关会话**：只从 localStorage 的打开集合里删一条 id，会话与历史仍在项目树里，再点一次行就记回来。关当前标签先切回 leader，避免补记逻辑在同一帧把它加回来。
- **键盘可达**：标签用 roving tabindex，只有当前标签 `tabIndex=0`；←/→ 循环、Home/End 到首尾，切换会话与聚焦同步。关闭按钮保留自己的回车/空格语义。
- **按项目持久化**在 localStorage `dsh-leader-agent.session-tabs.v1`，不进 `$DSH_HOME`：标签是浏览器侧导航快捷方式，不是会话真源，不值得为它加写宿主数据的协议。
- **状态灯复用宿主 `StateDot` 三档**：运行中、完成未读、空闲，与项目树会话行同一口径。「等你输入」「失败」不在会话快照里，不另造判定。
- **切 worker 时看板跟着走**：leader 右栏里已经有看板 tab、右栏展开、且看板是 leader 的前台 tab 时，切到 worker 后在 worker 的右栏把它打开——看板按项目组织，内容仍是同一块。宿主右栏按会话存布局，没有跨会话 pin 的入口，所以不是把右栏钉在 leader，而是在目标会话里补开同一个 tab；leader 没开看板、停在其他 tab、或右栏收着时不替用户打开（收起时强行展开会抢焦点）。
- **看板访问权有登记表兜底**：项目索引按 leader 指针或会话 cwd 反查，重启后 worker 会话可能还没 materialize、cwd 取不到；`resolveBoardAccess` 在索引查不到时用 `sessionsByProject` + 项目列表补出项目，避免把已登记的 worker 显示成「不属于任何项目」。
- **切换不闪**：看板 tab 注册 `keepMounted`，已访问的 body 跟着会话保留；不可见时暂停卡片轮询，切回来立刻刷一次。标签栏补开看板时把 `projectId` 放进 navigation params，新 body 先用同一项目的内存快照起步（首帧直接画卡），再 revalidate。补开动作先放在 layout effect，失败再由 effect 兜底，尽量赶在 paint 前把 worker 的右栏从默认 guide 切到看板；目标右栏已经有看板 tab 时只切焦点，不再 `openTab`——`openTab` 对已存在的页走 reveal，宿主会让 pane 闪一下高亮，切一次闪一次。新 worker 第一次打开右栏仍可能有宿主自己的面板展开动画（不是数据骨架），第二次起复用保留的视图。
- **挂载**：在 `shell.overlay` 注册不占布局的锚，effect 里把宿主节点插到 `[data-slot="main"]` 父列的第一个子节点，portal 渲染标签栏；栏可见时才给主面板与会话体加 flex 收缩标记，栏隐藏即摘掉，普通会话不受影响。主槽定位与这部分标记参考 `dsh-session-tabs` 0.1.6（MIT），未复制其产物。宿主换掉主面板时用 `MutationObserver` 插回；找不到主槽只隐藏标签栏，不影响会话。
- **不 retain 后台会话**：标签只是 `openSession` 的快捷方式，保留策略仍归宿主。看板、设置这类全局面板打开时标签栏让位。
- **许可与测试基线**：新增脚本生成 `THIRD_PARTY_LICENSE`（内联的 minidenticons、参考实现、构建/测试工具分节，参考实现的 MIT 全文随仓库保存），`npm run check` 校验不过期。e2e 夹具把 profile 钉死为 `web`：`dsh web` 不读 `DSH_PROFILE` 而派生路径会读，在 agent shell 里照抄 `desktop` 会让插件静默不挂。

## Alternatives considered

- **直接依赖 dsh-session-tabs**：它是全量会话标签，没有项目作用域与 leader 入口，样式也不贴当前侧栏；只参考主面板锚定、当前会话判定与持久化的部分做法。
- **等宿主原生多标签**：宿主只有会话内视图 tab，没有按会话开标签的能力。
- **挂 `sidebar.footer.action`**：标签栏属于主区域，侧栏收起/窄栏时布局不同；用浮层锚 + portal 到主面板。
- **写进 `projects.json`**：浏览器状态写宿主数据文件要新协议与并发处理，还会污染项目真源；localStorage 足够。
- **当前 worker 强制出现在标签里**：关当前标签会被补记逻辑同帧加回；改为当前会话变化时补记、关标签先切 leader。
- **标签拖拽重排 / 后台 retain**：拖拽要另做排序持久化与指针操作（方向键已能做顺序切换）；retain 会把标签栏变成第二套会话视图，改变宿主保留计数。两者都不做。
- **把右栏钉在 leader**：宿主右栏的布局与 tab 都按会话存在各自的 store 里，公开面没有跨会话 pin；能做的只是把同一个看板 tab 开进目标会话的右栏。
- **只 keepMounted 不缓存**：第一次切到新 worker 仍会先闪一次骨架；**只缓存不保留 body**：每次切回都会重挂并重新拉项目与卡片。两者一起用才覆盖首次与往返两种切换。

## Consequences

- 标签集合在浏览器 localStorage，不随 `$DSH_HOME` 迁移；换浏览器或清缓存后 worker 标签要重新点开，项目标签始终在，会话与历史不受影响。
- 依赖宿主 `[data-slot="main"]` 与主面板结构；宿主改布局时标签栏可能不显示或落位错误，见[已知限制](../../../../docs/limitations.md#客户端与宿主耦合)。flex 标记是 DOM 补丁，不是宿主契约。
- 同一时刻只显示当前项目的标签栏，不支持跨项目混排；顺序固定为项目树顺序，没有拖拽；worker 标题相同时标签文字也会相同。状态灯只有三档。
- worker 的看板是它自己右栏里的一次拷贝（同一项目卡片），滚动位置与详情浮层不跟 leader 共享；只在 leader 已开看板时跟随。
- 已访问的看板 body 会保留在内存（宿主 `keepMounted`）：隐藏时卡片轮询、30 秒项目复核、60 秒时钟与 `focus` 监听全停，portal 到 `document.body` 的详情/确认浮层立即卸载；仍在的只有宿主的 `tabInfo`/会话状态订阅和一份按项目的内存快照。浏览器刷新后快照清空，第一次打开仍走一次加载。
- 收益：项目内切 leader 与 worker 不用回左栏找行；关标签不动会话，误关只是再点一次；普通会话完全不受影响。

## Testing

- 纯逻辑由 `tests/session-tabs-logic.test.js` 钉住（解析容错、增删上限、归属与标签顺序、关闭回退）；组件归 `tests/e2e/session-tabs.e2e.js`，在真实宿主里验证项目标签、点 worker 出标签、状态灯、关标签后会话行仍在、重开回来、普通会话整条栏消失；右栏打开 leader 看板后切 worker，断言看板空态仍是项目看板（不是「不属于任何项目」）。
- 看板访问权的登记表兜底由 `tests/project-board-data.test.js` 覆盖（索引查不到、退役 leader、登记表无此会话、项目列表读不到）。
- 切换前挂 `MutationObserver`，e2e 断言第一次切 worker、切回 leader、重开 worker 都没有重新插入 `.dsh-leader-agent-board-skeleton`；同一场景还覆盖方向键/Home/End 切换、右栏收起时不跟随、隐藏时浮层随会话切换卸载，以及普通会话不残留 flex 标记。浮层那条用程序化 click 走「切会话」状态路径：真实交互被遮罩挡指针，`session.new` 快捷键又被宿主的 `aria-modal` modal 规则挡下，触发路径本身不可达（见[已知限制](../../../../docs/limitations.md#客户端与宿主耦合)）。
- 手动双向验证：往 `THIRD_PARTY_LICENSE` 追加一行后 `npm run licenses:check` 失败，重新生成后通过；标签 e2e 在带 `DSH_PROFILE=desktop` 的 shell 里跑通，证明夹具的 profile 钉死有效。
- `npm run check`、`npm run build:client`、`npm run e2e` 全绿；具体读数见 PR。
