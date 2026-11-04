# 项目行首图标改用宿主应用格子（`apps-add-outline`）

**范围**：`src/client/{icons,project-section}.js`、`tests/project-panel.test.js`、`tests/e2e/project-workspace.e2e.js`、`docs/{usage,getting-started,architecture,limitations}.md`、`README.md`、`README_ZH.md`

## 背景

项目行首一直是宿主同款的描边文件夹。这一行是 leader 会话的入口，但和左侧宿主工作区树的分组行完全同形——两棵树并排时「项目」和「工作区」只能靠位置区分。issue #116 的原话是把它换成九宫格；最终口径（该 issue 的「变更记录」）是项目行首固定宿主 `apps-add-outline`（三格 + 一个加号），不新增 leader 会话行。

首版按「leader 会话要有自己的行」来做，在展开列表里新增了一行 leader 并给它九宫格，项目行保持文件夹。实际反馈是「还是目录，不是九宫格」——要改的就是项目行首本身，那一版已整体回滚（提交 `46ef871` 与本 PR 的 revert）。

## 决策

### 用宿主 `apps-add-outline` 原样，不自绘

宿主 `ui-primitives` 没有纯九宫格：带格子的只有 `apps-add` 这一族，都是三格加一个「+」。一度按 16 box 口径自绘九宫格（九个填充方块），理由是「+」会被读成「新建项目」，而加项目按钮就在分区标题右侧；两轮尺寸调整（2.4px 像稀疏点阵、3.4px 才可辨）之后定为宿主原样字形——图标跟着宿主走，本仓不再维护一份自造路径，16px 下的可辨识度也不用自己调。

内联路径取自宿主 `0.2.1-rc.5` 的 `packages/client/ui-primitives/src/icons/index.tsx`（`IconAppsAddOutlineRegular`）；`artwork.ts` 的 sprite 重构从 `0.2.2-alpha.2` 起才有，按 rc.5 对照 `artwork.ts` 会找不到文件。内联本身不依赖宿主版本，这个锚点只为可追溯。

路径按 `icons.js` 现有结构内联：三个 `<rect width=4 height=4 rx=1>` 折成等价 path，加号 `M11.75 1.75v5M9.25 4.25h5` 原样。

### 展开/收起不再换字形

原来 `folder-close` / `folder-open` 两态区分展开。换成单字形后，展开态由行首悬停时的箭头（展开时旋转 90°）与会话列表本身表达——箭头本来就承担这个反馈，字形不再是状态载体。

### 顶部「项目」分区标题保留 `folder-open-outline`

那是分区的图标，不是单个项目的入口；不动它，也避免同屏出现两个语义不明的网格。

### 删掉 `folder-close` / `folder-open` 字形

只被项目行首使用，换掉后没有调用点（未使用的代码直接删）。`folder-open-outline` 仍被分区标题引用，保留。

### 类名保留 `-folder` 后缀

槽位的位置、尺寸、悬停规则都与宿主工作区行的目录图标同源，改的是字形不是槽位。改名要牵动 CSS 与测试的六处匹配，没有行为收益；在 CSS 注释里写明这一点，避免下一个人以为漏改。

## 边界

- **「+」与添加项目按钮同形**：这是宿主 `apps-add-outline` 自带的，接受它作为入口标识；项目行本身不做「新建」动作，新建在分区标题右侧。
- **运行中槽位不渲染行首图标**：本组有活动时槽位换成宿主 `StateDot`，与之前「目录图标不渲染」是同一条既有行为，`docs/limitations.md` 已同步措辞。
- **同屏其他网格类图标**：宿主侧栏的「更多」等入口也可能是网格形状，本仓只在项目行用应用格子图标；这是既有平台图标，不做联动。
- **CSS 模板里的反引号会在 import 期炸掉整个客户端半边**。这次在 `STYLE_TEXT` 的注释里写了带反引号的类名后缀，模板当场截断，其余正文被当成 JS 表达式，产物里出现未定义标识符——页面白屏、`plugin.e2e.js` 与全部项目树场景一起超时，而 `node --check`、单测与覆盖率门禁全绿（这层只做语法检查，不跑模块求值）。AGENTS 早就写了这条规则，漏在执行。改 `src/client/` 里的 CSS 后先跑 `plugin.e2e.js`：它比业务场景快一个数量级，判据正是「插件能不能挂载」。

## 验证

- 单测：`tests/project-panel.test.js` 新增「项目行首改用宿主应用格子字形，不再引用目录字形」——断言渲染走 `apps-add-outline`，且 `src/client/icons.js` 里已无 `folder-close` / `folder-open` 定义。`npm run check` 全绿。
- 双向验证：把渲染改回 `productIcon(expanded ? 'folder-open' : 'folder-close')` → 新用例在字形断言上变红；还原后全绿。
- e2e：`tests/e2e/project-workspace.e2e.js` 在项目行出现后断言行首槽位里恰好 4 条 `<path>`（三格 + 加号），能区分于两三条 path 的目录字形。全量 `npm run e2e` 6/6 通过。
- 真机：worktree 的 `npm run dev` 实例里行首显示为宿主应用格子图标，展开/收起与悬停箭头行为不变。
