# 卡片详情补人工删除入口

**范围**：`src/host/cards/store.js`、`src/host/projects/remote.js`、`src/shared/projects.js`、`src/client/{board,card-detail,card-detail-view,board-projection,board-styles}.js`、`tests/`、`docs/`、`README*.md`

## 背景

卡片详情浮层此前只有链接编辑：看板经 `updateCardLinks` 整体替换 `links`，完成、置顶、重命名仍归 leader 的卡片工具。用户要在详情里直接删掉一张卡，而不是先让模型调工具；本次补的是这条**人工入口**，不加模型工具。

删除是破坏性动作，语义必须和卡片库一致：硬删、不可撤销、编号不复用、槽位绑定释放。卡片编号是 `@#n` 的引用标识，回收后同一个编号会指向另一件事；归档则保留记录，不能拿来代替删除。

## 决策

### 远程方法，不是工具

详情按钮由浏览器点击，写通道只能走本仓已有的 Typert `projects` 命名空间。新增 `deleteCard(id)`，宿主侧转调 `cards.remove`；模型工具面完全不动，worker/普通会话的工具权限也不受影响。

这样做的边界很明确：能删卡的是人，不是模型。若以后要让模型也能删，需要另加工具并复用同一套删除校验，不能把远程方法直接暴露成工具。

### 硬删并保留 counter

`cards.remove` 从 `cards.json` 摘掉记录，`counter` 原样保留，下一张卡继续用新号。删除后重建槽位索引与卡片事实索引：卡上的槽位绑定随卡片一起失效，下一轮注入不会再把不存在的卡送给会话。

卡片不存在时 `remove` 返回 `undefined`，远程方法返回 `{removed:false, notFound:true}`，界面按幂等成功收尾。详情浮层拿的是打开瞬间的快照，别人先删掉是正常并发；把「已经不存在」报成删除失败，只会让确认框卡住。

### 详情页脚 + 二次确认

删除入口放在详情浮层页脚，与正文用发丝线隔开，使用错误色和 `trash-outline` 图标；链接编辑态下不显示，避免用户一边改链接一边误删。归档卡仍可删除——用户要清掉一张不该存在的卡时，状态不该反过来阻止删除。

确认框复用项目面板的 `ConfirmDialog`，由看板持有状态。确认框打开时详情浮层先卸载：两层 modal 同时监听 Escape、各自做焦点陷阱，会让一次 Escape 关掉两层、Tab 在两层之间抢焦点。取消后详情按原 anchor 重新打开；删除成功后看板立刻摘卡并关闭详情。

### 删除不校验 revision

详情里的 `revision` 是打开时的快照。用它做 `expectedRevision` 会在 leader/worker 改过卡后稳定冲突，而用户表达的意图是「这张卡现在删掉」；删除按 id 执行，不依赖快照版本。卡片已不存在时幂等成功，这一点与面板的链接编辑不同——链接编辑仍会把冲突原样报出来。

### 旧轮询快照不能复活已删卡

删除成功时把卡片 id 记进看板本地集合，轮询响应合并后过滤掉这些 id。删除前已发出的取数请求可能带着旧快照晚到，不过滤会让卡片在 2 秒轮询周期里短暂重现，用户会以为删除没生效。卡片 id 不复用，集合在会话生命周期内不需要清；换会话时随面板重置清空。

## 边界

- **没有恢复与审计**：删除后正文、链接、槽位绑定从卡片库消失，只能靠外部备份找回；需要保留历史请用归档。
- **删除不停 worker**：槽位索引释放后，worker 下一轮不再收到卡片事实，但会话本身仍在跑；本 bundle 没有中止 worker 的工具。
- **远程方法没有项目归属校验**：`direct` 调用拿不到调用方会话，和 `updateCardLinks` 同一条取舍；这条通道走官方 `/api` 同源链路，能调它的本机页面或进程本来就能读写本机数据。它不比工具更宽，只是少一道防误用的一致性检查。
- **卡面仍不放操作按钮**：删除入口只在详情页脚；看板卡面保持信息与导航。
- **任何项目会话的看板都能点删除**：按钮不按 leader/worker 身份隐藏。远程方法没有 actor 身份，界面也不区分；这是单机单用户模型下的人工动作。若要限制成只有 leader 的看板可删，需要在面板上按角色隐藏，而不是靠这条远程方法。
- **确认框替换详情**：确认期间详情卸载，取消后重开，滚动位置与详情内的临时编辑态会丢；删除入口在链接编辑态隐藏，正常路径没有未保存内容。
- **删除后编号空洞**：`list_cards` 会跳号，这是不复用编号的预期代价。

## 验证

- 单测：`cards-store` 新增 3 例（移除与编号不复用、索引释放、不存在时返回 `undefined` 且不落盘），`projects-remote` 新增 1 例（正常删除与幂等 `notFound`），`card-detail-view` 新增 2 例（可删判据与确认文案），`board-projection` 新增 1 例（从列表摘卡）。全量 `npm run check`：1128 个用例通过（17 skipped），61 个被单测加载的文件里 53 个行覆盖 100%；`src/host/cards/store.js` 与 `src/host/projects/remote.js` 的新增行都被覆盖。
- e2e：`DSH_PROFILE=web node --test tests/e2e/board-card-delete.e2e.js` 通过。真实宿主里种两张卡，打开详情看到页脚「删除卡片」；点开确认框时详情收起，取消后详情重开、两张卡都在；再次确认后待删卡从看板消失，`cards.json` 只剩另一张卡；页内无 `pageerror` / `console.error`。截图在 `.dev/e2e-artifacts/board-card-delete-<pid>/`（不入库）。
- 双向验证（撤销 → 对应用例变红 → 还原 → 全绿）：
  1. `store.remove` 不 `splice` → `cards-store` 2 例红（移除与索引释放）。
  2. `store.remove` 去掉 `rebuildIndexes` → `cards-store` 索引释放 1 例红。
  3. `deleteCard` 对不存在卡片也返回 `removed:true` → `projects-remote` 的幂等断言红。
  4. `CardDetail` 去掉页脚删除按钮 → e2e 等待 `.dsh-leader-agent-card-detail-delete` 超时（37.0s 红）。
- 本机 `DSH_PROFILE` 是 `desktop`，其源 profile 没装本插件；直接跑 e2e 时项目区块不会挂载，`main` 同样复现。e2e 必须显式 `DSH_PROFILE=web`，这不是本次改动引入的。
- `npm run build:client` 通过（客户端改动必须重建后再跑 e2e）。
