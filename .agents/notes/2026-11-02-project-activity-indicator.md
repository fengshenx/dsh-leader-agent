# 项目行收起时的运行中指示

**状态**：implemented（2026-11-02）
**范围**：`src/client/project-panel-logic.js`、`src/client/project-section.js`、`tests/project-panel.test.js`、`docs/architecture.md`、`docs/capability-gaps.md`

## 背景

项目行收起时，用户看不出这个目录里有没有会话在跑：会话行有 spinner（`dsh-leader-kit-session-spinner`），但它只在展开后才出现，收起状态等于失明。

展开时反过来不需要会话级的重复指示：每条会话行自己就带着 spinner，再在目录行画一个就是把同一件事画两遍。

#74（协调者运行态）合入后，行首槽位多了一半来源：协调者在项目树下不单独出行，它跑起来时行首是唯一提示。产品口径是**并集**——本组任一会话在跑，或协调者自己在跑，行首就亮；两半原先各写了一套判据与一个 spinner 类，本 PR 把它们合成一个入口。

## 决策

**判定收敛成一个纯函数 `showsProjectActivity({ expanded, rows, coordinatorRunning })`**，两个来源在这里合成，渲染侧只有一个 `leadActivity` 与一个 spinner 类：

- 协调者没有自己的行，任何展开状态下它跑起来都只能靠行首，所以 `coordinatorRunning === true` 直接返回 `true`；
- 其它会话只在收起时算（`expanded === true` 直接返回 `false`）：展开后每条会话行自己带 spinner，行首再亮就是同一件事画两遍。

**入参 `rows` 就是 `ProjectRow` 要渲染的那批会话行**（`selectProjectSessionRows()` 的结果），不为目录行另判一遍身份与归属。这样「目录行有加载圈」与「至少一条会话行有 spinner」严格同源，不会出现两边口径分叉：

- 已归档会话在 `selectProjectSessionRows()` 里就被滤掉（宿主会话索引按磁盘目录扫，归档后记录仍在索引里，不滤会复活）；
- 快照里还没有的会话没有行可渲染，也就不会被当成在跑；
- 当前协调者不在会话行里（它的入口是项目行本身），会话行这一半看不到它——它由 `isCoordinatorRunning()` 单独提供；退役协调者留在会话行里，跟着行走；
- 换协调者留下的退役 id 不需要再单独排除——它们本来就不在渲染出来的行里时就不会被读到。

**两个来源对归档的口径统一**：会话行那一半在 `selectProjectSessionRows()` 里滤掉归档会话，协调者那一半在 `isCoordinatorRunning()` 里自己查 `archivedSessionIds`（与 `isCoordinatorCurrent()` / `isProjectCurrent()` 同一条口径）。不统一的话，归档的协调者会让行首一直转。

**展开态不额外兜底，边界是 `requiredWatermark` 的前 50 条**：运行中的会话会把水位抬到自己所在位置（`session-watermark.js` 的 `requiredWatermark`），但只在前 50 条内生效。这个范围内展开后可见，不会出现「收起时目录行有加载器、展开之后连会话行也看不见」的失明窗口；第 51 条及以后在跑的会话不抬水位，展开后仍可能被折起，要再点「展开其余」——那是会话列表本身超出一页时的既有折叠口径（与宿主一致），不为它扩大边界。

**渲染上是替换行首槽位里的目录图标，不是加第二个指示**。槽位尺寸不变（16×20），spinner 取 12px，复用同一份 `dsh-leader-kit-spin` 关键帧；只有一个类（`.dsh-leader-kit-project-spinner`）与一条样式规则，画在 `lead-folder` 槽位**内部**而不是替换容器——组内有当前会话时的激活色挂在容器的 `color` 上，容器被顶掉就丢了同一处承载。边框用 `currentColor`（与目录图标的 `stroke: currentColor` 同源），不写死 `label-tertiary`。悬停规则挂在槽位容器上，箭头照常盖住 spinner——运行中也要能展开查看是哪条会话在跑。spinner 是装饰（`aria-hidden`），状态语义不塞进按钮的无障碍名：项目行的入口含义仍是「打开协调者」。

