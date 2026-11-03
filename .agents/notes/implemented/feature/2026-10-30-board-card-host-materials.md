# 看板卡面改用宿主卡片材质

**状态**：implemented（P6，2026-10-30）
**范围**：`src/client/board-styles.js`、`tests/board-styles.test.js`

## 背景

[看板卡片视觉与交互](2026-10-27-board-card-visual-and-interaction.md) 定的卡面是「无边框无阴影、静态零装饰、hover 只出背景」。那一版解决的是信息结构与交互，视觉上把卡片做成了纯文字列表：卡与卡之间只有 6px 空隙，卡面与右栏背景同色，读完一段不知道它到哪结束。用户第二次指认「Card 的样式设计还是丑」，要求复用 dsh 自己的 design token。

宿主已经有成文的卡片材质，不需要自己发明数值：

- `docs/ui-radius.zh.md` 的「设置卡片材质」：`--dsw-radius-*` 圆角 + `0.5px solid var(--dsw-alias-settings-card-stroke)` + `var(--dsw-alias-settings-card-fill)`。
- `docs/web-styling.zh.md` 的层级规则：高层级表面 `border: 0` 加 `--dsw-elevation-*`，发丝描边画在 `box-shadow` 第一层；中性 `--dsw-alias-border-*` 的 border 与 elevation 投影**不得**同时出现（ui-theme 的 elevation spec 会拒绝）。
- 同类的实现：`packages/experimental/client-ui-agent-team` 的成员卡（sidebar 内多行状态卡）。

## 决策

**卡面走宿主行内卡片材质：`bg-layer-2` 底 + `elevation-stroke` 发丝描边**。`border: 0`，描边在 `box-shadow` 里，通过重绑 `--dsw-elevation-stroke-color` 换档而不是叠一层真 border——与宿主成员卡同一套机制，也就自动接受了「border 与 elevation 不得配对」这条约束。hover 时描边升一档并把投影升到 `--dsw-elevation-panel`。

**静态描边取 `border-l3`，比宿主成员卡的 `l2` 深一档**。成员卡浮在带模糊的菜单面上，`l2` 够用；看板卡直接在浅色 sidebar 底上独自立着，`l2` 在 1x 屏读不出边界。

**圆角按用途分档，不按「卡片就一个半径」铺**。卡面与骨架取 `--dsw-radius-lg`（R16）——宿主把改动文件入口卡、交付文件卡、计划卡、任务卡这类多行卡与代码块一起归 R16，看板卡是同一形态；链接 chip 只有 18px 高（`line-height: 16px` + 上下各 0.5px 边框，Chrome 把 0.5px 取整成 1px），属「低于 H20 的微型控件」的 R4，宿主同解剖的设置项标签 `rowTag` 也是 R4；done 行与折叠开关是 32px 单行 cell，取 R12；空态 48px 图标底框取 R16，与宿主同尺寸底框一致；右栏 guide 入口保持宿主 `EntryBox` 的 R20。

chip 改用 `box-sizing: border-box` 后，`max-width` 取 123px 而不是 110px：110 是改前 content-box 写法的**内容宽**，总宽其实是 110 + 12 横向 padding + 1 双边边框 = 124px。换材质不该顺带把长标签截短 13px，所以按 border-box 折回等价总宽。测量层与真实 chip 同 class，两边量到的都是这个 border-box 宽度，`fitLinkChips` 的排布逻辑不受影响。

**成品卡（done）不加材质**。完成的卡不需要抢注意力：透明行 + hover 出背景，与带卡面的 active 卡靠对比形成主次，而不是靠更浅的描边。

**卡间距 6px → 8px，与宿主成员卡栅格的 8px 同档**。旧间距是纯文字列表的紧凑值；卡面有了描边和投影后，6px 会让相邻两卡的描边挤成一条，8px 才与宿主 `client-ui-agent-team` 的 `.roster` 栅格一致。

**编号与时间用 `--dsw-alias-label-caption`，不再叠 `opacity`**。alpha 与语义色叠加出来的颜色不属于任何一档 token，换主题时对不上；宿主把「比 tertiary 更弱」这件事本身做成了 token。折叠开关同理，弱化用 `label-secondary`，hover 升 `label-primary`，不用 `opacity: 0.7`。**图形点（信号点、槽位点）是这条规则的例外**：那里没有「比 tertiary 更浅」的 token 档，而点要的是面积上的退让、不是色相的语义，所以保留 `label-tertiary` + `opacity: 0.4`（`idle`/`unknown` 两档 0.55）。文字类一律换档、图形类允许叠 alpha，这条界线写进 `board-styles.js` 的注释里。

