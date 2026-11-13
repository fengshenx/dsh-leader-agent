# 项目区块跟随宿主 0.2.2 的行几何

**范围**：`src/client/project-section.js`、`src/client/icons.js`、`tests/project-panel.test.js`、`tests/e2e/project-alignment.e2e.js`

## 背景

宿主 `0.2.2-rc.2` 改了两处左栏几何，0.2.1 的数值不再成立：

- `ui-workspace/src/client/rows/Rows.module.css` 的 `.projectRow` 从 34px 压到 32px；行本身用 3px 透明边框吃掉 `--dsh-sidebar-paint-inset`，左内容起点是 `row_padding(12) - paint(3) + border(3) = 12px`，行首图标落在 20px。
- `WorkspaceBrowser.module.css` 的 `.sectionHeader` 左内边距从 4px 换成 `--dsh-sidebar-row-padding`（12px），「工作区」标题从 19px 起排（标题自带 `left: -1px`）。

项目区块照的是 0.2.1：行高 34、`padding: 0 8px`、标题前还有一个 16px 的文件夹图标槽。在 `0.2.2-rc.3` 上实测（桌面宿主 1440×900，左栏 280px）：项目行高 34 对宿主 32，行首图标 16 对 20，标题 38 对 42，「项目」标题 32 对「工作区」19。三处叠在一起，就是「项目、下面的 session、工作区没对齐」。

## 决策

### 行几何照 0.2.2 的 `Rows.module.css`

项目行改成与宿主同一组声明：`height: 32px`、`border-inline: var(--dsh-sidebar-paint-inset, 0px) solid transparent`、`background-clip: padding-box`、`padding: 0 8px` 加 `padding-inline-start: calc(var(--dsh-sidebar-row-padding, 8px) - var(--dsh-sidebar-paint-inset, 0px))`。

- 0.2.1 没有这两个变量，退回到「8px 内边距、无边框」，正是那版硬编码的几何；行高没有可继承的变量，0.2.1 上比宿主矮 2px，作为下限版本的已知差异接受（不为此写版本分支）。
- 会话行右侧内边距从 9px 改回 8px（之前按 `row - paint` 算的是左内侧），左内侧与宿主一样是 12px；改后标题右边缘与宿主会话行差 0。
- hover 底色现在与宿主行一样内缩 3px，不再铺满整行。

### 小节标题不再有前置图标槽

标题必须是 header 的第一个内容：「工作区」标题从内边距处起排，前面多一个 16px 图标槽就会把「项目」推右十几像素。于是删掉 header 的 `folder-open-outline` 槽，收起箭头移到标题之后、仍只在悬停时出现；`padding-left: var(--dsh-sidebar-row-padding, 4px)`（0.2.1 退回 4px），`margin: 2px 0 4px` 与宿主 `sectionHeader` 的上 2px / 下 4px 一致。

代价是「项目」标题不再有装饰图标；项目行的行首格子图标仍在，区块识别不受影响，标题对标题的对齐是更显眼的契约。`folder-open-outline` 字形随之只剩无用数据，从 `icons.js` 删除；`tests/project-panel.test.js` 的接线断言改为「标题是 header 的第一个内容、箭头在标签之后、字形表里没有目录字形」。

## 边界

- **0.2.1 上项目行比宿主矮 2px**：宿主没有暴露行高的 CSS 变量，同一份声明只能对齐一版；`engines.dsh` 仍允许 0.2.1，这 2px 记在已知差异里，不为它加版本探测。
- **header 右边缘没追**：宿主 header 用 `margin-right: -4px` + `padding-right: 1px` 让最后一枚按钮比内容区再靠右一点，本区块的「加项目」按钮比宿主按钮左 1px。1px 内不追，避免为复制宿主的右侧内缩再加一层负外边距。
- **收起箭头的位置变了**：从标题前移到标题后，点击标题仍然收起/展开整个列表，交互契约不变；发现的路径只剩悬停（与改动前一致）。
- 只对齐几何，不改字号、行距、语义色与 hover 行为。

## 验证

- 新增 e2e `tests/e2e/project-alignment.e2e.js`：以宿主同一元素为基准（`[class*="projectRow"]`、`[class*="sectionLabel"]`），断言行高、左右内边距、左右透明边框、行首图标 / 标题 / 小节标题的左边缘（≤1px），失败时打印两边读数。不写死 32 / 12 这些像素，宿主再改几何时场景先红。
- 双向验证（在 rc.3 宿主上逐条撤销 → 变红 → 还原 → 变绿）：
  - 项目行退回 `height: 34px; padding: 0 8px`（无边框）→ 红，读数 `ourRow {height:34, paddingLeft:"8px", border:"0px"}` 对 `hostRow {height:32, paddingLeft:"9px", border:"3px"}`，图标 16 对 20、标题 38 对 42；还原 → 绿。
  - header 左内边距退回 `4px` → 红，读数 `ourLabelLeft 12` 对 `hostLabelLeft 19`；还原 → 绿。
- `npm run e2e`（rc.3 桌面宿主 + 本地 mock）10 条场景全绿，含本场景与 `plugin.e2e.js` 冒烟。
- `npm run check`：1121 用例通过 / 17 跳过，`tests/project-panel.test.js` 49 条全绿（含改写后的标题与字形断言）。
- 修复后 rc.3 实测：项目行 `height 32 / paddingLeft 9px / 左右边框 3px / 行首图标 20 / 标题 42`，与宿主工作区行逐项相同；「项目」标题 20 对「工作区」19（宿主自身 `left: -1px`）。
