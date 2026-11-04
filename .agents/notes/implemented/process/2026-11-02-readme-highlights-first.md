# README 改成亮点优先：英文默认、中文对照与顶栏视觉层

**范围**：`README.md`、`README_ZH.md`、`docs/assets/readme/logo-{en,zh}{,-dark}.svg`、`AGENTS.md`、`docs/architecture.md`、`package.json`（`files` 加中文版）

## 背景

README 在 2026-11-02 做过一次瘦身（见 [README 只留用法](2026-11-02-readme-slim-and-architecture-doc.md)），从 213 行压到 113 行，把架构与交互细节下沉到 `docs/architecture.md` 和 `docs/usage.md`。瘦身解决了「机制细节压在入门口」，没解决另一件事：**第一屏读不到这套东西能帮我干什么**。

具体是四个问题：

- 开头是定义句（「协调者/执行者编排 bundle」），第二段才提场景，第三段就掉进实现细节（`spawn_worker` 立即返回、气泡渲染、JSONL 冷恢复）；
- `## 前提：先跑通多 worktree 并发` 挡在第二屏，自带「编排价值基本为零」的判词，把内部工程约束放在价值之前；
- 「功能」七条里五条以工具名或内部术语开头，用户视角的收益被埋在定义句里；
- 最强的三个能力——多项目并行、`COORDINATOR.md` / `SLOTS.md` 的拆分、`leader-mode`——各只占一行，没有展开成卖点。

对照 dsh-TUI 的 README 形态（logo、徽章、一句话 tagline、亮点列表、预览、快速开始），本仓的入口文档缺的是叙事顺序与视觉层，不是内容。

## 决策

**叙事顺序改为：价值 → 机制 → 上手 → 编排 → 前提与限制**。tagline 与「亮点」在前，`## 它是怎么跑起来的` 用一张流程图加三条机制差异（身份裁剪工具面、完成由机制结算并自动唤醒、worker 是常驻根会话）回答「为什么不是一个更聪明的 prompt」，快速开始与编排约定在后。

**亮点固定为五条**，按用户口径写死顺序与含义：一个 Leader 推进开发与 Review、右栏 SidePanel 看板、Agent 自由编排（`COORDINATOR.md` / `SLOTS.md`）、多项目并行、`leader-mode` skill。规模口径用「一次并行开发 10 个 feature」，不写具体 agent 数量——没有实测吞吐读数，写死数字会在别人机器上立刻过期。

**顶栏加视觉层**：

- logo 手写矢量 SVG，深浅两版，`<picture>` + `prefers-color-scheme` 切换。图形是 Leader 节点扇出到三个 worker（中间那个亮着表示执行中）加一块看板，无外链、无位图依赖。内容区按实际尺寸收窄到 470×104，README 用 `width="560"` 放大显示，避免右侧留一大截空白。
- 徽章只写**真实成立**的状态：MIT（`LICENSE` 存在）、`dsh >=0.2.1-rc.2`（`engines.dsh` 下限）、`developer preview`（dsh 现状）。不写 npm 版本与下载量（未发布）、不写 CI（没有 workflow，写了就是假状态）、不写收录与榜单（没有记录）。这些图是 shields.io 静态徽章，不依赖仓库状态。

**语言：`README.md` 英文（默认），`README_ZH.md` 中文**，两版顶部互相切换。默认英文是因为仓库面向 dsh 的插件生态，英文是 GitHub 与 npm 的默认阅读语言；中文版不是翻译附录，而是与英文版同级的正文——两边都在顶栏放 logo 与切换入口，不写「本文是译文」。logo 分四份（`logo-en` / `logo-en-dark` / `logo-zh` / `logo-zh-dark`），因为副标题跟着语言走：英文 `One Leader, ten features in parallel`，中文「一个 Leader 带你并行推进开发与 Review」。

双语带来一个真实成本：两份正文会漂移。当前用三条约束压住——两版章节顺序与锚点一一对应（英文 `#current-limitations` / `#development`，中文 `#当前限制` / `#开发`）；行为变更时两版同 PR 一起改；任何一版新增内容都要在另一版落同一位置。没有机械门禁比对，这是本轮明确接受的成本，比「只有英文、中文读者读不到」或「只有中文、外部读者读不到」都更符合现状。

