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

### 客户端乐观重排，连续拖动串行收尾

拖拽落地先按锚点本地重排（`moveProjectBefore`）再发 `projects/reorder`：远程往返几十毫秒，行停在原处再跳过去会看成「没拖动」。请求成功或失败之后都重拉一次 `projects/list`——成功时拿到宿主算出的顺序与派生字段，失败时用同一份真源把乐观重排撤销掉。

连续拖动走串行队列（`createWriteQueue`）：两笔并发写出时，服务端收到的先后不一定等于用户操作的先后，两次 `projects/list` 的响应也可能倒序到达，界面最后停在哪一份快照上变成碰运气。队列让每一笔等前一笔的请求与收尾都完成再发出，且只有最后一笔做收尾刷新——更早那笔的刷新回来会先把界面退到中间态，再被最后一笔跳回去。面板没有周期刷新（只有窗口 focus），所以这个收敛必须由客户端自己保证。

### 插入线画在项目块上，不是项目行上

落点线是 `data-drop` 挂在 `.dsh-leader-agent-project-block`（行 + 展开的会话列表）上的 `::before` / `::after`，`top` / `bottom` 取 -2px 落进行距缝隙。挂到行上会错：插入点按项目数组排（会话不是独立项），「落在这一行下半」的实际落点是整个块之后，而展开态下行的底边是「行与会话列表」的接缝，线会差出一整个会话列表的高度。

落点判定收在一个纯函数 `projectDropPlan` 里，同时给出锚点与要不要画线：拖到源行本身时不给线（拖起来后指针会从行上划过，线亮着而松手什么都不发生，像上次的落点没清掉）。顺序本来就对、落点在别的行上时线照画，只省掉远程调用。

### 写操作在途时不能拖

`draggable` 在 `renaming` 与 `busy` 时都关掉：重命名时拖拽会抢走输入框的文本选择；删除、改名请求在途时拖动列表会与之交错，看起来像「操作中还能动」。

### 2px 行距照宿主，落点线画在缝里

`.dsh-leader-agent-project-list > * + * { margin-top: 2px }`，与宿主工作区树一致；会话列表容器（`.dsh-leader-agent-project-sessions`）同样加 2px，那里是同一类粘连。落点指示线用项目块上的 `::before` / `::after`，`top` / `bottom` 取 -2px，正好落在行距缝隙里；被拖起的行加 `data-dragging` 压到 0.5 不透明度。

行距是 `> * + *`，不是容器 `gap`：项目列表容器是默认 block 布局（宽侧栏里就是普通文档流），`gap` 在这类容器上不生效，要拉开行距只能用外边距。会话列表虽然是 flex column（`gap` 在那儿等价），但两处共用同一条 `> * + *`、与宿主 `WorkspaceBrowser.module.css` 的 `.groupSection > * + *` 同写法，省掉两套规则。

## 边界

- **没有键盘排序**。HTML5 拖拽之外没有提供「上移 / 下移」入口或快捷键；行也不是可聚焦控件（与既有的选中态一致）。真要做是独立的键盘导航工作，本 PR 不吞下。
- **没有独立的「拖到末尾」投放区**。最后一行的下半区就是末尾，再加一块空白投放区只会和滚动区抢手势。
- **只排项目行，不排项目下的会话行**。会话顺序属于宿主的会话索引 / 工作区，本仓不持有它的真源。
- **拖拽中不禁用行的点击**。浏览器在拖拽结束后不派发 `click`，实测拖完不会顺带打开会话，因此不需要额外的阈值判断。
- **重命名与写操作在途时不可拖**。`draggable` 在 `renaming` 或 `busy` 时关掉：重命名时拖拽会抢走输入框的文本选择；删除、改名请求在途时拖动列表会与之交错。
- **插入线只在行的上下半区更新**。`dragover` 只在行的矩形上触发，指针落到展开后的会话列表区域时不改落点（松开也不会插入）。
- **`openProject` 的 `attachCoordinator` 不走 `busy`，这一轮不补**。它改的是 `workspaceId` 与宿主工作区归属，不是顺序字段；服务端 `move` 与它在同一条 `serialize` 串行链上，不会互相覆盖或丢写。要严格做到「任何写请求在途都不可拖」得为它单独加一个在途标记，而拖拽只是排序、与挂工作区无字段冲突——把 `busy` 摊到所有远程调用上会让「点开项目」这种高频动作把整张列表锁一秒，代价大于收益。真要收口，做法是给 `openProject` 加独立的 `attaching` 标记而不是复用 `busy`。
- **末笔刷新的「闪回一次」不修**。`isLatest()` 在发 `refresh()` 之前求值：末笔的 `projects/list` 在途时用户再拖一笔，那次 `setProjects` 仍会覆盖新一笔的本地乐观重排，界面闪回一次旧顺序，随后被新一笔的串行刷新追上（最终收敛，落盘始终正确）。修法是在刷新结果落地前再判一次 `isLatest()`，但那要求给 `refresh` 加 guard 参数、或让 `reorderProject` 自己拉快照——把「刷新」这件事拆成两份实现，只为一个几十毫秒的窗口。触发条件是「一次 `list` 往返内完成第二次拖拽」，本轮按边界记录。

