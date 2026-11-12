# 0.2.2 的左栏滚动网格里，项目区块要换落点

## 背景

宿主 `0.2.2` 重排了左栏：面板列表 `nav` 与工作区不再并列为左栏根的直接子元素，而是被同一个滚动容器包住，`grid-template-rows: 8px max-content 2px max-content`（面板列表第 2 行、2px 分隔第 3 行、工作区第 4 行；网格第 1 行第 1 列是 4px × 8px 的空单元格）。

本仓的项目区块靠 DOM 注入取位：`sidebar.footer.action` 里放锚点，向上找「直接子元素含 `nav`」的祖先作为左栏根，在 `nav` 之后插容器，再用 portal 把内容搬过去。`0.2.2` 上 `nav` 下沉一层，这条判据一路走到 `null`，portal 不生效，内容原样留在 footer——位置从「工作区之上」掉到「设置按钮之上」，就是用户看到的「项目目录缩到最下面」。功能都在，只有位置错。

## 决策

### 认 `nav`，不认层数

`findSidebarRoot` 的判据从「直接子元素里有 `nav`」放宽成「子树里有 `nav`」。`0.2.1` 与 `0.2.2` 都能命中。

安全性不来自「`nav` 只出现在左栏」——`ui-conversation`、`ui-settings-general`、`ui-chat`、`ui-input-trigger` 都渲染 `<nav>`。它来自锚点的位置：锚点在 `sidebar.footer.action` 里，从 footer 向上到左栏根之间没有别的 `nav`，所以第一个含 `nav` 的祖先必然是左栏根。

### 落点按宿主结构分两版

`placementSpot(root, nav)` 返回 `{ parent, before }`：

- `0.2.1`：`nav.parentElement === root`，插在 `nav` 之后（原逻辑）。
- `0.2.2`：插进 `nav` 的下一个兄弟（工作区容器）的顶部。**不能**继续插在 `nav` 之后：新元素会被网格自动摆进第 1 行第 1 列那格 4px × 8px 的空单元格（第 3 行的 2px 分隔由 `::after` 占着），区块被压成 4px 宽竖条，视觉上像贴在面板列表上。

两种结构下的视觉顺序都是「面板列表 → 项目 → 工作区」，窄栏的入口按钮跟着走。找不到落点时返回 `null`，内容退回 footer 锚点渲染——降级路径保留。

## 边界

- 只覆盖宿主这两版结构，不写通用选择器。宿主再改版时降级成「旧版位置（footer）」，但**落到哪取决于 `region` 的取法**：`0.2.2` 分支把 `nav.nextElementSibling` 当工作区容器，没有独立校验；宿主将来在 `nav` 与工作区之间再插一个元素，容器会跟着插进那个元素里，而不是工作区顶部。e2e 兜底的是「区块没退回 footer、宽度没被压成 4px、在 `nav` 之后」，不是「任何结构下都插对」。
- `0.2.2` 起区块与面板列表、工作区一起滚动（宿主把这个区域整体做成滚动区），不再像 `0.2.1` 那样固定在栏中。这是跟随宿主新布局的取舍，不加 `position: sticky` 之类的额外样式。
- 不新增槽位、不改宿主 DOM 结构、不依赖哈希类名；插入的容器仍带 `data-dsh-leader-agent-projects`。
- 长期看，位置稳定性要靠宿主提供位于工作区之上、与它并列的 list slot；DOM 取位只是过渡。宿主能力边界见 [capability-gaps 第 27 条](../../../../docs/capability-gaps.md)。
- 锚点只在挂载时找一次；宿主运行中替换左栏根节点时需要重挂（当前版本不这么做）。

## 验证

`tests/e2e/project-placement.e2e.js`（真实宿主 + chromium，web profile）：

- 先等 `.dsh-leader-agent-project-section` 在**任意位置**挂载，再断言——修复失效时区块退回 footer 也能读到，失败形态是断言红并带 `inFooter: true` 的读数，不是 20 秒超时。
- 断言落点容器：`host.parentElement` 必须等于工作区容器（`0.2.2`，`nav` 在 `[data-sidebar-scrollport]` 网格里）或左栏根（`0.2.1`）；另断言区块宽度 ≥ 100px、在 `nav` 之后、在工作区主体之前、高度非零。宽度这条直接挡住「插到 `nav` 之后被摆进 4px × 8px 空单元格」的写法。

双向验证（宿主 `0.2.2-rc.2`，npm 装在 `.dev/host-rc2`）：

- 把 `placementSpot` 换成朴素「插到 `nav` 之后」→ 断言红，读数 `hostParentIsExpected=false`、`sectionWidth=4`（落点 `host.parentElement=scrollArea`）→ 还原后绿。
- 把 `findSidebarRoot` 精确还原成 `:scope > nav` → 断言红，读数 `hostFound=false`、`inFooter=true`（区块退在 footer）→ 还原后绿。

宿主版本读数：

- `0.2.2-rc.2`：全量 e2e 9/9 通过（逐文件串行）。
- `0.2.2-rc.1`（旧结构）：全量 e2e 9/9 通过，确认没有把老版本打回 footer。
