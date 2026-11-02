# worker 继承协调者的权限

**状态**：implemented（2026-11-02）
**范围**：`src/host/{permission-inherit,worker-sessions,dispatch}.js`、`src/host/tools/spawn-worker.js`、`docs/{architecture,capability-gaps}.md`、`tests/`

## 背景

用户指出：worker 的权限应该从协调者继承，而不是走默认。核对宿主源码，问题确实存在，且后果不对称。

宿主的 `permissionPresets` 在 **`session/created`** 上给**每个新会话**调 `pinInitialPermission()`（`ctx.on('session/created', …)`，构造时还会对 `ctx.sessions.list()` 的既有会话补一遍，没有 `prepend`）：全新会话直接写 `permission/preset` + `sandbox/mode` + `approval/policy`，值取自**用户默认 preset**，与父会话当前选择无关（`packages/interaction/permission-presets/src/index.ts:245-249,428`）。本仓的 worker 走 `agents.create`，是独立的新会话，于是拿到默认值（web profile 下 `workspace-write` + `ask`）。

偏差发生在两个方向，都表现为「协调者能干、worker 干不了」：

- 协调者切到 `danger-full-access` 时，worker 仍在 `workspace-write`，项目目录外的写操作被沙箱拒绝；
- 协调者切到 `never`（不再弹审批）时，worker 仍是 `ask`，而审批 answerer 按**会话 UI 作用域**注册（`ui-approval` 的 `ctx.sessions.scopeOf(owner)`，`packages/client/ui-approval/src/client/index.ts:45`）——后台 worker 的会话没在界面上打开，没人应答，一律落到 `unavailable` → 工具被拒。

## 决策

### 继承两个 knob；`auto` 额外补写 preset 身份

建 worker 之后、首轮之前，把协调者的**有效**沙箱模式（`sandboxPolicy.resolve({ session })`）与审批策略（`approval.overrideOf(session) ?? approval.config.policy`）追加到 worker 会话上。

普通 preset 不写 `permission/preset`：名字由 `derive()` 从 knob 值反推，knobs 一致时 UI 自然显示同一个档（协调者是 `custom` 时两边都显示 `custom`）。反过来写一个与 knobs 不匹配的名字，客户端会显示错的档。

**`auto` 是例外，必须写 preset 名**：auto 的身份不在 knob 值里。它的 bundle（`danger-full-access` + `ask`）不匹配任何配置 preset，只继承裸 knobs 时 `derive()` 落到 `custom`；而 auto-review 的审查门判据正是 `permissionPresets.current(session) === 'auto'`（`packages/experimental/auto-review/src/index.ts:689`）。结果是「沙箱放开、审查门关掉」，比不继承更宽。宿主 subagent 对同一问题也是额外写 `permission/preset`（`packages/subagent/subagent/src/child-agent.ts:248-278`）。写 preset 的前提是沙箱模式已经落定（值本来就相同，或 `sandbox/mode` 写成功）：身份与 knobs 不一致时反推不出 auto，写它只会把会话标成 `custom`。

两条 knob 覆盖都带 `source: 'delegation'`：这是宿主给派生子会话的既有标记（宿主 subagent 就用它给子会话钉 `approvalPolicy: 'never'`，`packages/subagent/subagent/src/child-agent.ts:271-277`），表示这不是用户在这条会话里的选择。`permission/preset` 照宿主的形状只带 `preset`。写的都是**已知** session event，不违反「仓外插件不能新增事件类型」。

### 读不到 preset 身份时整体放弃继承

`permissionPresets` 服务在、但 `current()` 读失败（例如 projection 未注册的启停窗口）时，无法排除协调者正处于 auto。此时只写裸 knobs 就可能落成「无沙箱、无审查门」，所以放弃整次继承，让 worker 停在更严的默认上，并把原因交给 `skipped`。组合里根本没有 `permissionPresets` 服务时不在此列：auto 由 `registerAuto()` 注册在该服务上，服务不在就不可能有 auto。

### 值相同时不写事件

`permissionPresets` 已经给 worker pin 过默认 knobs，协调者也没切过时两边一致；此时再追加覆盖只会在 worker 的日志里留噪声。比较对象是 `overrideOf(worker)`（当前覆盖）而不是部署默认——这样在没有 `permissionPresets` 的组合里也会显式落一次值。

### 派工回执带继承到的权限，完全权限点名

`spawn` 返回 `{ sessionId, permission }`，`dispatch` 把它放进 record，`spawn_worker` 的输出与渲染文案都带上：`danger-full-access` + `never` 时明说「完全访问、无审批——它能读写工作区外的文件并执行任意命令」，`auto` 时明说「无沙箱，每次工具调用先经自动审查」。

取舍：继承 `never` 本身可接受——`ask` 在后台 worker 上恒定落到 `unavailable`（宿主 subagent 也因此无条件钉 `never`），不继承 `never` 只会让 worker 的写操作全部失败，不构成安全增益。**不可接受的是静默**：worker 的输入来自项目文件、issue 与 PR 正文，prompt injection 在完全权限 + 无审批下直接等于任意代码执行；用户此刻在界面上只看到「建了一个 worker」。派工回执是用户唯一能在开工前否决的位置。