**`<picture>` 深浅色切换的已知边界**：GitHub 官方支持该写法，但社区记录（discussion #210469）表明新仓库 UI 里 `<source media>` 不再被重写，切换跟随 **OS** 主题而非 GitHub 手动主题——OS 深色 + GitHub 手动浅色时会显示深色 logo。fallback `<img>` 保持浅色版，这条只影响两版 logo 的配色，不影响可读性，不值得为此换写法。

**预览图：`docs/assets/readme/board.png`，入库，架在 `## 亮点` / `## Highlights` 之后**。上一版判断「不放预览图」是因为当时没有真机截图、又不用示意图形冒充；后来把图做出来了，条件变了，结论跟着改。

**最终用的是真实工作会话的截图**（1385×850，142 KB）：三栏布局与产品一致，中栏是一次真实的派工与审查往返，右栏是真卡。README 的说明随之写成「真实工作中场景的截图」/ "a real working session"——图是真的，就不写 mock，也不写「没有真实模型调用」。

**真实截图的边界**：图里带出本仓自己的 PR 编号、worker 名与工作细节，没有凭据、令牌、第三方内容或用户数据。用本仓自己的工作画面做 README 素材可以接受；换成别的项目要先脱敏。图内还可见本机工作区目录名（`dsh-leader-agent` / `deepseek-harness` / `Test`）——`deepseek-harness` 在 GitHub 无同名公开仓库，是本地目录而非仓库地址；仍属「本仓工作画面」范围，换图时一并核。

**第一版是 mock 数据截图，工具不入库**（保留记录，供没有真实画面时复现）：

- 隔离实例：`DSH_HOME` 指到工作树内的 `.dev/home`，不碰日常 `~/.dsh`；
- 本地 mock provider：`/tmp/dsh-mock`，按消息内容返回固定文本与 `create_card` / `spawn_worker` 工具调用，鸭子类型实现 `providerInfo` / `listModels` / `resolveModel` / `prepareCall` / `stream`，全程零真实 API 调用；
- seed 数据：3 个项目、8 张卡、6 个 worker 会话；
- Playwright 驱动系统 Chrome headless，viewport 1440×900、`deviceScaleFactor: 1.5`；
- 操作路径：点项目 → 选 mock 模型 → 发一句派工指令 → 等工具调用与 worker 回报 → 展开项目树 → 打开右栏看板 → 拖右栏到目标宽度 → 截图。

**右栏宽度不是产品默认值**：默认是视口 45%；截图里右栏收窄到约 310，是为了让中栏正文与右栏看板同时可读，拖拽宽度也不跨页面持久化。

**mock provider、seed 脚本与第一版截图都不入库**，仓库只留成品 PNG —— 它属于文档资产，与「PR 证据截图不入库」不是一类：前者是长期维护的 README 素材，后者是一次性取证记录。

**保留上一篇 note 的职责边界**：机制论证仍在 `docs/architecture.md`，完整交互仍在 `docs/usage.md`，README 只给最短路径与指针。「前提：先跑通多 worktree 并发」一节保留但后置，内容从三段压到两段，四项工程实践与落点指针不变。


**限制清单保持八条但每条压到一行**，事实与判据不变，完整清单与取舍仍只指向 `docs/architecture.md#已知限制与取舍`。

### 合并 main：按叙事层级吸收新事实，不取分支版

分支 base 是 #50，审查时 main 已到 #70，`README.md` 与 `AGENTS.md` 冲突。合并用**合并提交**（不 rebase、不 force-push），解冲突的原则是：**章节骨架取分支版，main 侧的功能事实按新叙事层级吸收**。把冲突解成「取分支版」会静默丢掉 #50 之后引入的能力，因此逐条对照了 main 的 README 与 `docs/architecture.md`：

