# 项目行选中态与协调者名单刷新

## 背景

新建项目后点项目行，主区域能打开协调者会话，但左栏项目行没有任何选中反馈：用户看不出「当前主区域属于哪个项目」，只能靠会话标题推断。项目行从来只有 hover 与「更多」菜单打开两种底色，没有跟随当前会话的状态。

同一路径上还有一个时序缺口：协调者会话名单只在通道就绪与窗口重新获得焦点时刷新。同窗口新建项目（或换新协调者）之后名单里没有新会话 id，紧接着点开项目，主区域会回到居中的欢迎页——输入框不在底部，转录里也没有任何内容。

## 决策

### 选中态由「当前会话是否属于该项目」判定

判据抽成 `isProjectCurrent(project, sessionIds, currentSessionId)`：当前会话是项目的协调者，或落在宿主判定的该项目会话集合里，项目行就算选中。协调者不在项目树下单独出行，项目行就是它的入口；worker 被打开时同样点亮所属项目——那一行代表的就是这一组会话。

样式与结构照官方会话行：`--dsw-alias-interactive-bg-hover` 常驻底色，行上带 `data-selected` 与 `aria-selected`。项目列表容器补 `role="tree"`，让 `treeitem` 进入可访问性树——此前只有 `role="treeitem"` 没有树容器，辅助技术与 AX 快照都拿不到这些行。

### 名单刷新挂到项目变更广播

`watchCoordinatorSessions` 订阅已有的 `onProjectsChanged`（左栏每次增删改项目成功后广播）。没有把「建项目后手动推新 id」写进建项路径：换新协调者同样会换掉名单里的 id，广播是这两条路径共同的出口，挂一处就不会漏。

名单与刷新逻辑从 `coordinator-view.js` 拆到 `coordinator-session-index.js`：后者不 import React，单测可以直接加载；视图目标与主区域入口留在原模块。

## 边界

- **不跟宿主的 `panelActive`**：右栏面板打开时宿主认为主区域没有当前会话，本仓仍按 `retainedBy.mainView > 0` 判定。这与 `quietWorkspaceOf` 的既有取舍一致——多亮的只是一层底色，不改变任何行为。
- **只点亮项目行，不点亮项目树里的会话行**：worker 会话行本身仍没有选中态。当前需求是「点项目后知道自己在哪个项目」，精确到会话行的选中是另一件事。
- **名单刷新依赖面板广播**：另一个窗口里的项目变更靠窗口聚焦兜底，与原有刷新口径相同。

## 验证

- 单测新增 4 条：`tests/project-panel.test.js` 两条（协调者 / worker / 退役协调者点亮；别的项目、空会话、归属未同步时不亮），`tests/coordinator-session-watch.test.js` 两条（通道就绪后填充名单；项目变更广播后名单跟着刷新）。`npm run check` 599 例全绿。
- 双向验证：把 `isProjectCurrent` 改成恒 `false` → 第一条用例变红，还原后全绿；删掉 `onProjectsChanged` 订阅 → 第二条名单用例变红，还原后全绿。
- 真机（worktree 开发实例，dsh 0.2.1-rc.2，隔离数据根）：恢复协调者会话时项目行显示选中底色；点工作区树里的普通会话 Greeting 后项目行底色消失；再点项目行，协调者会话打开、输入框停靠在底部、头部只有「对话 / 轨迹」两个 View tab、转录为空，无 pageerror、无 console error。模块拆分后重载页面复验，页面无 console 错误。
