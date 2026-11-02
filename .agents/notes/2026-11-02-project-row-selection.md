# 项目行选中态与协调者名单刷新

## 背景

新建项目后点项目行，主区域能打开协调者会话，但左栏项目行没有任何选中反馈：用户看不出「当前主区域属于哪个项目」，只能靠会话标题推断。项目行从来只有 hover 与「更多」菜单打开两种底色，没有跟随当前会话的状态。

同一路径上还有一个时序缺口：协调者会话名单只在通道就绪与窗口重新获得焦点时刷新。同窗口新建项目（或换新协调者）之后名单里没有新会话 id，紧接着点开项目，主区域会回到居中的欢迎页——输入框不在底部，转录里也没有任何内容。

## 决策

### 选中态口径与「项目会话」一致：退役协调者、已归档会话不算

判据抽成 `isProjectCurrent(project, sessionIds, currentSessionId, archivedSessionIds)`：当前会话是项目的现任协调者，或落在宿主判定的该项目会话集合里、且不是退役协调者、也不在归档集合里，项目行才算选中。

`sessionsByProject` 列的是「项目下有哪些会话」，退役协调者与 worker 同列（#34/#36 之后）——直接拿它判选中，点开退役会话或归档会话时项目行也会亮，而点这一行打开的是现任协调者：「本行就是当前内容」变成「当前内容在这一组、点本行去别处」。这与 `project-board-data.js` 的 `boardViewState` 口径相反（那里明文把退役会话判成 `not-viewable`），两处必须同一口径。退役判定复用 `isRetiredCoordinatorSession`，不另写一份。

### 选中态只带 `aria-current`，不宣称 `role="tree"`

样式照官方会话行：`--dsw-alias-interactive-bg-hover` 常驻底色，行上带 `data-selected` 与 `aria-current="true"`（`aria-current` 是全局属性，语义是「当前项」，不承诺点击即到本项）。

原实现给容器加 `role="tree"`、给项目行加 `role="treeitem"` + `aria-selected`，但树里只有项目行是 `treeitem`：展开后的会话行是 generic div、空态与「展开其余」按钮不在任何 `treeitem` 内、项目行本身也没有 `tabindex`。这构成一个非法且键盘不可达的树——比没有更糟。补齐需要 roving tabindex、方向键、把非 `treeitem` 后代挪出树，是独立的键盘导航工作，本 PR 不吞下，因此撤掉树上角色，只保留 `aria-current` 这一条真实成立的语义。

### 名单刷新挂到项目变更广播，三条订阅一并退订

`watchCoordinatorSessions` 订阅已有的 `onProjectsChanged`（左栏每次增删改项目成功后广播）。没有把「建项目后手动推新 id」写进建项路径：换新协调者同样会换掉名单里的 id，广播是这两条路径共同的出口，挂一处就不会漏。

`onProjectRemoteReady` 的退订函数以前被丢弃。remote 服务重新注册会让 `ctx.inject` 的 fiber 重建，ready listener 永久累积：每次通道就绪多打一次 `projects/list`，闭包还攥着已销毁的 ctx。三条订阅（ready / focus / 项目广播）现在都在 effect 清理里退订。

### 切会话时跳过归属防抖

`sessionsByProject` 的刷新是 1 秒防抖的（会话事件很密，逐条打远程调用不可取）。但打开刚派工的 worker 时归属表里可能还没有它：等防抖意味着先渲染一帧「哪个项目都不亮」，底色晚一秒才出现。当前会话 id 变化时直接重问一次归属，其余事件仍走防抖。

## 边界

- **不跟宿主的 `panelActive`**：右栏面板打开时宿主认为主区域没有当前会话，本仓仍按 `retainedBy.mainView > 0` 判定。这与 `quietWorkspaceOf` 的既有取舍一致——多亮的只是一层底色，不改变任何行为。
- **只点亮项目行，不点亮项目树里的会话行**：worker 会话行本身仍没有选中态。当前需求是「点项目后知道自己在哪个项目」，精确到会话行的选中是另一件事；项目行也仍不是键盘可聚焦控件（点击路径是 div + onClick，与改前一致），可访问性只保证「当前项」这条语义不说谎。
- **名单刷新依赖面板广播**：另一个窗口里的项目变更靠窗口聚焦兜底，与原有刷新口径相同。
- **worker 路径仍有一次远程往返**：切会话时立即重问归属，但判据本身在宿主侧（浏览器没有文件系统，做不了路径归一），这一帧仍可能先渲染成未选中。

## 验证

- 单测新增/改写 5 条：`tests/project-panel.test.js` 三条（协调者与 worker 点亮；退役协调者、归档会话、被归档的现任协调者不亮；别的项目、空会话、归属未同步时不亮），`tests/coordinator-session-watch.test.js` 三条（通道就绪后填充名单；项目变更广播后名单跟着刷新；卸载后 ready 与广播都不再触发刷新）。`npm run check` 601 例全绿。
- **用例可单独跑**：三条名单用例各自 `node --test --test-name-pattern` 单跑均绿（改前第二条依赖第一条留下的订阅与单例，单独跑必红）。假件按宿主真实 API 面构造：window 监听按 type 存 listener 集合、`removeEventListener` 按 listener 精确移除。
- 双向验证（精确撤销 → 变红 → 还原 → 全绿）：
  - 去掉 `isRetiredCoordinatorSession` 分支 → `actual: true, expected: false`；
  - 去掉归档集合分支 → `actual: true, expected: false`；
  - 去掉 `stopReady()` → 退订用例 `actual: 2, expected: 1`（dispose 后再就绪多打一次 RPC）；
  - 去掉 `onProjectsChanged` 订阅 → 广播用例单跑 `actual: ['s-1'], expected: ['s-1','s-2']`。
- 真机（worktree 开发实例，dsh 0.2.1-rc.2，隔离数据根）：恢复协调者会话时项目行显示选中底色；点工作区树里的普通会话 Greeting 后项目行底色消失；再点项目行，协调者会话打开、输入框停靠在底部、头部只有「对话 / 轨迹」两个 View tab、转录为空，无 pageerror、无 console error。模块拆分后重载页面复验，页面无 console 错误。
- **未验证**：退役协调者与归档会话不点亮、worker 路径切会话后立即重问归属，这两条改动都没有真机复跑（需要换过协调者的项目和刚派工的 worker 两个现场）；上面的结论来自用例与代码路径。
