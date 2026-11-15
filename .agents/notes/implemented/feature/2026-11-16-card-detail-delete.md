# Agent Note: 卡片详情补人工删除入口

Status: implemented

## Problem

卡片详情浮层此前只有链接编辑：看板经 `updateCardLinks` 整体替换 `links`，完成、置顶、重命名仍归 leader 的卡片工具，删除没有入口。误建、重复或彻底废弃的卡只能留在卡片库里，或者退而求其次标成 `archived`。用户要在详情里直接删掉一张卡，而不是先让模型调工具。

删除是破坏性动作，语义必须和卡片库一致：硬删、不可撤销、编号不复用、槽位绑定释放。卡片编号是 `@#n` 的引用标识，回收后同一个编号会指向另一件事；归档保留记录，不能代替删除。

## Decision

### 远程方法，不是工具

详情按钮由浏览器点击，写通道只能走本仓已有的 Typert `projects` 命名空间。新增 `deleteCard(id)`，宿主侧转调 `cards.remove`；模型工具面完全不动，worker/普通会话的工具权限也不受影响。

能删卡的是人，不是模型。若以后要让模型也能删，需要另加工具并复用同一套删除校验，不能把远程方法直接暴露成工具。

### 硬删并保留 counter

`cards.remove` 从 `cards.json` 摘掉记录，`counter` 原样保留，下一张卡继续用新号。删除后重建槽位索引与卡片事实索引：卡上的槽位绑定随卡片一起失效，下一轮注入不会再把不存在的卡送给会话。

卡片不存在时 `remove` 返回 `undefined`，远程方法返回 `{removed:false, notFound:true}`，界面按幂等成功收尾。详情浮层拿的是打开瞬间的快照，别人先删掉是正常并发；把「已经不存在」报成删除失败，只会让确认框卡住。

### 详情页脚与二次确认

删除入口放在详情浮层页脚，与正文用发丝线隔开，使用错误色和 `trash-outline` 图标；链接编辑态下不显示，避免用户一边改链接一边误删。归档卡仍可删除——用户要清掉一张不该存在的卡时，状态不该反过来阻止删除。

确认框复用项目面板的 `ConfirmDialog`，由看板持有状态。确认框打开时详情浮层先卸载：两层 modal 同时监听 Escape、各自做焦点陷阱，会让一次 Escape 关掉两层、Tab 在两层之间抢焦点。取消后详情按原 anchor 重新打开；删除成功后看板立刻摘卡并关闭详情。

### 删除不校验 revision

详情里的 `revision` 是打开时的快照。用它做 `expectedRevision` 会在 leader/worker 改过卡后稳定冲突，而用户表达的意图是「这张卡现在删掉」；删除按 id 执行，不依赖快照版本。卡片已不存在时幂等成功，这一点与面板的链接编辑不同——链接编辑仍会把冲突原样报出来。

### 旧轮询快照不能复活已删卡

删除成功时把卡片 id 记进看板本地集合，轮询响应合并后过滤掉这些 id。删除前已发出的取数请求可能带着旧快照晚到，不过滤会让卡片在 2 秒轮询周期里短暂重现，用户会以为删除没生效。卡片 id 不复用，集合在会话生命周期内不需要清；换会话时随面板重置清空。

## Alternatives considered

- **新增模型工具 `delete_card`**：最初的实现方向，给 leader 一个带 `expectedRevision` 的删除工具。用户明确否掉了它——人工删除不应变成模型能力，工具面还要为这个动作增加一层身份裁剪。最终只保留浏览器侧的远程方法。
- **软删除 / 只允许归档**：归档保留完整记录，随时可查，但用户要的是「从卡片库消失」；把归档当删除会让看板和卡片库继续背着废卡。硬删接受编号空洞，换取语义直接。
- **把确认框嵌在 `CardDetail` 内部**：调用方不用把待删卡提出来，但两层 modal 会同时监听 Escape、各自做焦点陷阱；一次 Escape 关掉两层、Tab 在两层之间抢焦点。改为看板持有确认框、确认期间卸载详情。
- **删除带 `expectedRevision`**：能防止覆盖别人的并发修改，但详情里的 revision 是打开时的快照，leader/worker 改过卡后删除会稳定冲突；删除按 id 的语义更接近用户意图。已不存在按幂等成功，不把并发删除报成失败。
- **只靠 2 秒轮询让卡片消失**：实现最少，但删除后卡面仍会停留最多 2 秒，用户会以为没删掉；本地摘卡加 id 过滤，立刻消失且不会被晚到的旧快照复活。

## Consequences

- 人获得了一个不可逆的删除入口；卡片库、槽位绑定和卡片事实索引立即一致，编号不会复用。
- 模型仍然不能删卡，工具权限和 leader/worker 的工具面没有变化；代价是删除只能由人在看板上点出来。
- 删除没有恢复、审计或 tombstone；需要保留历史只能用归档。删掉的最高编号不会被下一张卡补上，`list_cards` 会看到编号空洞。
- 删除不会停掉槽位上的 worker：索引释放后下一轮不再注入卡片事实，但会话本身仍在跑。
- 远程方法没有项目归属校验，和 `updateCardLinks` 同一条单机单用户取舍；任何项目会话的看板都能点删除，按钮不按 leader/worker 隐藏。若以后要限制，需要在面板按角色隐藏。
- 确认期间详情卸载，取消后重开，滚动位置会丢；删除入口在链接编辑态隐藏，正常路径没有未保存内容。

## Testing

- 单测：`cards-store` 新增 3 例（移除与编号不复用、索引释放、不存在时返回 `undefined` 且不落盘），`projects-remote` 新增 1 例（正常删除与幂等 `notFound`），`card-detail-view` 新增 2 例（可删判据与确认文案），`board-projection` 新增 1 例（从列表摘卡）。全量 `npm run check`：1134 个用例通过（17 skipped，含本次双格式门禁新增的 6 例），61 个被单测加载的文件里 53 个行覆盖 100%；`src/host/cards/store.js` 与 `src/host/projects/remote.js` 的新增行都被覆盖。
- e2e：`DSH_PROFILE=web node --test tests/e2e/board-card-delete.e2e.js` 通过。真实宿主里种两张卡，打开详情看到页脚「删除卡片」；点开确认框时详情收起，取消后详情重开、两张卡都在；再次确认后待删卡从看板消失，`cards.json` 只剩另一张卡；页内无 `pageerror` / `console.error`。截图在 `.dev/e2e-artifacts/board-card-delete-<pid>/`（不入库）。
- 双向验证（撤销 → 对应用例变红 → 还原 → 全绿）：
  1. `store.remove` 不 `splice` → `cards-store` 2 例红（移除与索引释放）。
  2. `store.remove` 去掉 `rebuildIndexes` → `cards-store` 索引释放 1 例红。
  3. `deleteCard` 对不存在卡片也返回 `removed:true` → `projects-remote` 的幂等断言红。
  4. `CardDetail` 去掉页脚删除按钮 → e2e 等待 `.dsh-leader-agent-card-detail-delete` 超时（37.0s 红）。
- 本机 `DSH_PROFILE` 是 `desktop`，其源 profile 没装本插件；直接跑 e2e 时项目区块不会挂载，`main` 同样复现。e2e 必须显式 `DSH_PROFILE=web`，这不是本次改动引入的。
- `npm run build:client` 通过（客户端改动必须重建后再跑 e2e）。
