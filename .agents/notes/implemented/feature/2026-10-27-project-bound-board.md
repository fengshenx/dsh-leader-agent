# 看板按项目组织

**范围**：`src/host/cards/store.js`、`src/host/tools/cards.js`、`src/host/projects/service.js`、`src/host/projects/remote.js`、`src/shared/projects.js`、`src/client/board.js`、`src/client/board-projection.js`、`src/client/project-board-data.js`、`src/client/project-board-monitor.js`、`src/client/index.js`、`src/host/cards/card-list-view.js`

## 背景

两条需求：「看板是和项目绑定的，一个项目一个看板，不是全局的」与「创建 Card 后，能否直接让右 sidebar 打开看板？」

原先的看板是**会话维度**的：从当前会话的事件窗口里重放 `tool/result` 事件的 `meta`，还原卡片投影。同一会话建的卡都在这儿，别的会话建的卡看不见。看板挂在右栏的「看板」tab 上，用户要点开才有。

## 决策

**看板的数据源从会话事件流换成宿主卡片库**。事件流重放有两个硬伤：一是跨会话聚合做不到（worker 会话建的卡在 worker 的事件窗口里，不在协调者的窗口里）；二是 worker 会话被宿主回收后事件窗口会丢，卡片随之从看板上消失。卡片真源本就在宿主的 `cards.json`，读它才是读事实。`board-projection.js` 里的事件重放逻辑整段删除（`applyEntries` / `applyEventChange` / `collectCards` / `loadHistory` 等 169 行），只留不依赖数据来源的部分：信号灯档位、排序、停滞判定、chip 排布。

**卡片归属由宿主按调用方会话判定，模型不传项目参数**。模型未必知道自己在哪个项目的语境里调用工具，会话这一侧的事实更可靠。`create_card` 时宿主按调用方的 session id 反查项目，把 `projectId` 写进卡片记录。

**归属判据分两种**：

- 协调者会话走项目注册表里的指针（`coordinatorSessionId`），这是显式绑定，最准。
- 其它会话按 cwd 与项目目录的 realpath 相同判定。worker 会话的 cwd 就是项目目录，用户在项目目录里手动开的会话也是——它们做的都是这个项目的事。

这与项目树的口径**不同**是刻意的：项目树回答「这个项目有哪些 worker」，因此只认 worker 身份（判据见 [项目树只列 worker 会话](2026-10-27-project-tree-worker-sessions.md)，2026-10-29 起按登记表判，不再看会话头标记）；卡片归属回答「这个项目的任务」，因此只认目录一致。同一个目录里用户自己开的会话不是 worker，但它建的卡仍然是这个项目的任务。

**归属判定要等索引重建完**。项目注册表是异步落盘的，进程内的索引是读路径的镜像，启动时重建。重建没完就判归属会得到「不归属任何项目」，卡片会静悄悄地丢归属——数据丢了还查不出原因。判定前等索引就绪。

**编号作用域不变（全局递增）**。项目看板按项目过滤，编号会有空洞，但全局唯一，`@#n` 不歧义——比按项目编号更好。将来若要按项目编号，见[卡片存储与编号作用域](../architecture/2026-10-23-card-storage-and-numbering-scope.md) 里的迁移代价。

**存量卡片不迁移**。卡片记录里没有创建会话 id，无法可靠反推归属。它们不出现在任何项目看板，`list_cards`（`scope=all`）仍可见。这是明确的取舍，不是遗漏。

**跨项目改卡拒绝，无归属的存量卡不拦**。有归属的卡被别的项目改就是越界；没有归属可冲突的存量卡拦下来只会让它永远改不动。判据是「卡片归属必须等于调用方所在项目」——调用方不在任何项目里（范围是空串）同样改不了有归属的卡，否则项目外的会话能改任何项目的卡，是个洞。

**自动打开的判据是「新增卡片 id」而非内容变化**。改一张卡不值得把看板弹到用户面前打断ta，只有项目里多了一张卡才值得。

**监视器跟随「屏幕上的会话」而非全局**。不属于项目的会话没有项目看板可开；用 `sidebarRight.mounted` 拿当前屏幕会话。

**轮询而非事件订阅**。卡片可能由 worker 会话建，那边的事件流不在屏幕会话的窗口里；卡片真源在宿主项目通道里，按项目拉一次就能看见。间隔 2 秒，本地 server 成本可忽略。窗口重新获得焦点时立刻刷一次。

**惰性解析项目 + 下一轮重试**。项目通道的挂载是异步的，第一轮解析失败不该就此放弃，下一轮再试。

**打开前先查已有 tab**。官方文档明确要求（`packages/experimental/creation-recommendations/references/sidebar-right.md`）：开 tab 前先看 `sidebarRight.openTabs` 里有没有同 kind 的 tab，有就 `focus` 它，没有才 `openTab`。否则每次建卡都会新开一个。

## 边界

- **没有项目会话的看板是空的**：面板显示「当前会话不属于任何项目 / 看板按项目组织：在项目协调者会话里打开它。」
- **存量卡不进任何项目看板**，只能靠 `list_cards`（`scope=all`）看到。
- **`list_cards` 默认只看本项目**（`scope=project`），要跨项目看得显式传 `scope=all`。
- **看板轮询是 2 秒的固定间隔**，不是推送。窗口切走时仍然轮询。
- **卡片归属判据依赖 cwd**：会话不在项目目录里跑，就不属于那个项目。

## 取证

- **单元测试**：`npm run check` 289 例全绿。新增用例覆盖：建卡写入项目归属、无项目时无归属、`list_cards` 默认本项目与 `scope=all` 跨项目、跨项目改卡被拒绝、项目外的会话改不了有归属的卡、无归属存量卡仍可改、按项目列卡时无归属卡不进任何项目、改卡不改变归属、协调者按指针归属 / worker 按 cwd 归属 / 目录不同不归属、符号链接写法归同一项目、删项目后不再归属、索引重建在飞时归属判定等重建。
- **回归有效性双向验证**：逐条回退实现（`store.list` 的 projectId 过滤、`update_card` 的跨项目拦截、`create_card` 的归属写入、`resolveProjectOfSession` 的 cwd 判定、`newCardIds` 的 id 去重、归属判定前的 `await indexReady`、项目外改卡的拦截），对应用例逐一失败；还原后全绿。
- **真实实例（mock LLM，隔离 DSH_HOME）**：建卡后右栏自动出现「看板」tab，渲染 4 张 active 卡 + 「已完成 1」；手动收起右栏后再建卡，看板自己回来了；卡片落盘带 `projectId` 与 `createdBy`；注入一张属于别的项目的卡（`projectId: 9999…`），它在卡片库里但不在本项目看板上；console 无报错。
