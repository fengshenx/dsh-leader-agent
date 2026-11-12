# 0.2.2 的左栏滚动网格里，项目区块要换落点

## 背景

宿主 `0.2.2` 重排了左栏：面板列表 `nav` 与工作区不再并列为左栏根的直接子元素，而是被同一个滚动容器包住，`grid-template-rows: 8px max-content 2px max-content`（面板列表第 2 行、2px 分隔第 3 行、工作区第 4 行）。

本仓的项目区块靠 DOM 注入取位：`sidebar.footer.action` 里放锚点，向上找「直接子元素含 `nav`」的祖先作为左栏根，在 `nav` 之后插容器，再用 portal 把内容搬过去。`0.2.2` 上 `nav` 下沉一层，这条判据一路走到 `null`，portal 不生效，内容原样留在 footer——位置从「工作区之上」掉到「设置按钮之上」，就是用户看到的「项目目录缩到最下面」。功能都在，只有位置错。

## 决策

### 认 `nav`，不认层数

`findSidebarRoot` 的判据从「直接子元素里有 `nav`」放宽成「子树里有 `nav`」。`0.2.1` 与 `0.2.2` 都能命中；`nav` 仍只出现在左栏，不会误认到别处的导航。

### 落点按宿主结构分两版

`placementSpot(root, nav)` 返回 `{ parent, before }`：

- `0.2.1`：`nav.parentElement === root`，插在 `nav` 之后（原逻辑）。
- `0.2.2`：插进 `nav` 的下一个兄弟（工作区容器）的顶部。**不能**继续插在 `nav` 之后：滚动网格的行数是固定的，新元素会被自动摆进第 3 行那 2px 分隔里压扁。

两种结构下的视觉顺序都是「面板列表 → 项目 → 工作区」，窄栏的入口按钮跟着走。找不到落点时返回 `null`，内容退回 footer 锚点渲染——降级路径保留。

## 边界

- 只覆盖宿主这两版结构，不写通用选择器；宿主再改版时退化为「旧版位置（footer）」，不会插到错误的地方。
- `0.2.2` 起区块与面板列表、工作区一起滚动（宿主把这个区域整体做成滚动区），不再像 `0.2.1` 那样固定在栏中。这是跟随宿主新布局的取舍，不加 `position: sticky` 之类的额外样式。
- 不新增槽位、不改宿主 DOM 结构、不依赖哈希类名；插入的容器仍带 `data-dsh-leader-agent-projects`。
- 锚点只在挂载时找一次；宿主运行中替换左栏根节点时需要重挂（当前版本不这么做）。

## 验证

`tests/e2e/project-placement.e2e.js`（真实宿主 + chromium，web profile）：等 `[data-dsh-leader-agent-projects] .dsh-leader-agent-project-section` 出现，再断言区块不在 `[class*="footArea"]` 里、与工作区主体的文档顺序是「区块在前」、高度非零。

双向验证（宿主 `0.2.2-rc.2`，npm 装在 `.dev/host-rc2`；npm 全局的 `0.2.2-rc.1` 没有这次左栏重排）：把 `findSidebarRoot` 精确还原成 `:scope > nav` → 用例在「项目区块搬进左栏落点容器」处超时变红，读数 `{count:0, inDom:false}`，页面读数里 `leaderAgent.sections: 1`（区块退在 footer）；还原修复 → 绿。

宿主导入读数：

- `0.2.2-rc.2`：全量 e2e 9/9 通过（`--test-concurrency=1`）。
- `0.2.2-rc.1`（旧结构）：全量 e2e 9/9 通过，确认没有把老版本打回 footer。

并行跑全量时 `board-done-paging` 曾因 9 个实例抢资源在 15 秒等待处超时；单跑与串行跑都通过，与本改动无关。