- **#60 派工两段化**：`spawn_worker` 只建会话并立即返回、**不开工**，开工由 `message_worker` 的第一条消息触发；`cardId` + `slot` 在返回前完成绑定，挂卡 worker 的首轮请求就带着角色槽位与卡片事实。流程图与「五步上手」第 3 步按这个顺序重写。
- **#70 权限继承**：worker 的沙箱模式与审批策略在派工那一刻从 Leader 继承，回执写明实际权限、完全权限被点名。
- **#53 卡片链接编辑**：限制节与看板描述从「卡片详情只读」改为「只写链接」——链接在浮层里可增删改，其余字段仍只读。
- **#52 Markdown 渲染**：卡片说明与 worker 回报气泡都按 Markdown 渲染，写进亮点与看板描述。
- **#50 项目行操作**：项目行可拖拽排序、当前项目亮选中底色、删除项目连带摘掉插件注册的工作区（文件夹与会话记录保留）。
- **#54/#56、#58**：客户端由常驻 watch 重建 + `client-hmr` 热替换；`npm run dev` 把日常 `refs` 并进开发实例凭据。
- **`spawn_worker` 参数按 schema 如实写**：`required: ['name']`，`cardId` + `slot` 可选（`src/host/tools/spawn-worker.js`）。旧文写的 `initialMessage` 全仓不存在，是 #60 之前的说法。
- **协议层 skill 路径**：两版文档表改 `.agents/skills/leader-mode/`——#62 已把 skill 搬进 `.agents/skills/`，合并树里没有 `skills/`，旧链接必 404。

`AGENTS.md` 的冲突按同一原则解：中文 README 指针保留（分支侧，中文文档链中文版），worker/卡片两行的 Note 指针取 main 侧（追加 `2026-11-02-spawn-then-message-and-card-context.md`）。

## 边界

- 纯文档改动加四份 SVG 资产：不改代码、不改运行时行为、不新增功能。`package.json` 只动 `files`（把中文版带进 npm 包），依赖与脚本不变。
- 引用同步：`AGENTS.md` 的「按任务查阅」与 `docs/architecture.md` 的两处 README 指针改指中文版——中文文档链中文版，锚点才不会跨语言失效。
- 不引入外部图片依赖：徽章是 shields.io 静态地址，logo 是仓内矢量文件，字体走系统字体栈。
- README 仍不承载机制论证：新增的「怎么跑起来」只有三条，细节一律落架构文档。
- 中文版与英文版的副标题、锚点、章节顺序保持对应；`.agents/notes/` 的历史笔记不改，旧笔记里的 `README.md#开发` 指针在本次迁移后失效，保留原样作为历史记录。
- **打包门禁不守中文版这条留给 #68**：`verify:pack` 与其 `ALWAYS_SHIPPED` 只存在于未合并的 #68，本 PR 不在它上面造依赖，也不照抄一份 gate；`README_ZH.md` 已确认进 `npm pack` 清单。
- **协议层 skill 不进每轮注入路径**：每轮请求前求值、正文变化才追加的是 `COORDINATOR.md`、`SLOTS.md` 与卡片事实（`docs/architecture.md` 的「项目级提示词与协议层」表）；`leader-mode` / `init-project` 由模型调 `skill` 工具按需加载，目标项目的 `AGENTS.md` 走宿主的 agent-instructions。README 的两版措辞按这条区分，不把 skill 写成「注入」。
- 合并带入的是 main 的代码与 `docs/`，本 PR 不重写这些文件的内容；README 只同步它们的结论。

## 验证

- `npm run check`（合并 main 后）：803 tests / 794 pass / 0 fail / 9 skipped；`verify-agent-note-format` 52 篇笔记格式合规；`verify-doc-tool-names` 11 篇文档的工具名全部存在。
- 相对链接与锚点全量核查（9 篇 md；GitHub slug 规则，跳过代码块与行内代码）：31 条链接/锚点、6 个图片引用，**0 broken**。两版章节各 11 节，顺序与行号一一对应。
- 合并是否丢内容（对抗探针）：把 main README 的事实点拆成 18 项（两段化、绑卡、卡片事实、权限继承、回执点名、链接编辑、Markdown、拖拽、删除项目、选中底色、每轮求值、全局编号、工作区行两处可达、会话视图耦合、凭据 refs、client-hmr、npm 包名等）逐项在中英两版里检索，18/18 命中、0 缺失。
- 截图核对：成品图是真实工作会话截图，核过三栏布局与卡片渲染；第一版 mock 截图（2160×1350）的右栏拖拽读数为 `648 → 400`。
- logo 渲染核对：`qlmanage -t` 转 PNG 目视两版。浅色版文字 `#16223a`、深色版 `#eef3fb`，各自在对应主题下可读；收窄画布后内容居中。
- 规模读数：README 119 → 187 行（新增顶栏、预览、亮点、设计取舍与编排，合并 main 后重写派工与开发细节）；`README_ZH.md` 187 行。
