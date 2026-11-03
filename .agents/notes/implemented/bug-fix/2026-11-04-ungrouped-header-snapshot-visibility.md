# 未分组组头改按会话快照判空，不再读 DOM

## 背景

用户报告：删掉项目目录或工作区后会话「消失」，卸载插件「未分组」就回来。上一次修复（#105）只处理了「项目目录失效后仍排除它的会话」这条，判据仍是 DOM：从 `[data-row-key="workspace:"]` 往上找分组容器，数容器里的会话行，全被隐藏才藏组头。

在 rc.5 的真实数据上验证这条判据不成立。宿主把未分组的组头与会话行分在不同层，`groupSectionOf(header)` 找不到「直接子元素里有 `overflow:` 按钮」的容器时回落到 `header.parentElement`（宿主 `HoverCard` 包出来的 `span`），那个容器里永远没有会话行；再叠上折叠（每组只渲染 5 行 + 展开按钮）与渲染时机，`querySelectorAll('[data-row-key^="session:"]')` 恒为空，判空恒为真。结果是**无条件给组头加 `display: none !important`**——用户看到的是未分组整组消失，卸载插件就回来。

实测读数：修复前组头 `class` 带 `dsh-leader-kit-empty-ungrouped`、`display: none`，而未分组的 `groupSection` 里确实有 0 行可查；同一页面里宿主自己的会话列表（`/api/session/list`）返回 285 条、9 条 `cwd` 指向被删目录且 `blank=false`——数据在，只是 DOM 上查不到。

## 决策

### 判据搬到会话快照

`shouldHideUngroupedHeader` 只问一件事：**未分组里剩下的会话是不是全在排除集里**。这个问题的答案只取决于会话 id 与工作区归属，既不读 DOM，也不复刻宿主的 `sessionVisible`——宿主换一版渲染实现、加一条可见性过滤，都不会让判据失效。

第一版实现曾经是「数还剩几个宿主会渲染的会话，为 0 就藏」，复刻了 `sessionVisible` 的口径。两处不够稳：宿主口径一变，算少了就会把有内容的组藏掉；`sessionRows` 还没到时 `sessionRows` 是空对象，计数恒为 0，又退化成「恒藏」。现在把失败方向固定成多显示——快照未到、组里一条会话都没有、或组里还有空会话时都不藏；只有 subagent 与已归档不参与判定（这两类宿主一定不渲染它们的行）。

`ungroupedExcludedCount`（折叠按钮的数字修正）仍按宿主可见性口径算，与组头判据分开：前者要跟宿主的折叠数字对齐，后者要保证不误藏。

DOM 上只留一条保护：还有可见的「展开其余 N 个会话」就不藏。宁可留一个空组头，也不误伤用户自己的会话。

### 项目列表加低频轮询

`directoryUsable` 只在 `refresh()` 时算，而 `refresh()` 原本只在挂载、通道就绪、窗口聚焦与增删改之后跑。用户在文件管理器或终端里删目录，既不产生会话事件也不产生焦点事件，排除集就一直停在「目录可用」上——`project-directory-gone.e2e.js` 里靠手工派发 `focus` 事件才通过，那个事件正是掩盖缺陷的东西。改成每 5 秒重读一次项目列表，页面不可见时跳过、切回可见立刻补一次。

`refresh` 用 `sameProjectList` 比较渲染字段，值没变就不 `setState` 也不广播——否则每 5 秒都会重渲染整棵项目树并通知右栏。

### 不做的

不在渲染层复刻宿主的渲染时机（折叠、虚拟滚动、分组顺序），也不复刻 `sessionVisible` 的可见性口径。两者都是宿主的实现细节，换一版就要重新对一次；「剩下的会话是否都在排除集里」与两者都无关。

## 边界

- 快照计数依赖 `sessionRows` / `workspaceItems` 的新鲜度：宿主缓存旧值时组头会按旧值显隐一帧。
- 目录状态最坏滞后一个轮询间隔（5 秒）；页面不可见时更久，切回可见立刻补。
- 会话能否「落到未分组」仍由宿主决定（删工作区只删注册，会话记录保留）；本仓只管不把它们藏掉。

## 验证

- 单测：`tests/workspace-exclusion.test.js` 32 条（新增「未分组里剩下的会话全在排除集里才藏组头」「未分组里没有会话、或快照还没到时都不藏组头」「子代理与已归档的会话不参与组头判定」「组头容器里查不到行也按会话快照保留组头」）、`tests/project-panel.test.js` 47 条（新增 `sameProjectList` 的等价判定，含目录失效、顺序变化与旧版宿主无字段）、`tests/projects-service.test.js` 52 条（`directoryUsable` 标注）。`npm run check`：1049 用例通过 / 17 跳过，71 个源文件、55 个被加载、47 个行覆盖 100%；`src/client/workspace-exclusion.js` 行覆盖 85.42%，门槛 84 → 85。
- e2e：`tests/e2e/ungrouped-header.e2e.js` 走界面删工作区造松散会话，断言未分组组头无 `dsh-leader-kit-empty-ungrouped`、`display` 不是 `none`、会话行可见。单跑 3.1 秒；全量串行 6 条全绿。
- 双向验证：让 `shouldHideUngroupedHeader` 恒返回 true（等价于旧的行为）→ e2e 在「未分组里还有会话时不能给组头加隐藏类」变红（`true !== false`）→ 还原 → 变绿。
- `project-directory-gone.e2e.js` 去掉删目录后手工派发的 `focus` 事件后仍然通过（7.6 秒），证明轮询真的兜住了这件事；把轮询间隔调到 60 秒，同一条用例 30 秒超时变红。