## 验证

- 单测新增 10 条：`tests/projects-store.test.js` 五条（按落盘顺序列出、移到末尾、原位不写盘、锚点不存在落末尾、项目不存在报错），`tests/project-panel.test.js` 九条（半区锚点、顺序不变返回 null、认不出落点、拖到源行自身不画线、落点在别的行上时线照画、上下半区各自的线与锚点、本地重排与入参不变、串行写入只认最后一笔、失败不堵队列）。`npm run check` 624 例全绿。
- 双向验证（精确撤销 → 变红 → 还原 → 全绿）：
  - `store.move` 的 `const moved = insertAt !== index` 改成 `true` → 「落点与当前位置相同不写盘」变红（`actual: true, expected: false`）；
  - `projectDropAnchor` 去掉 `ids[from + 1] === anchor` 判据 → 「顺序不会变的落点返回 null」变红（`actual: 'c', expected: null`）；
  - `projectDropPlan` 的 `indicator: overId === activeId ? null : …` 改成无条件给线 → 「拖到源行本身不画插入线」变红；
  - `projectDropPlan` 的 `half: side` 固定成 `'before'` → 「线画在落点那一侧的缝里」变红（`half: 'before'` vs `'after'`；before 半区的断言守不住这一处，两条半区都要断）；
  - `createWriteQueue` 的 `push` 改成立即执行、`isLatest` 恒真 → 「连续拖拽串行写入」变红（事件顺序变成 `start:a / start:b / end:a / end:b`）。
- 真机（worktree 开发实例，dsh 0.2.1-rc.2，隔离数据根，Playwright headless Chromium 1440×900）：seed 三个项目 alpha / beta / gamma 后读 DOM——三行 `draggable="true"`，相邻行矩形间距实测 `2px`、`2px`。
  - 真实鼠标拖拽（`mouse.down` → 分步 `mouse.move` → `mouse.up`）把最后一行拖到第一行上半：DOM 顺序变 `gamma / alpha / beta`，`projects.json` 落盘顺序同为 `gamma / alpha / beta`。
  - 拖拽中途读数：被拖行 `data-dragging="true"`，落点块 `data-drop="after"` 且伪元素存在；松手后顺序变 `alpha / beta / gamma`，落盘一致。
  - **插入线落点（展开态）**：展开 beta（块内多出 31px 的会话列表）后把 gamma 拖到 beta 下半——线挂在 `.dsh-leader-agent-project-block` 上，`getComputedStyle(::after)` 得 `bottom: -2px`、`height: 2px`，线所在 y = 块底 `309`，而行的底边是 `278`。同一场景换回旧实现（`data-drop` 在行上）实测 `lineOwner: row`、线 y = `278`——比真实落点高 31px，即整个会话列表的高度。
  - **拖回源行**：指针从 beta 下半移回源行 gamma 的下半，三块的 `data-drop` 全部为 `null`（线随落点清掉）。
  - 全程无 pageerror、无 console error；拖拽没有顺带打开会话（主区域停在原页）。
- **未验证**：触屏与移动端没有实测（HTML5 DnD 在触摸设备上不生效）；项目行在窄导轨浮层里的拖拽同样没有真机复跑，渲染路径与宽侧栏同一份组件；`busy` 时不可拖只做了静态核对（要造成「写请求在途」得让宿主慢响应，没有为此造桩）。
