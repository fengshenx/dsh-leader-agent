# 项目行选中态与协调者名单刷新

## 背景

新建项目后点项目行能打开协调者会话，但左栏项目行没有任何选中反馈，用户只能靠会话标题推断主区域属于哪个项目；同一路径上还有时序缺口——协调者名单只在通道就绪与窗口聚焦时刷新，同窗口新建项目或换新协调者之后名单里没有新 id，紧接着点开项目会落到居中的空欢迎页。

## 决策

### 选中态口径与「项目会话」一致：退役协调者、已归档会话不算

> **部分已被 [项目树里被打开的 worker 会话有自己的选中态](2026-11-02-project-tree-session-selected.md) 取代**：worker 会话打开时项目行不再铺整行底色，只点亮行首文件夹；整行选中只留给 leader 会话。本节其余判据（退役、归档不算）与名单刷新、三条退订、切会话跳过防抖仍有效。

- 判据是 `isProjectCurrent`：当前会话是项目的现任协调者，或落在宿主判定的该项目会话集合里、且不是退役协调者、也不在归档集合里——整行底色只给现任协调者，其余项目会话只点亮行首文件夹。
- `sessionsByProject` 列的是「项目下有哪些会话」，退役协调者与 worker 同列，直接拿它判选中会点亮退役或归档会话，而点这一行打开的是现任协调者。这与 `boardViewState` 把退役会话判成 `not-viewable` 同一口径，退役判定复用 `isRetiredCoordinatorSession`，不另写一份。

### 选中态只带 `aria-current`，不宣称 `role="tree"`

- 行上带 `data-selected` 与 `aria-current="true"`（全局属性，语义是「当前项」），样式照官方会话行。
- 撤掉容器 `role="tree"` 与行 `role="treeitem"` + `aria-selected`：树里只有项目行是 `treeitem`，展开后的会话行是 generic div、空态与按钮不在任何 `treeitem` 内、项目行也没有 `tabindex`，构成一个非法且键盘不可达的树。补齐需要 roving tabindex 与方向键，是独立的键盘导航工作。

### 名单刷新挂到项目变更广播，三条订阅一并退订

- `watchCoordinatorSessions` 订阅已有的 `onProjectsChanged`，而不是在建项路径手动推新 id：换新协调者同样会换掉名单里的 id，广播是这两条路径共同的出口，挂一处就不会漏。
- ready / focus / 项目广播三条订阅都在 effect 清理里退订：`onProjectRemoteReady` 的退订函数以前被丢弃，remote 服务重新注册会让 fiber 重建、ready listener 永久累积——每次通道就绪多打一次 `projects/list`，闭包还攥着已销毁的 ctx。

### 切会话时跳过归属防抖

- `sessionsByProject` 的刷新是 1 秒防抖（会话事件很密，逐条打远程调用不可取），但打开刚派工的 worker 时归属表里可能还没有它，等防抖会先渲染一帧「哪个项目都不亮」。当前会话 id 变化时直接重问一次归属，其余事件仍走防抖。

## 边界

- **不跟宿主的 `panelActive`**：右栏面板打开时宿主认为主区域没有当前会话，本仓仍按 `retainedBy.mainView > 0` 判定；多亮的只是一层底色，不改变任何行为。
- **整行选中只给 leader**：worker 会话打开时项目行只亮行首文件夹、会话行自己铺底色（见取代笔记）。项目行不是键盘可聚焦控件（div + onClick，无 `tabindex`），可访问性只保证「当前项」这条语义不说谎。
- **名单刷新依赖面板广播**：另一个窗口里的项目变更靠窗口聚焦兜底，与原有刷新口径相同。
- **worker 路径仍有一次远程往返**：切会话时立即重问归属，但判据本身在宿主侧，这一帧仍可能先渲染成未选中。

## 验证

`tests/project-panel.test.js` 与 `tests/leader-session-watch.test.js`。双向：去掉退役或归档分支 → 对应用例红；去掉 `stopReady()` → 退订用例红（dispose 后再就绪多打一次 RPC）。三条名单用例可各自单跑，不依赖前一例留下的订阅与单例。