### 放在 `spawn` 里、`present` 之前

权限要在首轮请求组装之前生效，所以继承紧跟在 `agents.create` 之后。`dispatch` 只负责把协调者会话（`parent.session`）交下去；建会话与它的事后补做（标题、工作区）都在 `worker-sessions` 里，权限跟它们同一层。

`parent.session` 是协调者的活会话，不需要再查注册表：`dispatch` 手上就有。

### 降级只记日志，不阻塞派工

- 两个权限服务都不在：这个组合没有权限旋钮（sdk-minimal 一类），直接返回 `undefined`，不告警。
- 只露出一半：记一行日志，继承在的那一半。
- 读协调者有效值失败（例如 `resolve()` 因为 cwd 不是绝对路径抛错）或写事件失败：记日志，该 knob 保持默认，另一个 knob 照常继承。

会话已经建好了，为一次权限读取失败把派工整个打掉，代价（留下半成品或让协调者拿不到回执）比权限偏差更大。偏差不再只落在日志里：`inheritPermission` 返回 `skipped: [{ knob, reason }]`，一路透到 `spawn_worker` 的回执（「权限未完整继承：…」）。

## 边界

- **只继承一次**，即派工那一刻。协调者之后切换 preset 不影响已派出的 worker——权限在宿主里本来就是逐会话的，worker 是独立会话，不是它的子作用域。用户在派工回执里能看到的那一刻权限值就是 worker 的最终值。
- **冷恢复不重算**：`sandbox/mode` 与 `approval/policy` 都在会话日志里，`agents.resume` 会把 fold 恢复回来；`pinInitialPermission()` 对已有 knobs 的恢复会话也只补缺失项，不会覆盖。继承成 `auto` 的 worker 在冷恢复时要求 auto 集成在场（`pinInitialPermission()` 的宿主契约），集成缺席时宿主自己会抛。
- **`ask` 方向仍是死路**：协调者是 `ask` 时 worker 也是 `ask`（值相同不写），后台没有 answerer → `unavailable` → 工具被拒，与修复前一样；只有用户打开该 worker 会话才可能应答。本 PR 修好的是 `never` 那一半与「协调者已放开沙箱」那一半。保留 `ask` 而不是无条件钉 `never`，是因为 worker 会话可被人下钻对话，被应答的可能性应保留。
- **读有效值而非只读显式覆盖**：`sandboxPolicy.resolve()` 含部署默认，宿主 subagent 的 `captureDelegatedPolicyOverrides()` 只取 `overrideOf()`。本包要的是「协调者当前生效的权限」，所以取 resolve；代价是协调者没有显式覆盖时也会落一条 `source: 'delegation'`，把部署默认标成继承。当前 worker 的 pin 值与部署默认一致时不会产生差异。
- **不改宿主的默认值**：继承写在自己的会话上，用户默认 preset 仍决定其他新会话。
- 协调者是协调者、worker 是 worker：这条继承不扩大到工具面（工具面按角色裁剪，见 `docs/architecture.md`）。
- `inheritPermission()` 不在 `spawn` 的 `try` 里：它内部的读写都已就地 catch，唯一可能逃出的是 `logger` 自身抛错。那种情况下派工失败（Fail Loud 方向正确），活表里会留一个已建会话的句柄，只影响这一次派工。

## 验证

- `tests/permission-inherit.test.js`（13 例）：两个 knob 都继承、`auto` 时补写 `permission/preset`（断言事件形状只有 `preset`）、`auto` 但沙箱没落定时不写身份、读不到 preset 身份时整体放弃、值相同不写、只差审批时只写一条、没有 `permissionPresets` 时按部署默认显式落值、两个服务都缺时返回 `undefined`、只露出一半时记日志 + `skipped`、`resolve()` / `overrideOf()`/写事件各自失败时降级、读 worker 当前覆盖抛错时仍写入目标值。
- `tests/worker-sessions.test.js`：`spawn` 把协调者的覆盖写到新会话上，并断言回执里的 `permission`；没有权限来源时不碰权限事件。
- `tests/dispatch.test.js`：`dispatch` 把 `parent.session` 交到 `spawn`、record 带 `permission`；`spawn_worker` 的回执与渲染文案点名「完全访问、无审批」。
- `npm run check`：801 例，792 pass，0 fail（9 skipped）。
- 双向验证（每项都精确撤销对应代码后重跑）：
  - 撤掉 `auto` 分支的 preset 写入 → `permission-inherit` 2 红（11 pass / 2 fail），还原后 13 pass / 0 fail；
  - 撤掉「读不到 preset 身份就放弃」的 return → 对应用例 1 红（12 pass / 1 fail），还原后全绿；
  - 撤掉 `spawn` 里的 `inheritPermission(...)` 调用 → `worker-sessions` 1 红（29 pass / 1 fail），还原后 30 pass / 0 fail；
  - 撤掉 `dispatch` 里的 `permissionFrom: parent.session` → `dispatch` 2 红（68 pass / 2 fail），还原后 70 pass / 0 fail。