**链接 chip 用宿主的「可点击产物链接」示能**：`--dsw-alias-link` 着色 + `font-weight: 500` + 默认无下划线 + hover 与键盘焦点同为点状下划线，外面套 `0.5px` 发丝线 + `--dsw-radius-xs` 的壳把它和卡面分开。原来的 `1px solid` 胶囊壳 + `opacity: 0.8` 同时违背发丝线宽度与「不叠 alpha」两条。详情页的链接行是同一示能，两条都在 `:focus-visible` 上补了下划线——只写 `:hover` 会让键盘用户看不出这是可点的。

**下划线偏移分两档：详情页 3px，chip 1px**。宿主规范给可点击产物链接定的是 `text-underline-offset: 3px`，chip 的内容盒只有 16px（`line-height: 16px` + 上下各 0.5px 边框），偏移在 1px 时点线完整、离底边框有余量；**3px 仍然画得出来**，只是已经压在底边框上、与 0.5px 发丝线糊成一条；再往上整条落到 padding box 外，被 chip 与 `chip-body` 两层 `overflow: hidden` 裁掉——两处独立读数分别从 4px 与 5px 起消失，差异来自 0.5px 边框在 Chrome 被取整成 1px（chip 实际 18px 高）。所以 1px 不是「唯一画得出来的值」，而是留出可读间距的取值。详情页链接行 `line-height: 20px` 且不在裁切带里，按规范保留 3px。

**滚动条档位不在这里重绑**。看板渲染在宿主 dockkit 的 `paneBody` / `floatBody` 里，那两处已经把浮起面重绑成 l2 一档（`ui-dockkit/src/components/dockkit.module.css:587-588`、`801-802`，注释写明「elevated ground 上要换 l2，否则基础档拇指显脏」）；本层再绑是同一个别名的同值重复。实测深色主题里列表继承到 `#545557`（l2），`body` 的基础档是 `#3c3c3d`（l1）——差别真实存在，但由 dockkit 那层提供；浅色下 `scrollbar-bg-l1` 与 `-l2` 同为 `neutral-200`，所以这条动机只在深色主题里看得见。`ui-sidebar-files` 没有重绑滚动条档位（只调 `scrollbar-gutter` 与 track 的 2px margin），不能当浮起面材质的先例引用。

**焦点环走 `--dsw-focus-ring-*` 与内嵌 offset**。rc.2 只定义了 `--dsw-focus-ring-width`（2px），`--dsw-focus-ring-color` 还没有定义，色值实际走回退；引用这个属性是为了接住指针模态下宿主把该属性置成 transparent 的抑制（`html[data-input-modality='pointer'] body :focus-visible:not(:read-write)`，真机读数确认卡面与 chip 的环都随之变透明）。chip 的环必须内嵌：它所在的链路行高度就是 chip 的 18px 且 `overflow: hidden`，外扩 2px 环会被裁掉上下两边、只剩左右两段竖条（改前真机截图即是这个形态）。卡面用内嵌不是被裁，而是卡与卡只隔 8px、卡面又占满列宽，外扩环会与相邻卡的环挤在一起；两处统一 `outline-offset: -2px`（宿主对密集内容的同一取舍）。

**全圆与胶囊配对 `corner-shape: round`**。宿主 `corner-shape.css` 给所有圆角面套 superellipse(1.5)，`50%` 与 `999px` 若不退出会被压成方角。信号点、槽位点、`done-count`、详情页状态胶囊都补了这条。

**所有 `:hover` 规则包进 `@media (hover: hover)`**。触屏上 `:hover` 会被点按粘住；这是宿主样式规范的硬要求。

## 边界