**第二项需求（原生目录选择器初始灰态）在 bundle 侧修不了，只记证据**。面板由宿主 `osascript` 进程弹出，激活时机写在那支 JXA 脚本里；`0.2.1-rc.2`～`rc.5` 都在 `runModal` 之前同步激活，modal 循环未启动时激活落空，于是面板灰着、必须先点浏览器窗口。宿主提交 `7333a38c7a`（Fixes #7320）改成把激活排进 modal 事件循环，只进了 `0.2.2-alpha.2` 及之后。本仓能做的只有记录（`docs/capability-gaps.md` 第 42 条）并提示升级宿主；自己重造一条目录选择路径不可行——浏览器拿不到绝对路径。

## 边界

- 只覆盖「运行中」，不覆盖「等你输入」：宿主当前没有发布待处理交互的数据源（`docs/capability-gaps.md` 第 35 条）。
- 展开态行首只代表协调者：worker 在跑时不亮，由它自己的会话行带 spinner。两态下行首的语义不同（收起是「本组有活动」、展开是「协调者在跑」），这是信息展开时的正常过渡，不是两套判据。
- 合成后不留第二个渲染入口：`data-running` 属性与 `lead-spinner` 类删掉，观测量统一看行首有没有 `.dsh-leader-kit-project-spinner`。
- 悬停整行时行首槽位换成展开箭头、加载器随之隐藏：沿用官方工作区行的悬停规则，运行中也要能点开。
- 不动官方工作区行的图标：项目会话的排除只在渲染层，官方那一行的激活态另由 `quietWorkspaceOf` 处理。
- 项目区块标题行（「项目」小标题）不显示任何项目级状态：它是整个列表的折叠开关，不代表某个目录。
- 宿主升级到 `0.2.2-alpha.2` 后本仓的 API 面仍按下限 `0.2.1-rc.2` 写，不跟着用新版本才有的方法。

## 验证

- `npm run check`：851 tests / 842 pass / 9 skipped / 0 fail（合入 main `b37ed4d` 后读数）。项目面板 51 例，覆盖：收起态任一会话在跑、合成判定矩阵（收起/展开 × 会话行/协调者 × 在跑/空闲共 8 组）、展开态 worker 在跑不亮而协调者在跑亮、目录行与渲染出来的会话行同源（归档会话与当前协调者不算）、协调者运行态含归档口径。
- 双向验证（单测，逐个撤销分支）：
  - 删掉 `if (coordinatorRunning === true) return true` → 2 例红（`合成判定`、`展开后 worker 在跑不点亮行首`），49 pass / 2 fail；还原 → 51 pass。
  - 删掉 `if (expanded === true) return false` → 同样 2 例红，49 pass / 2 fail；还原 → 51 pass。
  - 删掉 `isCoordinatorRunning()` 里的归档过滤 → 1 例红（`协调者在运行时项目行显示运行态`），50 pass / 1 fail；还原 → 51 pass。
  - 矩阵用例带「展开 + 只有 worker 在跑 → `false`」与「展开 + 协调者在跑 → `true`」两组对照，否则删掉任一分支也可能被单条断言漏过。
- 渲染路径：仓里没有 jsdom，渲染这一半落在源码接线断言与产物读数上——`ProjectRow` 的 `leadActivity` 由 `showsProjectActivity({ expanded, rows: childSessions, coordinatorRunning: isCoordinatorRunning(project, sessionRows, archivedSessionIds) })` 给出，spinner 画在 `lead-folder` 内部、带 `aria-hidden`，全文件只有一个 `.dsh-leader-kit-project-spinner` 类定义，`lead-spinner` / `data-running` 已无残留。
- 产物读数：`npm run build:client` 重建后 `lib/client.js` 里 `dsh-leader-kit-project-spinner` 2 处命中（样式选择器 + 组件类名），`lead-spinner` 与 `data-running` 0 处。
- 计算样式读数（从 `lib/client.js` 抽取真实规则，无头 Chrome 读 `getComputedStyle`）：激活态容器 `color` 与 spinner `border-left-color` 同为 `rgb(65, 118, 230)`（与目录图标的 `stroke: currentColor` 一致），非激活 `rgb(120, 130, 150)`；`12px × 12px`、`animation: dsh-leader-kit-spin / 0.8s`、`border-top-color` 透明（旋转缺口）、`aria-hidden=true`、父元素是 `lead-folder`。
- 未做「worker 真在跑」的端到端：那需要真实模型或本地 mock provider，本轮以「判定用单测、渲染用上面的产物与计算样式读数」两段拼出结论；合入后第一次真实派工时再看一眼收起态即可。
