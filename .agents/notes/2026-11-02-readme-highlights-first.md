# README 改成亮点优先：英文默认、中文对照与顶栏视觉层

**状态**：implemented（2026-11-02）
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

**预览图：`docs/assets/readme/board.png`，入库，架在 `## 亮点` / `## Highlights` 之后**。上一版判断「不放预览图」是因为当时没有真机截图、又不用示意图形冒充；这一版把图做出来了，条件变了，结论跟着改。

取图方式（**可复现，但工具不入库**）：

- 隔离实例：`DSH_HOME` 指到工作树内的 `.dev/home`，不碰日常 `~/.dsh`；
- 本地 mock provider：`/tmp/dsh-mock`，按消息内容返回固定文本与 `create_card` / `spawn_worker` 工具调用，鸭子类型实现 `providerInfo` / `listModels` / `resolveModel` / `prepareCall` / `stream`，全程零真实 API 调用；
- seed 数据：3 个项目、8 张卡（其中 3 张在 leader-kit 看板上）、6 个 worker 会话；
- Playwright 驱动系统 Chrome headless，viewport 1440×900、`deviceScaleFactor: 1.5` → 2160×1350、约 190 KB；
- 操作路径：点项目 → 选 mock 模型 → 发一句派工指令 → 等工具调用与 worker 回报 → 展开项目树 → 打开右栏看板 → 把右栏从默认 648 拖到 400 → 截图。

**右栏 400 是排版取舍，不是产品默认值**：默认宽度是视口的 45%（1440 下即 648），图里收窄是为了让中栏会话与右栏看板同时可读。拖拽宽度不跨页面持久化，图里的比例只在截图脚本里成立。

**图里的文案全是造的**：项目名、卡片标题、worker 名与回报内容都是 seed 值，没有用户真实数据。mock provider、seed 脚本与原始截图都不入库，仓库只留成品 PNG —— 它属于文档资产，与「PR 证据截图不入库」不是一类：前者是长期维护的 README 素材，后者是一次性取证记录。

**保留上一篇 note 的职责边界**：机制论证仍在 `docs/architecture.md`，完整交互仍在 `docs/usage.md`，README 只给最短路径与指针。「前提：先跑通多 worktree 并发」一节保留但后置，内容从三段压到两段，四项工程实践与落点指针不变。

**保留上一篇 note 的职责边界**：机制论证仍在 `docs/architecture.md`，完整交互仍在 `docs/usage.md`，README 只给最短路径与指针。「前提：先跑通多 worktree 并发」一节保留但后置，内容从三段压到两段，四项工程实践与落点指针不变。

**限制清单保持八条但每条压到一行**，事实与判据不变，完整清单与取舍仍只指向 `docs/architecture.md#已知限制与取舍`。

## 边界

- 纯文档改动加四份 SVG 资产：不改代码、不改运行时行为、不新增功能。`package.json` 只动 `files`（把中文版带进 npm 包），依赖与脚本不变。
- 引用同步：`AGENTS.md` 的「按任务查阅」与 `docs/architecture.md` 的两处 README 指针改指中文版——中文文档链中文版，锚点才不会跨语言失效。
- 不引入外部图片依赖：徽章是 shields.io 静态地址，logo 是仓内矢量文件，字体走系统字体栈。
- README 仍不承载机制论证：新增的「怎么跑起来」只有三条，细节一律落架构文档。
- 中文版与英文版的副标题、锚点、章节顺序保持对应；`.agents/notes/` 的历史笔记不改，旧笔记里的 `README.md#开发` 指针在本次迁移后失效，保留原样作为历史记录。

## 验证

- `npm run check`：644 tests / 644 pass / 0 fail；`verify-agent-note-format` 43 篇笔记格式合规；`verify-doc-tool-names` 11 篇文档的工具名全部存在。
- 相对链接核查（非锚点逐个 `existsSync`）：无缺失，含新增的 `docs/assets/readme/board.png`（2160×1350，192 KB）；本文件锚点 `#当前限制`、`#开发` 命中实际标题，跨文档锚点 `architecture.md#协作与文档机制`、`#已知限制与取舍`、`#开发` 均在目标文件存在。
- 截图渲染核对：Playwright 截图后目视三栏布局；拖动右栏句柄的实测读数为 `648 → 400`，窗口宽度保持 1440。
- logo 渲染核对：`qlmanage -t` 转 PNG 目视两版。浅色版文字 `#16223a`、深色版 `#eef3fb`，各自在对应主题下可读；收窄画布后内容居中。
- 规模读数：README 119 → 177 行（新增顶栏、预览、亮点与编排四节，补上设计取舍，删掉冗长的安装说明与开发解释）；`README_ZH.md` 178 行。
