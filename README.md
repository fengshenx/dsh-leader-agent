# dsh-leader-kit

DeepSeek Harness（dsh）的协调者/执行者编排 bundle：一个会话当协调者派活，多个后台 worker 并行干活并自动回报，任务事实落进按项目组织的交付看板。

适合长任务、多任务并行的开发场景：协调者只做拆解、派工与验收，具体实现交给常驻的后台 worker。

## 功能

- **后台派工，完成自动唤醒**：`spawn_worker` 只建会话并立即返回，`message_worker` 投递第一条消息后 worker 才开工；那一轮结束时协调者自动收到一条回报（会话里渲染成 worker 的发言气泡），不需要 worker 调工具交作业，也不需要协调者轮询。
- **常驻 worker**：worker 是普通根会话，能同时跑多个；人可以直接打开它的会话接着聊，进程重启后能冷恢复，再用 `message_worker` 续派。
- **项目作为一等实体**：左栏「项目」区块选目录即建项目，并绑定一个协调者会话；项目树列出该项目派出的 worker，会话可归档、可换新协调者。
- **项目级提示词**：项目目录里的 `COORDINATOR.md`（协调者手册）与 `SLOTS.md`（角色槽位）在每次模型请求前求值，正文变化才追加，改文件即改行为，不需要重新建会话。
- **任务看板**：`create_card` / `update_card` / `list_cards` 记录任务事实；右栏看板按项目聚合协调者与 worker 建的卡，带槽位信号灯与详情浮层（链接可直接编辑）；卡片说明与 worker 回报正文按 Markdown 渲染（旧回报没有 Markdown 结构时走纯文本：无 `report` 的回退整条正文，早期多块靠单个换行拼接；失败原因同样保留换行）。
- **协议层 skill**：`leader-mode` 覆盖派工、接力、事件调度、卡片维护、验收裁决；`init-project` 把仓库工程约定写进目标项目的 `AGENTS.md` 受管区块。
- **工具面按角色裁剪**：协调者、worker、普通会话各拿各的工具，不是靠提示词约束模型。

## 前提：先跑通多 worktree 并发

