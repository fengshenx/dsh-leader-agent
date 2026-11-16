# Agent Note: 项目会话标签栏

Status: implemented

## Problem

宿主主区域一次只挂一条会话，没有原生多标签。项目树能把人送进 worker 会话，但进去之后想回 leader 或换另一个 worker，只能回左栏重新找行。需求是：项目会话有一条自己的标签栏，点开 worker 形成标签，普通会话没有栏，worker 标签带状态灯。

宿主不提供多标签能力，只能在主面板上补一层呈现，同时不能动宿主的会话本体与项目数据。

## Decision

- **只认项目会话**：当前会话是项目 `leaderSessionId` 或登记表里的 worker 才显示；同目录的普通会话、退役 leader、`leaderAlive === false` 的项目都隐藏。没有 live worker 的项目也不显示——只有 leader 时没有可切换对象。
- **第一条标签是项目名**（文件夹图标），点它打开 leader，不单列 Leader 标签。worker 标签只在点开过之后出现，顺序跟项目树的会话顺序，不跟点开先后。
- **关标签不关会话**：只从 localStorage 的打开集合里删一条 id，会话与历史仍在项目树里，再点一次行就记回来。关当前标签先切回 leader，避免补记逻辑在同一帧把它加回来。
- **按项目持久化**在 localStorage `dsh-leader-agent.session-tabs.v1`，不进 `$DSH_HOME`：标签是浏览器侧导航快捷方式，不是会话真源，不值得为它加写宿主数据的协议。
- **状态灯复用宿主 `StateDot` 三档**：运行中、完成未读、空闲，与项目树会话行同一口径。「等你输入」「失败」不在会话快照里，不另造判定。
- **挂载**：在 `shell.overlay` 注册不占布局的锚，effect 里把宿主节点插到 `[data-slot="main"]` 父列的第一个子节点，portal 渲染标签栏；主面板与会话体加 flex 收缩标记。主槽定位与这部分标记参考 `dsh-session-tabs` 0.1.6（MIT），未复制其产物。宿主换掉主面板时用 `MutationObserver` 插回；找不到主槽只隐藏标签栏，不影响会话。
- **不 retain 后台会话**：标签只是 `openSession` 的快捷方式，保留策略仍归宿主。看板、设置这类全局面板打开时标签栏让位。
- **许可与测试基线**：新增脚本生成 `THIRD_PARTY_LICENSE`（内联的 minidenticons、参考实现、构建/测试工具分节，参考实现的 MIT 全文随仓库保存），`npm run check` 校验不过期。e2e 夹具把 profile 钉死为 `web`：`dsh web` 不读 `DSH_PROFILE` 而派生路径会读，在 agent shell 里照抄 `desktop` 会让插件静默不挂。

## Alternatives considered

- **直接依赖 dsh-session-tabs**：它是全量会话标签，没有项目作用域与 leader 入口，样式也不贴当前侧栏；只参考主面板锚定、当前会话判定与持久化的部分做法。
- **等宿主原生多标签**：宿主只有会话内视图 tab，没有按会话开标签的能力。
- **挂 `sidebar.footer.action`**：标签栏属于主区域，侧栏收起/窄栏时布局不同；用浮层锚 + portal 到主面板。
- **写进 `projects.json`**：浏览器状态写宿主数据文件要新协议与并发处理，还会污染项目真源；localStorage 足够。
- **当前 worker 强制出现在标签里**：关当前标签会被补记逻辑同帧加回；改为当前会话变化时补记、关标签先切 leader。
- **标签拖拽重排 / 后台 retain**：拖拽要另做排序持久化与键盘可达性；retain 会把标签栏变成第二套会话视图，改变宿主保留计数。两者都不做。

## Consequences

- 标签集合在浏览器 localStorage，不随 `$DSH_HOME` 迁移；换浏览器或清缓存后 worker 标签要重新点开，项目标签始终在，会话与历史不受影响。
- 依赖宿主 `[data-slot="main"]` 与主面板结构；宿主改布局时标签栏可能不显示或落位错误，见[已知限制](../../../../docs/limitations.md#客户端与宿主耦合)。flex 标记是 DOM 补丁，不是宿主契约。
- 同一时刻只显示当前项目的标签栏，不支持跨项目混排；顺序固定为项目树顺序，没有拖拽；worker 标题相同时标签文字也会相同。状态灯只有三档。
- 收益：项目内切 leader 与 worker 不用回左栏找行；关标签不动会话，误关只是再点一次；普通会话完全不受影响。

## Testing

- 纯逻辑由 `tests/session-tabs-logic.test.js` 钉住（解析容错、增删上限、归属与标签顺序、关闭回退）；组件归 `tests/e2e/session-tabs.e2e.js`，在真实宿主里验证项目标签、点 worker 出标签、状态灯、关标签后会话行仍在、重开回来、普通会话整条栏消失。
- 手动双向验证：往 `THIRD_PARTY_LICENSE` 追加一行后 `npm run licenses:check` 失败，重新生成后通过；标签 e2e 在带 `DSH_PROFILE=desktop` 的 shell 里跑通，证明夹具的 profile 钉死有效。
- `npm run check`、`npm run build:client`、`npm run e2e` 全绿；具体读数见 PR。