- **视觉只保证结构对齐宿主，不保证像素一致**：宿主调 `--dsw-radius-*`、`elevation` 或色阶时本仓自动跟随，这正是复用 token 的目的；但卡面的行列结构、缩进（22px）、字号（13/11px）仍是本仓自己的数值，宿主不会替我们改。
- **下划线与焦点环的可见性靠真机读数判定，不只看声明**：`overflow: hidden` 会把画不到盒内的下划线整条裁掉、把外扩焦点环切成两段竖条，这两个失效模式在 CSS 声明上完全看不出来（`text-underline-offset: 3px` 与 `outline-offset: 0` 在源码里都像是对的）。本轮在隔离实例的浅色/深色两套主题下逐状态截了 chip hover、chip 键盘焦点、卡面键盘焦点、done 行焦点、详情页链接 hover/焦点，并用 `getComputedStyle` 读回 `text-underline-offset`、`text-decoration-line`、`outline-offset`、投影色与指针模态下的 `outline-color` 作为可复核读数。
- **1x 屏描边更淡**：0.5px 在 2x 屏渲染为一物理像素，1x 屏是混合值——宿主对自己的发丝线是同一取舍。
- **卡面根仍是 `role="button"` 且内嵌可聚焦控件**：ARIA 冲突与上一版一致，本次不动。

## 证据

隔离实例（`dsh 0.2.1-rc.2`，即 `engines.dsh` 下限）：`projects.json` 与 `cards.json` 直接 seed 出 3 张 active + 2 张 done，看板在右栏渲染；浅色与深色主题各截一张，done 折叠区展开截一张。改前（透明列表）与改后（卡面材质）取自同一会话的同一批卡片。

`npm run check` 全绿，其中 `tests/board-styles.test.js` 的 10 例把本次依赖的宿主硬规则固化成回归：样式表可解析且规则数不塌、`50%`/`999px` 必须配 `corner-shape: round`、可点击链接在 hover 与焦点下都有点状下划线、chip 的下划线偏移取真机定下来的 1px、裁切带里的焦点环必须内嵌（`outline-offset` 严格小于 0，取 0 仍会被裁成两段）、`:hover` 必须在 hover 媒体查询里、中性边框必须 0.5px、中性 border 不得与 elevation 投影同规则、引用的 `--dsw-*` token 必须在白名单内（名字打错时 CSS 不报错、取值静默变空）、信号点的状态变体必须写在基础规则之后（否则同特异性下被基础档覆盖）。样式表写在 JS 模板字符串里，宿主 `ui-theme` 的 scanner 只扫 `packages/`，这几条只能本仓自己守。

断言质量的界线要写清：`corner-shape` 配对、`:hover` 媒体查询、0.5px 边框、token 白名单、变体顺序、焦点环内嵌这几条落在**真实可观测量**上（规则文本里可判定的结构事实），撤掉修复必红；`text-underline-offset` 只能断言字面量 1px——CSS 声明层看不出基线落在哪，可见性只有真机读数能证，所以那一条的注释写明「改它得先有新的真机读数」，不假装是几何推导。

chip 偏移那例做过双向验证：把两条规则的 `text-underline-offset` 改回 `3px`，该例会红（`1px != 3px`），还原后全绿。token 白名单与变体顺序两例同样是活的——把任一 `--dsw-*` 名字改错、或把一条状态变体挪到基础规则之前，对应用例立刻变红。

真机读数（隔离实例、`--force-device-scale-factor=2`）：浅色卡面 `border-radius: 16px`、`border: 0`、`box-shadow: rgba(0,0,0,0.12) 0 0 0 0.5px`（hover 升到 `0.16` + panel 投影）；深色卡面底 `rgb(44,44,46)`、描边 `rgba(255,255,255,0.16)`、hover `rgba(255,255,255,0.2)`；chip 实测 `18px` 高（`0.5px` 边框在 Chrome 取整成 1px，不是 17px）、`border-radius: 4px`、`border-width: 0.5px`、链接色浅色 `rgb(65,118,230)` / 深色 `rgb(122,170,255)`，hover 与焦点下 `text-decoration: underline dotted` + `text-underline-offset: 1px` 且点线可见；卡面与 chip 的 `:focus-visible` 环为 `2px` 实线、`outline-offset: -2px`，完整成环；done 行 `border-radius: 12px`、透明底，折叠开关 `color: rgb(97,102,107)`（`label-secondary`）且不再有 `opacity` 衰减；看板列表的滚动条拇指继承 `#545557`（深色 l2），与 dockkit `paneBody` 同值。截图不入库。

未取证：空项目空态、1x 屏发丝线实拍（0.5px 在 1x 是混合值，属与宿主同款的取舍）、深色主题的本轮独立复现（沿用首轮读数）。