**特别提醒**：这套架构的玩法，前提是把「多 worktree 并发」跑通——每个任务一个 worktree、一个独立 dsh 实例、一份独立数据根，任务之间互不覆盖插件版本、不抢会话与数据。没有这一层，协调者派出去的活会在同一个 checkout 上互相踩，看板上的项目也只是一堆共享工作区的会话，编排价值基本为零。本仓的 `scripts/worktree-*.mjs` 与 `scripts/dev.mjs` 就是为这件事准备的（见[开发](#开发)）。

建议直接去**蒸馏 DeepSeek Harness 团队的工程实践**，本 bundle 与它们是同一套思路：

- **worktree 并发**：任务隔离在独立 checkout 里，开发实例的数据根也隔离，合并前不动主干。
- **Agent Note 机制**：非平凡改动同 PR 携带决策笔记，只记永久决策与边界，不写流水账；结构交给机械门禁。
- **AGENTS.md 渐进式披露**：根文件只放每个任务都适用的规则与「按任务查阅」入口，细节进归属文档，避免一次上下文塞进整仓规则。
- **文档防腐化**：能机械判的交给 `npm run check`，行为变更在同 PR 同步文档，临时证据不入库。

本仓已按这四条落地，机制与各自的落点见[架构文档的协作与文档机制](docs/architecture.md#协作与文档机制)。

如果把本 bundle 用到自己的项目里，也建议先把这四条搬进那个项目——编排协议能不能长期跑住，取决于项目自己的文档与隔离机制，而不是取决于协调者提示词写得多细。

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

装好后用 `dsh web` 起日常实例。在本仓库里可以直接 `npm start`：它先 `npm run build:client` 再起 `dsh web`，起之前检查 dsh 是否可用、日常 profile 是否装了本插件——`lib/client.js` 不入库，漏了构建时实例照常起来、右栏却没有看板。

`engines.dsh` 声明了支持的 dsh 版本范围（当前 `>=0.2.1-rc.2 <0.3.0`）；不满足时安装与启动会被拒绝。dsh 处于 developer preview，版本范围需随 dsh 跟进。

## 基本使用

1. **加载协议层**：`skill` 工具会列出 `leader-mode`。协调者会话先读 `playbooks/program.md`，再按阶段读对应 playbook。
2. **建项目**：左栏「项目」区块点「加项目」选一个目录，项目当场建好并绑定一个协调者会话；点项目行打开协调者会话，拖项目行调整排列顺序，当前会话属于该项目（协调者或它派出的 worker）时该行亮着选中底色（注册的工作区被删过的话会顺手重建并归位会话）。删除项目会连插件注册的工作区一起移除，文件夹与会话记录保留。
3. **初始化项目工程约定**：让模型加载 `init-project` skill，用宿主的文件能力把正文并入目标项目 `AGENTS.md` 的受管区块。dsh 把 `AGENTS.md` 读成系统提示段落，写入即生效；重复执行只替换受管区块。
4. **派工**：调用 `spawn_worker`，`name`（角色-任务短名）必填，可带 `cardId` + `slot` 一次把卡槽位绑好；工具立即返回会话 id，此时 worker 还没开工。再用 `message_worker` 投递任务正文（`sessionId` + `message`，可顺手 `rename`），第一条消息即开工；worker 那一轮结束时协调者自动收到回报。消息里不必抄 spec——挂卡 worker 的请求会自动带上卡片事实。
5. **记任务事实**：`create_card` 建卡（`title` 必填），`update_card` 改卡（改内容带 `expectedRevision` 做乐观并发），`list_cards` 查卡。卡片按项目归属、编号全局递增；跨项目改卡会被拒绝。`list_cards` 只给协调者；`create_card` / `update_card` 协调者与 worker 都有，普通会话一件也没有——不在项目编排里就没有卡可写。
6. **看看板**：右栏「看板」Tab，按当前会话所属项目拉卡片。协调者建卡后自动打开；点卡面看详情（链接可编辑），点槽位 chip 打开执行者会话。
7. **写项目级提示词**：项目目录放 `COORDINATOR.md` 写这个项目怎么指挥；放 `SLOTS.md` 按 `## <槽位名>` 定义角色，再用卡片的 `slots` 字段绑到会话。两者都只贡献提示词，不授予工具权限，改动下一轮生效。

建项目、项目树、归档、看板信号灯、槽位 frontmatter 等完整交互见[使用手册](docs/usage.md)；实现与取舍见[架构文档](docs/architecture.md)。

## 当前限制

- **后台编排只适用于长驻组合**（web / desktop / sdk）。headless 是一次性 CLI，会话在 turn 结束后即销毁，没有载体接收完成通知。
- **协调者不能中止 worker**：worker 是普通根会话，宿主的 `list_agents` / `send_message` / `interrupt_agent` 对它无效（`interrupt_agent` 会返回假成功）。worker 卡住或跑偏只能请人去那个会话处理——这是常驻化换来的代价。
- **完成回报依赖轮次正常结束**：进程在 worker 跑完前被杀，那一轮不结算，协调者收不到通知；重启后可以自己打开 worker 会话看或续聊。
- **看板只对项目会话展示**：协调者与该项目的 worker 能看到；同目录的普通会话与已换下的协调者只看到提示。不属于任何项目的会话也没有看板。
- **卡片详情只写链接**：链接可在详情里增删改，其余操作（完成、置顶、重命名、删除）仍归协调者的卡片工具。卡片编号全局递增，跨项目不复用、不回收。
- **项目注册表只经左栏区块操作**：模型没有项目工具；目录选择器不可用时无法建项目，需换 web profile。
- **项目树与官方工作区树并存**：项目会话从官方树里的隐藏是渲染层排除，官方计数与搜索仍包含它们；项目目录本身也作为一行工作区显示在官方树里，两处都能进。
- **客户端与宿主版本耦合**：弹窗、菜单、图标复制自宿主源码，Typert 远程通道是手写协议形状，协调者会话形态依赖宿主的会话视图服务——宿主升级时要同步本仓。

完整的限制清单与取舍（含信号灯数据源、水位折叠、头像、归档入口、DOM 注入取位等）见[架构文档的已知限制](docs/architecture.md#已知限制与取舍)。

## 开发

```sh
npm run worktree:spawn <任务名>   # 建 .worktrees/<任务名> + feature/<任务名>
cd .worktrees/<任务名>
npm run dev                       # 起挂当前工作树插件版本的 dsh 实例
npm start                         # 起日常实例（~/.dsh 的数据与 profile）
npm run check                     # Agent Note 门禁 + 文档工具名门禁 + 语法检查 + 全部单测
```

其余命令（`build:client` / `worktree:prune` 等）见 [AGENTS.md 的常用命令](AGENTS.md#常用命令)。

`npm run dev` 的数据根在工作树内的 `.dev/home`，删掉即重置，不碰日常 `~/.dsh`；几个工作树可以同时跑，插件版本与数据互不干扰。启动前会把 `~/.dsh/.credentials.yaml` 里的 `refs`（按环境变量名存的 API key）并进开发实例的凭据文件，新工作树第一次起实例不用再填一遍；只搬 refs，账号授权记录不搬。客户端产物由常驻 watch 重建，宿主 `client-hmr` 把运行中的插件换掉——改 `src/client/` 不用刷新页面（插件内的 React 状态会重置，数据层保留）；宿主侧代码重启实例即可。

`npm start` 起的是日常那套：数据根 `~/.dsh`，插件取日常 profile 里链接的版本，起之前先 `npm run build:client`。它会逐项检查并给出可复制的修复命令：dsh 不可用（没装或不在 PATH，`DSH_DSH` 可指定路径）、日常 profile 不存在、profile 的 bundles 缺 web-app 或缺本插件、`node_modules/dsh-leader-kit` 链接缺失。它没有 `npm run dev` 的隔离——在 worktree 里跑，加载的仍是链接指向的那份代码（通常是主 checkout），脚本会提示，验证本目录改动请用 `npm run dev`。

开发实例的覆盖项、worktree 清理守卫、取证流程与构建约束见[架构文档的开发一节](docs/architecture.md#开发)与 [docs/e2e-testing.md](docs/e2e-testing.md)。

## 致谢

本方案在设计时参考过 **Cursor 的 Project 实现**与 **PStack 的编排机制**：把项目当成一等实体、按项目聚合会话与交付物，以及「协调者派工 / 执行者回报 / 交付看板」这条主线。感谢两边的实践提供了对照。

也感谢 **DeepSeek Harness 团队**：宿主的插件契约，以及 worktree 并发、Agent Note、AGENTS.md 渐进式披露、文档防腐化这套工程实践，是本仓直接对照的来源。

## 文档

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 仓库铁律与按任务查阅入口 |
| [docs/usage.md](docs/usage.md) | 派工、续聊、卡片、看板、项目管理、槽位与手册的完整交互 |
| [docs/architecture.md](docs/architecture.md) | 分层、模块表、运行时模型、数据流、持久化布局、完整已知限制 |
| [docs/capability-gaps.md](docs/capability-gaps.md) | 宿主能力边界的实测依据（改宿主侧前先读） |
| [docs/e2e-testing.md](docs/e2e-testing.md) | 浏览器侧取证的执行规范 |
| [.agents/notes/](.agents/notes/) | 非平凡改动的决策记忆 |
| [.agents/skills/leader-mode/](.agents/skills/leader-mode/) | 协议层：派工、接力、事件调度、卡片维护、验收裁决 |
