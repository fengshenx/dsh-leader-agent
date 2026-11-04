# 项目行首图标改用九宫格

**范围**：`src/client/{icons,project-section}.js`、`tests/project-panel.test.js`、`tests/e2e/project-workspace.e2e.js`、`docs/{usage,getting-started,architecture,limitations}.md`、`README.md`、`README_ZH.md`

## 背景

项目行首一直是宿主同款的描边文件夹。这一行是 leader 会话的入口，但和左侧宿主工作区树的分组行完全同形——两棵树并排时「项目」和「工作区」只能靠位置区分。需求（issue #116）是把它换成九宫格。

首版按「leader 会话要有自己的行」来做，在展开列表里新增了一行 leader 并给它九宫格，项目行保持文件夹。实际反馈是「还是目录，不是九宫格」——要改的就是项目行首本身，那一版已整体回滚（提交 `46ef871` 与本 PR 的 revert）。

## 决策

### 自绘 3×3 网格，不借宿主带加号的字形

宿主 `artwork.ts` 没有纯九宫格：`apps-add-outline` / `apps-add-compact-outline` 都是三格加一个「+」。放在项目行首会被读成「新建项目」，而真正的加项目按钮就在分区标题右侧。所以 `icons.js` 内联 `apps-grid-fill`：九个 3.4px 圆角方块（`rx` 0.9），步长 5、边距 1.3，填充不描边，与宿主同一套 16 box 口径。方块尺寸是 16px 下的可辨识下限：2.4px 时九宫格读成稀疏点阵（第一版就是这么画的），4px 时间隙只剩 1.5、糊成一团。

### 展开/收起不再换字形

原来 `folder-close` / `folder-open` 两态区分展开。换成单字形后，展开态由行首悬停时的箭头（展开时旋转 90°）与会话列表本身表达——箭头本来就承担这个反馈，字形不再是状态载体。

### 顶部「项目」分区标题保留 `folder-open-outline`

那是分区的图标，不是单个项目的入口；不动它，也避免同屏出现两个语义不明的网格。

### 删掉 `folder-close` / `folder-open` 字形

只被项目行首使用，换掉后没有调用点（未使用的代码直接删）。`folder-open-outline` 仍被分区标题引用，保留。

### 类名保留 `-folder` 后缀

槽位的位置、尺寸、悬停规则都与宿主工作区行的目录图标同源，改的是字形不是槽位。改名要牵动 CSS 与测试的六处匹配，没有行为收益；在 CSS 注释里写明这一点，避免下一个人以为漏改。

## 边界

- **九宫格是自绘字形**：不在宿主 `artwork.ts` 里，不会随宿主图标更新而变化；`icons.js` 其余字形仍与宿主同步。
- **运行中槽位不渲染九宫格**：本组有活动时槽位换成宿主 `StateDot`，与之前「目录图标不渲染」是同一条既有行为，`docs/limitations.md` 已同步措辞。
- **同屏其他网格类图标**：宿主侧栏的「更多」等入口也可能是网格形状，本仓只在项目行用九宫格；这是既有平台图标，不做联动。
- **CSS 模板里的反引号会在 import 期炸掉整个客户端半边**。这次在 `STYLE_TEXT` 的注释里写了带反引号的类名后缀，模板当场截断，其余正文被当成 JS 表达式，产物里出现未定义标识符——页面白屏、`plugin.e2e.js` 与全部项目树场景一起超时，而 `node --check`、单测与覆盖率门禁全绿（这层只做语法检查，不跑模块求值）。AGENTS 早就写了这条规则，漏在执行。改 `src/client/` 里的 CSS 后先跑 `plugin.e2e.js`：它比业务场景快一个数量级，判据正是「插件能不能挂载」。

## 验证

- 单测：`tests/project-panel.test.js` 新增「项目行首换成九宫格，不再引用目录字形」——断言渲染走 `apps-grid-fill`，且 `src/client/icons.js` 里已无 `folder-close` / `folder-open` 定义。`npm run check` 全绿（1066 用例通过）。
- 双向验证：把渲染改回 `productIcon(expanded ? 'folder-open' : 'folder-close')` → 新用例在字形断言上变红；还原后全绿。
- e2e：`tests/e2e/project-workspace.e2e.js` 在项目行出现后断言行首槽位里恰好 9 条 `<path>`（九宫格的方块数，能区分于两三条 path 的目录字形）。全量 `npm run e2e` 6/6 通过。
- 真机：worktree 的 `npm run dev` 实例（`empty-test` 项目）里行首显示为九宫格，展开/收起与悬停箭头行为不变。
