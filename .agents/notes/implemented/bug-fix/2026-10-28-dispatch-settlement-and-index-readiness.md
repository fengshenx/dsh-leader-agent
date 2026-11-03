# 派工结算的挂载顺序、索引就绪与看板容错

**状态**：implemented（2026-10-28）
**范围**：`src/host/dispatch.js`、`src/host/projects/service.js`、`src/host/index.js`、`src/host/worker-registry.js`、`src/client/board.js`、`src/client/project-board-monitor.js`、`tests/dispatch.test.js`、`tests/dispatch-continuation.test.js`、`tests/worker-registry.test.js`

## 背景

PR #10 第二轮复审提了三类问题：派工链路上「失败被记成成功」的三处（登记失败丢通知、续聊竞态抛错、续聊轮失败报完成）、协调者判定 `fail-open` 却没有执行期兜底、看板一次 RPC 抖动就永久停在错误页。第三轮复审指出续聊轮的修法本身站不住：判据只认 `error`，而首轮结算压根没判——同一套终态语义写了两遍、两处都偏。

## 决策

**结算回调先挂，登记后做**。子会话一旦 `startActivation` 就回滚不了：登记失败（home 只读、磁盘满）时若结算回调还没挂上，worker 白跑一遍，通知既不入盘也不投递，而模型收到的是「派工失败」，会再派一次。顺序改成 `inflight.set` → 挂 `activation.result.then(settle)` → `try { workers.register } catch { 记日志 }`。

**消息往返期间把记录取到局部变量**。`message_worker` 判定 worker 在跑之后要 `await subagents.sendMessage`，这期间 worker 可能结算、`settle` 会把记录从 `inflight` 删掉。回来再查表得 `undefined` → `Cannot read properties of undefined`，但消息其实已经投出去了，模型看到报错会重发。先取记录再发。

**续聊轮按 `stopReason` 报真实结果**。宿主 `subagent/end` 失败时也发，负载是 `stopReason: 'error'` 加空 output。硬编码 `ok: true` 会把崩溃的续聊轮记成「完成」，气泡上只剩一句「（worker 未产出文本）」，与真的没产出分不开。

**首轮与续聊轮共用 `judgeTerminal(result)`，判据是「非 `completed` 即失败」**。宿主对 child-level 失败是 **resolve 而非 reject**（`subagent/src/types.ts` 的 `activation.result` 契约：非 `completed` 的原因意味着 output 可能不完整），所以「promise 没抛错」不等于「活干成了」——首轮原实现一律记 `ok: true`，而首轮是每次派工必经路径，暴露面比续聊轮更大。`SubagentStopReasonMap` 共五档：只有 `completed` 算完成，`error` / `aborted` / `refusal` 是没干成活，`max-tokens` 的产出是被截断的，当完整产物交给协调者验收会漏掉返工。失败正文保留原始 `stopReason`（`worker 以 max-tokens 结束，产出可能不完整`），不笼统写「以错误结束」；缺 `stopReason` 的旧负载按 `completed` 处理——宿主没给原因不等于它说失败了。首轮与续聊轮判据同源，分开写必然再走偏（上一轮正是只给续聊轮写了 `stopReason === 'error'`）。

**派工不能建立在索引 fail-open 上**。`isCoordinatorSession()` 在索引未就绪时一律返回 true，那是为了让协调者首轮看得到工具（`agent/created` 早于首轮请求组装）。但那个宽松意味着注册表读不出来时**任何**会话都被当成协调者。派工是唯一会真的拉起会话的操作，执行前 `awaitIndex()` 等一次重建结果，读不出来就拒绝，并要求调用方确实是协调者。读类工具继续用同步判定——多给一个读工具的实际危害是「看不到卡片列表」，不是拉起会话。

**索引重建失败退避重试三次**。原实现只在启动时试一次，失败后 `indexLoaded` 永久 false，`awaitIndex()` 会永远返回 false、派工全废。退避 2s / 4s 重试，仍失败则由派工路径明确报错，让用户知道要重启。重试定时器与 `disposed` 标志一起进 `ctx.on('dispose')`：插件卸载后不该再排新的重试，也不该继续读索引写日志。

