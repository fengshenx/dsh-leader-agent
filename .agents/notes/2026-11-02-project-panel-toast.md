# 项目区块的提示改为一次性 toast

**状态**：current（2026-11-02）
**范围**：`src/client/toast.js`、`src/client/toast-view.js`、`src/client/project-panel.js`、`src/client/project-panel-logic.js`、`src/client/project-section.js`、`src/client/index.js`、`tests/project-panel.test.js`、`README.md`

## 背景

左栏项目区块原有一套常驻提示：一个 `notice` state，渲染在区块尾部，直到下一次操作才清空。失败消息挤在那里还算合理，但删除成功也往里塞一句「已删除项目「X」。文件夹与会话记录保留。」——项目行当场消失后，这句话还一直挂在侧栏里，用户反馈「太诡异」。常驻位置还会把「一次性的失败」说成「持续的状态」，与真实的持续性状态（项目通道未就绪）混在一起。

## 决策

- **常驻提示行整个去掉**：`setNotice` 与 `notice` state 一并删除，区块尾部不再渲染任何提示。
- **一次性消息改走 toast**：新增 `src/client/toast.js`（状态）与 `src/client/toast-view.js`（渲染），挂在宿主 `shell.overlay` 槽位——那是宿主留给「徽标、toast 栈、状态药丸」这类跨栏浮层的座位，窄侧栏收起项目浮层时提示仍然可见。形态照宿主自带 Toast：顶部居中、暗色表面、不拦截点击，停留 4 秒后淡出。
- **同一时刻只留一条**：新消息替换旧消息并重启计时，订阅者按 id 撤销——旧提示的淡出计时器晚到时不会把刚弹出的那条撤掉。
- **删除成功给一句回执**：「已删除项目「X」。」，走同一条提示条，几秒后消失。常驻才算噪音，一次性回执不是。工作区真摘除失败时在回执后面带上原因；`notFound` 走幂等成功，回执不提工作区。
- **「项目通道未就绪」留在区块内，不改成 toast**：它是持续状态，不是一次性消息；弹一下就消失只会让用户以为问题已经过去。这行常显在列表上方，不随列表折叠消失；就绪后自动换成项目列表。
- **自绘而不复用宿主组件**：宿主没有一行式的 toast API——`workspace.toast` 是 keyed 槽位，key 只认工作区自己的通知；`ui-primitives` 的 `Toast` 在宿主内部包里，本仓不 import 宿主内部包（见 AGENTS.md）。所以自带一个同形态的提示条，样式变量走宿主的 `--dsw-alias-toast-*`。

## 边界

- 覆盖了[项目删除合并为一个入口](2026-10-30-project-delete-merged.md)里「删除成功提示分三支」的设计：三支合并为「一句回执 + 工作区摘除失败时带原因」。
- 提示条不堆叠：连续两条消息只看到最新一条。项目面板的操作受 `busy` 串行，并发两条错误只在挂载/聚焦时读取失败这种场景出现，丢一条可以接受。
- 提示条不带动作按钮（宿主 Toast 有 `actions` 座位）：本插件目前没有「撤销」类操作需要它。

## 宿主槽位依赖：`shell.overlay`

提示条整个挂在宿主 `shell.overlay` 槽位上。`ctx.slots.inject` 在槽位从未声明时回调永不执行（rc.2 `packages/client/ui-renderer/src/client/registry.ts` 的语义），不抛错、不告警——槽位缺失时所有失败消息静默丢弃，界面上只剩「点了没反应」。rc.2 的 web-app 声明了该槽位（`packages/client/ui-layout/src/client/index.ts`，`AppFrame` 渲染），所以当前不是故障；但常驻提示行已经删除，宿主将来若改名或移除该槽位，故障现象就是「提示全没了」。定位这类问题时先看 `src/client/index.js` 的 `slots.inject('shell.overlay', …)`。

## 审查后的修复（PR #33 复审）

- **状态行移出列表折叠**：`remoteStatus` 原先落在 `listExpanded ? … : null` 之内，收起列表就整行消失。现由 `projectSectionLayout` 判定：状态行常显，列表内容（空态或项目行）与状态行互斥——通道坏着时说「还没有项目」是误导。回归用例见 `tests/project-panel.test.js`。
- **重命名校验失败保留编辑态**：提交判定抽成 `planProjectRename`。校验失败返回 `keep`，`ProjectRow` 保留输入框并在行下就地显示原因；名字没改返回 `close`，不打扰宿主；合法才 `commit`。接口失败仍走提示条：那不是输入能改好的问题，提示条给出具体原因，行上名字仍是旧值。
- **双向验证**：把状态行改回跟 `listExpanded` 走 → 状态行用例变红；删掉 `planProjectRename` 的校验分支 → 重命名用例变红；两处还原后全绿。

## 取证

- **单测**：`npm run check` 522 例全绿（`tests/toast.test.js` 4 例；本轮复审新增 3 例回归：状态行 2、重命名 1）。
- **双向验证（单测）**：去掉 `showToast` 的空串守卫 → 「空字符串不弹提示」变红；去掉 `dismissToast` 的 id 比对 → 「旧提示的计时器撤不掉新提示」变红；把 `describeDeletionNotice` 的成功支改回空串 → 6 例变红（4 条真实链路、notFound、纯函数各一）；三处还原后全绿。
- **真机（修复前读数）**：`.dev/home` 隔离实例（`DEV_PORT=3292`），seed 一条项目记录：
  - 点「更多」→「重命名」，输入 201 个字符后回车 → 顶部出现 `role="alert"`「项目名过长（上限 200 字）」，项目区块内没有提示行；6 秒后快照里 `alert` 消失。**本轮复审已改**：校验失败不再弹提示条，输入框与原因留在行内。
  - 点「更多」→「删除」→「删除」：项目行消失、列表回到「还没有项目」空态，顶部出现 `role="alert"`「已删除项目「probe-toast」。」；6 秒后快照里 `alert` 消失。
  - 「更多」按钮是 hover-only，无头浏览器里点不到；取证期间临时把 `.dsh-leader-kit-project-actions` 改为常显，取证后已还原（该文件不在本次 diff 内）。
- **未覆盖**：「项目通道未就绪」状态行的真机画面——需要宿主不提供 remote 服务的组合，本轮用代码路径与既有行为推断；它只是把原来拼在 notice 里的文案挪到列表位置，未改判定。复审新增的折叠态与行内错误也未做真机复核，仅单测覆盖。

