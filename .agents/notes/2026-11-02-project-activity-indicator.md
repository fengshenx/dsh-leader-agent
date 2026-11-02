# 项目行收起时的运行中指示

**状态**：implemented（2026-11-02）
**范围**：`src/client/project-panel-logic.js`、`src/client/project-section.js`、`tests/project-panel.test.js`、`docs/architecture.md`、`docs/capability-gaps.md`

## 背景

项目行收起时，用户看不出这个目录里有没有会话在跑：会话行有 spinner（`dsh-leader-kit-session-spinner`），但它只在展开后才出现，收起状态等于失明。

展开时反过来不需要目录级指示：每条会话行自己就带着 spinner，再在目录行画一个就是把同一件事画两遍。

## 决策

**判定收敛成一个纯函数 `showsProjectActivity({ expanded, rows })`，且只判收起态**（`expanded === true` 直接返回 `false`）。

**入参 `rows` 就是 `ProjectRow` 要渲染的那批会话行**（`selectProjectSessionRows()` 的结果），不为目录行另判一遍身份与归属。这样「目录行有加载器」与「至少一条会话行有 spinner」严格同源，不会出现两边口径分叉：

- 已归档会话在 `selectProjectSessionRows()` 里就被滤掉（宿主会话索引按磁盘目录扫，归档后记录仍在索引里，不滤会复活）；
- 快照里还没有的会话没有行可渲染，也就不会被当成在跑；
- 当前协调者不在会话行里（它的入口是项目行本身），它单独在跑不点亮目录行；退役协调者留在会话行里，跟着行走；
- 换协调者留下的退役 id 不需要再单独排除——它们本来就不在渲染出来的行里时就不会被读到。

**展开态不额外兜底，边界是 `requiredWatermark` 的前 50 条**：运行中的会话会把水位抬到自己所在位置（`session-watermark.js` 的 `requiredWatermark`），但只在前 50 条内生效。这个范围内展开后可见，不会出现「收起时目录行有加载器、展开之后连会话行也看不见」的失明窗口；第 51 条及以后在跑的会话不抬水位，展开后仍可能被折起，要再点「展开其余」——那是会话列表本身超出一页时的既有折叠口径（与宿主一致），不为它扩大边界。

**渲染上是替换行首槽位里的目录图标，不是加第二个指示**。槽位尺寸不变（16×20），spinner 取 12px，复用同一份 `dsh-leader-kit-spin` 关键帧；边框用 `currentColor`，目录图标与它会解析到同一个颜色（选中态的激活色挂在 `lead-folder` 的 `color` 上）。悬停规则挂在槽位容器上，箭头照常盖住 spinner——运行中也要能展开查看是哪条会话在跑。spinner 是装饰（`aria-hidden`），状态语义不塞进按钮的无障碍名：项目行的入口含义仍是「打开协调者」。

**第二项需求（原生目录选择器初始灰态）在 bundle 侧修不了，只记证据**。面板由宿主 `osascript` 进程弹出，激活时机写在那支 JXA 脚本里；`0.2.1-rc.2`～`rc.5` 都在 `runModal` 之前同步激活，modal 循环未启动时激活落空，于是面板灰着、必须先点浏览器窗口。宿主提交 `7333a38c7a`（Fixes #7320）改成把激活排进 modal 事件循环，只进了 `0.2.2-alpha.2` 及之后。本仓能做的只有记录（`docs/capability-gaps.md` 第 41 条）并提示升级宿主；自己重造一条目录选择路径不可行——浏览器拿不到绝对路径。

## 边界

- 只覆盖「运行中」，不覆盖「等你输入」：宿主当前没有发布待处理交互的数据源（`docs/capability-gaps.md` 第 35 条）。
- 当前协调者单独在跑时目录行不亮。它没有会话行，判定只镜像会话行；要让它也算，就得回到「按归属列表另判一遍」的口径，两边会重新分叉。本轮明确不做，用户要的是「会话行转，目录行跟着转」。
- 悬停整行时行首槽位换成展开箭头、加载器随之隐藏：沿用官方工作区行的悬停规则，运行中也要能点开。
- 不动官方工作区行的图标：项目会话的排除只在渲染层，官方那一行的激活态另由 `quietWorkspaceOf` 处理。
- 项目区块标题行（「项目」小标题）不显示任何项目级状态：它是整个列表的折叠开关，不代表某个目录。
- 宿主升级到 `0.2.2-alpha.2` 后本仓的 API 面仍按下限 `0.2.1-rc.2` 写，不跟着用新版本才有的方法。

## 验证

- `npm run check`：693 tests / 693 pass / 0 fail（rebase 到 `5b40f79` 后读数）。项目面板 46 例，其中本轮新增 3 例：收起态运行判定、展开态不亮、目录行与渲染出来的会话行同源（归档会话与当前协调者不算）。
- 双向验证（单测）：
  - 把 `showsProjectActivity()` 临时改成恒 `false` → 2 例红（`项目行收起时，任一会话行在跑就显示加载器`、`目录行的加载器与渲染出来的会话行同源：归档会话与当前协调者不算`），46 → 44 pass / 2 fail；还原 → 全绿。同源用例带「把 worker 换成在跑 → `true`」的对照断言，否则恒 `false` 的实现也能让排除分支的断言通过。
  - 删掉 `if (expanded === true) return false` 这一行 → 1 例红（`项目行展开后不显示加载器——会话行自己带 spinner`），45 pass / 1 fail；还原 → 全绿。
- 真机渲染取证（隔离 dev 实例 + 无头 Chrome/CDP；探针脚本与截图放 `/tmp`，不入库）：判定本身交给上面的单测，渲染这一半临时把 `working` 硬写成 `!expanded` 单独验。1440×900 下点开左栏项目区块、点行首槽位切换：

  | 状态 | `aria-expanded` | `.dsh-leader-kit-project-spinner` | `getComputedStyle()` | 行首目录图标 |
  |---|---|---|---|---|
  | 收起 | `false` | 在，12×12 | `animationName: dsh-leader-kit-spin` / `animationPlayState: running` | 无 |
  | 展开 | `true` | 无 | — | 在 |

  探针改动已还原；重建后 `lib/client.js` 里能 grep 到 `showsProjectActivity` 与 `expanded === true`，不含探针写法。
- spinner 边框用 `currentColor`（不写死 tertiary）的读数：无头 Chrome 跑一份最小 DOM（激活色规则照 `feature/project-tree-session-selected` 的 `.row[data-active='true'] .lead-folder { color: business-primary }`），`getComputedStyle` 的 `border-left-color` 分别是——激活态修复后 `rgb(65, 118, 230)`、修复前 `rgb(120, 130, 150)`，同一行目录图标（`stroke: currentColor`）也是 `rgb(65, 118, 230)`；非激活态两者都是 `rgb(120, 130, 150)`。即写死色值只在选中态丢配色，非选中态视觉不变。
- 未做「worker 真在跑」的端到端：那需要真实模型或本地 mock provider，本轮以「判定用单测、渲染用上面的 DOM 读数」两段拼出结论；合并后第一次真实派工时再看一眼收起态即可。