**`coordinatorIndex` 是必需参数，装配时断言**。它原先是可选项，漏传即整段跳过派工校验——那道闸的失效方式是静默的，复审的探针正是靠不传参数跑通的。派工是会真的拉起会话的操作，宁可 `createDispatcher` 当场报错，也不要留一个悄悄少一道闸的入口。测试侧用 `makeDispatcher` helper 提供默认放行实现，避免每个用例重复桩件。

**看板 RPC 抖动不判死**。`resolveProject` 与 `fetchBoardCards` 成功时 `setError(null)`；轮询失败保留已加载的卡片。2 秒轮询本来就是干这个的，把面板永久钉在错误页上等于把自愈能力扔掉。

**卸载时关掉自己开的 tab**。宿主 `sidebar-right` 的 teardown 要求：遍历 `openTabs`，用 `closeIn(sessionId, tabId)` 只关本 kind 的 tab。不关的话插件重载后会叠一个点开即空的看板。别碰用户别的 tab，也别整栏清空。

**登记表只留 `register` / `get`，并设上限**。`update()` 无调用者，`listByParent()` / `listByProject()` 只有测试调用，且 `dispatch` 从不传 `projectId` → `listByProject()` 永远返回空数组。按本仓「未使用代码直接删除」删掉。记录永不删除而每条都带任务正文，不设上限时文件随派工次数无界增长、每次登记整表读改写——保留最近 500 条（`maxWorkers` 可注入），同毫秒登记时稳定排序仍淘汰更早那条。

**`needed` 用 id 排序串当依赖**。卡片每 2 秒轮询换一个新数组，用 Map 当依赖会让 `needed` 每轮都是新 Set，同步效果跟着每 2 秒跑一次；保留失败的槽位不在账本里，每次都会再 retain 一遍——`reported` 去重挡住了日志，底层调用没停。

## 已知限制

**`list_cards` 的单卡查询跨项目可读**。`src/host/tools/cards.js:504` 的分支里，传 `cardId` 就走全库查找、不做项目过滤，也不校验该卡属于调用方项目；而 `update_card` 会拦跨项目修改。取舍是：模型拿着 cardId 来读，要的就是那张卡，读权限放开更实用；写权限必须收紧。两个远程方法 `resolveProject` / `boardCards` 同样不校验调用方。要收紧时改这一处 + 那两个方法，不是散在各工具里。

**`onError` 的覆盖面窄**。`retainTargetOf()` 兜底地址之后 `sessions.retain` 不再抛错，`hold()` 的 catch 只剩 `reference.ready` reject 一条路径。绑定了一个「宿主认地址、但快照永远不来」的会话时，圆点会长期停在未知档而没有日志——`RetentionLease` 没有超时事件，判不出来。要覆盖得给保留加计时器，那是独立的一层，先不引入。

## 验证

- `npm run check`：350 例全绿（含 main 上 #9 并入的用例）；`npm run build:client` 通过。
- 回归有效性双向验证（撤修复 → 用例红 → 还原 → 绿）逐条做过：
  - 登记失败丢通知：还原为「先登记后挂回调」→ `✖ worker 登记失败仍照常投递完成通知`
  - 续聊竞态：还原为「await 后查表」→ `✖ 消息往返期间 worker 结算，不误报发不出去`
  - 续聊轮失败：`failed` 恒 false → `✖ 续聊轮以错误结束时报失败而不是完成`
  - 索引未就绪：去掉 `!ready` 分支 → `✖ 项目索引读不出来时拒绝派工，不拉起子会话`
  - 非协调者：去掉 `isCoordinatorSession` 分支 → `✖ 非协调者会话派工被拒绝`
  - 登记表上限：条件加 `false &&` → `✖ 超出上限时淘汰最早的记录，文件不无界增长`
  - 终态判据：`if (stopReason === 'completed' || true)` → `✖ 宿主终态里只有 completed 算完成，其余原因一律判失败` 与 `✖ 首轮 worker 被 max-tokens 截断时通知判失败`
  - `coordinatorIndex` 断言：条件加 `false &&` → `✖ 漏传 coordinatorIndex 时装配直接报错，不静默跳过派工校验`
- React 侧改动（看板清错、卸载关 tab、`needed` 稳定键）进不了单测：本仓刻意不引 React 与 jsdom，靠代码审阅，未做真机取证。
