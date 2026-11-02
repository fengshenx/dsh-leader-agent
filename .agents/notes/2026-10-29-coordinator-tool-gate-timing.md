# 协调者工具面的裁剪时序

**状态**：implemented（2026-10-29）
**范围**：`src/host/projects/service.js`（`create` / `replaceCoordinator` / `createCoordinatorSessionWithCtx`）、`docs/capability-gaps.md` 第 37 条

## 背景

新建项目的协调者会话拿不到 `spawn_worker` / `message_worker` / `list_cards` / `worker_done`（`worker_done` 当日稍后删除，见 [worker 回报由机制侧结算](2026-10-29-worker-report-by-session-events.md)）——工具面被裁成了「普通会话」那一档，只剩卡片编辑与项目注册表那几件。协调者因此没法派工，项目建出来是空的。

根因是两件事的先后顺序：工具面在 `agent/created` 里按 `isCoordinatorSession()` 当场裁，而那个事件在**建会话内部**就发出来了；原来 `create()` 先建会话，之后才 `store.insert()` 与 `coordinatorIndex.set()`。于是协调者出生那一刻注册表里还没有它，被判成普通会话。索引在进程启动时就已重建完成（当时还是空的），所以也走不到「未就绪就一律放行」那条宽松分支。

裁错的限制不会自己松开：`restrict()` 是往该 agent 的作用域追加一层限制，要等这个会话下次冷恢复重算 `agent/created` 才会有新的判定。

## 决策

**会话 id 由我们预先生成，身份先登记，再让宿主用这个 id 建会话。**

`sessionController.create({ sessionId })` 与 `agents.create({ sessionId })` 都接受调用方指定的 id（rc.2：前者落到 `claim(named, request)` → `createAgent(sessionId, …)`，后者直接用它建）。所以 `openRegisteredCoordinatorSession(directory)` 生成 `session-<uuid>`、先往 `coordinatorIndex` 写一条只有 `directory` 的占位，再调建会话实现，最后把 `projectId` 补上。

不选另外两条路的原因：

- **建会话后回收限制再重裁**：`restrict()` 返回 disposer，技术上能做到，但要按 sessionId 保存 disposer、拿 `ctx.agents.get()` 找回 agent，还得赌重裁发生在首轮请求组装之前。多三个不确定点，换来的只是「事后纠正」。
- **反转为先落项目记录再建会话**：`coordinatorSessionId` 本身要等建会话才知道，除非预生成 id——而预生成之后，先登记索引已经够了，不必再动「会话建不出来时项目不落盘」这条已有的失败路径语义。

登记条目先只写 `directory`：`projectId` 要等 `store.insert()` 返回才有值，`resolveProjectOfSession()` 据此跳过 `store.get(undefined)` 并退回 cwd 判定。占位期间没有任何项目记录指向这个会话，也不会有卡片调用落在它身上。

**建会话失败或 id 不一致时撤掉占位。** 前者保持「失败路径没有半条记录」；后者说明建会话的实现没按契约用传入的 id（`createCoordinatorSession` 是注入点，测试替身也照这个契约写），当场抛错而不是留一个工具面残缺的协调者。

`replaceCoordinator()` 走同一个 helper：换新协调者时新会话同样出生即协调者。旧会话的索引条目仍是改绑成功之后才删——`store.update` 失败时旧协调者身份保持不变。

## 验证

- `npm run check`：439 例全绿（合并 `origin/main` 后 437，加两条凭据读取用例）。
- **回归用例**「建协调者会话那一刻，注册表里已经有它」：在 `createCoordinatorSession` 替身里用钩子站到 `agent/created` 的同一时刻问 `isCoordinatorSession()`，先 `loadIndex()` 复现真实进程（索引已加载、为空）的前提——不先加载的话 `isCoordinatorSession()` 一律放行，用例测不出时序。钩子结果收集成数组而非标量：标量只留最后一次，工厂被多调一次也察觉不到。
- 双向验证五组，都是精确删除后看对应用例单独变红、其余全绿：
  - helper 改回「先建会话后登记」→ 两条登记时序用例红；
  - 删 `create()` catch 里的占位清理 → 「项目落盘失败时也撤掉占位」红；
  - 删 `replaceCoordinator()` catch 里的占位清理 → 「换协调者时改绑失败也撤掉占位」红；
  - 删 `created !== sessionId` 分支 → 「建会话的实现没按契约用传入 id 时当场失败」红；
  - 只删该分支里的占位清理 → 同一条用例仍红（它同时断言了预生成 id 的占位已撤）。
- 失败路径：「建会话失败时不落盘」补两条断言——`directoryOfCoordinator` 与 `isCoordinatorSession` 对预生成的 id 都返回空，占位确实撤掉了。
- 契约层：`createCoordinatorSessionWithCtx` 的两条用例改成断言 `sessionController.create` 收到的 `sessionId` 与我们传入的一致（`{ workspaceId, sessionId }` 与 `{ cwd, sessionId }` 两种入参形态）。

## 边界

- **已裁错的会话不会自动修复**：修复前建的项目，协调者会话的工具面仍是普通会话档。重启实例让它冷恢复一次即可，不必重建项目。
- **依赖宿主尊重传入的 id**：`engines.dsh` 上限是 `<0.3.0`，0.2.x 内两条路径都用调用方 id。真变了会走「id 不一致」抛错路径，建项目直接失败并说明原因，而不是静默退化。宿主侧的完整约束（`restrict()` 只能同步判定、`agent/created` 早于身份登记）见 `docs/capability-gaps.md` 第 37 条。
- **`indexLoaded` 的宽松放行不变**：索引重建失败时 `isCoordinatorSession()` 仍对任何会话返回 true，那是为了保证协调者首轮不至于没工具；派工这类高危操作本来就另走 `awaitIndex()` 再判一次。本修复不改变这条口径，只是让正常路径不再依赖它兜底。
