# 项目行行距与拖拽排序

## 背景

左栏项目行是 34px 高的整行底色，行与行之间没有间距：两个相邻项目行都亮过底色时（一个 hover、一个选中），两块圆角矩形贴在一起，看上去是一整块。宿主的工作区树在同样位置留了 2px（`WorkspaceBrowser.module.css` 的 `.groupSection > * + *`），本仓抄了行高与内边距却没有抄这一条。

项目列表的顺序也只能由建项时间决定：`store.list()` 按 `createdAt` 升序返回，用户没有任何办法把常用的项目挪到前面。宿主的工作区早就支持拖拽排序，用户照着那个预期去拖项目行，什么都不会发生。

## 决策

### 数组顺序就是显示顺序，不另存序号

`projects.json` 里的 `projects` 数组顺序即左栏显示顺序：`list()` 不再按 `createdAt` 排序，新建项目 push 到末尾。新加的 `store.move(id, beforeId)` 在写串行链里把记录 splice 到锚点之前（DOM insertBefore 语义，空串表示末尾），落点与当前位置相同则不写盘。

没有加 `order` 数字字段：数组本身已经是有序容器，再存一份序号要处理「老记录没有 order」「重排时重编号」「两种顺序混排」三件事，而这些迁移成本换不到任何东西。老数据天然兼容——它们本来就是按建项时间 push 进去的。

`move` 的锚点在并发删除后可能已经不存在，这时落到末尾而不是报错：拖拽的目标没了，用户无从修复，报错只是把一次正常的操作变成一次红色提示。

### 落点判定与宿主工作区同一套半区规则

拖到目标行的上半插到它之前、下半插到它之后（即下一项之前），落在最后一行下半就是末尾。判定抽成纯函数 `projectDropAnchor(projectIds, activeId, overId, half)`，返回锚点项目 id，**顺序不会变时返回 null**——拖回原处是常见动作，客户端不该为它发一次远程调用。

「末尾」用空串表达而不是 `undefined`：远程协议的入参在客户端侧有严格 codec（`project-remote.js` 的 `stringCodec`），`undefined` 会在本地被拒掉，所以 `beforeId` 的取值域是「项目 id 或空串」。

### 客户端乐观重排，收尾以宿主快照为准

拖拽落地先按锚点本地重排（`moveProjectBefore`）再发 `projects/reorder`：远程往返几十毫秒，行停在原处再跳过去会看成「没拖动」。请求成功或失败之后都重拉一次 `projects/list`——成功时拿到宿主算出的顺序与派生字段，失败时用同一份真源把乐观重排撤销掉。

### 2px 行距照宿主，落点线画在缝里

`.dsh-leader-kit-project-list > * + * { margin-top: 2px }`，与宿主工作区树一致；会话列表容器（`.dsh-leader-kit-project-sessions`）同样加 2px，那里是同一类粘连。落点指示线用行上的 `::before` / `::after`，`top` / `bottom` 取 -2px，正好落在行距缝隙里；被拖起的行加 `data-dragging` 压到 0.5 不透明度。

行距是 `> * + *`，不是容器 `gap`：项目行的外层还包着展开的会话列表，`gap` 会连「项目块与其会话列表」之间也拉开距离。

## 边界

- **没有键盘排序**。HTML5 拖拽之外没有提供「上移 / 下移」入口或快捷键；行也不是可聚焦控件（与既有的选中态一致）。真要做是独立的键盘导航工作，本 PR 不吞下。
- **没有独立的「拖到末尾」投放区**。最后一行的下半区就是末尾，再加一块空白投放区只会和滚动区抢手势。
- **只排项目行，不排项目下的会话行**。会话顺序属于宿主的会话索引 / 工作区，本仓不持有它的真源。
- **拖拽中不禁用行的点击**。浏览器在拖拽结束后不派发 `click`，实测拖完不会顺带打开会话，因此不需要额外的阈值判断。
- **重命名时不可拖**。`draggable` 在 `renaming` 时关掉：拖拽会抢走输入框的文本选择。

## 验证

- 单测新增 9 条：`tests/projects-store.test.js` 五条（按落盘顺序列出、移到末尾、原位不写盘、锚点不存在落末尾、项目不存在报错），`tests/project-panel.test.js` 四条（半区锚点、顺序不变返回 null、认不出落点、本地重排与入参不变）。`npm run check` 619 例全绿。
- 双向验证（精确撤销 → 变红 → 还原 → 全绿）：
  - `store.move` 的 `const moved = insertAt !== index` 改成 `true` → 「落点与当前位置相同不写盘」变红（`actual: true, expected: false`）；
  - `projectDropAnchor` 去掉 `ids[from + 1] === anchor` 判据 → 「顺序不会变的落点返回 null」变红（`actual: 'c', expected: null`）。
- 真机（worktree 开发实例，dsh 0.2.1-rc.2，隔离数据根，Playwright headless Chromium 1440×900）：seed 三个项目 alpha / beta / gamma 后读 DOM——三行 `draggable="true"`，相邻行矩形间距实测 `2px`、`2px`。
  - 真实鼠标拖拽（`mouse.down` → 分步 `mouse.move` → `mouse.up`）把最后一行拖到第一行上半：DOM 顺序变 `gamma / alpha / beta`，`projects.json` 落盘顺序同为 `gamma / alpha / beta`。
  - 拖拽中途读数：被拖行 `data-dragging="true"`，落点行 `data-drop="after"` 且伪元素存在；松手后顺序变 `alpha / beta / gamma`，落盘一致。
  - 全程无 pageerror、无 console error；拖拽没有顺带打开会话（主区域停在原页）。
- **未验证**：触屏与移动端没有实测（HTML5 DnD 在触摸设备上不生效）；项目行在窄导轨浮层里的拖拽同样没有真机复跑，渲染路径与宽侧栏同一份组件。
