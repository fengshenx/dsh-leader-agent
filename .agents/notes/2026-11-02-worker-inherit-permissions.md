# worker 继承协调者的权限

**状态**：implemented（2026-11-02）
**范围**：`src/host/{permission-inherit,worker-sessions,dispatch}.js`、`docs/{architecture,capability-gaps}.md`、`tests/`

## 背景

用户指出：worker 的权限应该从协调者继承，而不是走默认。核对宿主源码，问题确实存在，且后果不对称。

宿主的 `permissionPresets` 在 `agent/created` 上（`prepend: true`）给**每个新会话**调 `pinInitialPermission()`：全新会话直接写 `permission/preset` + `sandbox/mode` + `approval/policy`，值取自**用户默认 preset**，与父会话当前选择无关（`packages/interaction/permission-presets/src/index.ts:231-235`）。本仓的 worker 走 `agents.create`，是独立的新会话，于是拿到默认值（web profile 下 `workspace-write` + `ask`）。

偏差发生在两个方向，都表现为「协调者能干、worker 干不了」：

- 协调者切到 `danger-full-access` 时，worker 仍在 `workspace-write`，项目目录外的写操作被沙箱拒绝；
- 协调者切到 `never`（不再弹审批）时，worker 仍是 `ask`，而审批 answerer 按**会话 UI 作用域**注册（`ui-approval` 的 `ctx.sessions.scopeOf(owner)`，`packages/client/ui-approval/src/client/index.ts:45`）——后台 worker 的会话没在界面上打开，没人应答，一律落到 `unavailable` → 工具被拒。

## 决策

### 继承两个 knob，不写 `permission/preset`

建 worker 之后、首轮之前，把协调者的**有效**沙箱模式（`sandboxPolicy.resolve({ session })`）与审批策略（`approval.overrideOf(session) ?? approval.config.policy`）追加到 worker 会话上。

不写 `permission/preset` 事件：它的名字由 `derive()` 从 knob 值反推，knobs 一致时 UI 自然显示同一个 preset（协调者是 `custom` 时两边都显示 `custom`）。反过来写一个与 knobs 不匹配的 preset 名，客户端还会显示错的档。

两条覆盖都带 `source: 'delegation'`：这是宿主给派生子会话的既有标记（宿主 subagent 就用它给子会话钉 `approvalPolicy: 'never'`，`packages/subagent/subagent/src/child-agent.ts:253,273-275`），表示这不是用户在这条会话里的选择。写的是**已知** session event，不违反「仓外插件不能新增事件类型」。

### 值相同时不写事件

`permissionPresets` 已经给 worker pin 过默认 knobs，协调者也没切过时两边一致；此时再追加覆盖只会在 worker 的日志里留噪声。比较对象是 `overrideOf(worker)`（当前覆盖）而不是部署默认——这样在没有 `permissionPresets` 的组合里也会显式落一次值。

### 放在 `spawn` 里、`present` 之前

权限要在首轮请求组装之前生效，所以继承紧跟在 `agents.create` 之后。`dispatch` 只负责把协调者会话（`parent.session`）交下去；建会话与它的事后补做（标题、工作区）都在 `worker-sessions` 里，权限跟它们同一层。

`parent.session` 是协调者的活会话，不需要再查注册表：`dispatch` 手上就有。

### 降级只记日志，不阻塞派工

- 两个权限服务都不在：这个组合没有权限旋钮（sdk-minimal 一类），直接返回，不告警。
- 只露出一半：记一行日志，继承在的那一半。
- 读协调者有效值失败（例如 `resolve()` 因为 cwd 不是绝对路径抛错）：记日志，该 knob 保持默认，另一个 knob 照常继承。

会话已经建好了，为一次权限读取失败把派工整个打掉，代价（留下半成品或让协调者拿不到回执）比权限偏差更大；偏差本身在 worker 的失败回报里可见。

## 边界

- **只继承一次**，即派工那一刻。协调者之后切换 preset 不影响已派出的 worker——权限在宿主里本来就是逐会话的，worker 是独立会话，不是它的子作用域。
- **冷恢复不重算**：`sandbox/mode` 与 `approval/policy` 都在会话日志里，`agents.resume` 会把 fold 恢复回来；`pinInitialPermission()` 对已有 knobs 的恢复会话也只补缺失项，不会覆盖。
- **不改宿主的默认值**：继承写在自己的会话上，用户默认 preset 仍决定其他新会话。
- 协调者是协调者、worker 是 worker：这条继承不扩大到工具面（工具面按角色裁剪，见 `docs/architecture.md`）。

## 验证

- 新增 `tests/permission-inherit.test.js`（10 例）：两个 knob 都继承、值相同不写、只差审批时只写一条、没有 `permissionPresets` 时按部署默认显式落值、两个服务都缺时静默跳过、只露出一半时记日志并继承另一半、`resolve()` 抛错时降级且审批照旧继承、审批读取抛错时降级且沙箱照旧继承、读 worker 当前覆盖抛错时仍写入目标值、写事件失败时只记日志不抛。
- `tests/worker-sessions.test.js` 新增 2 例：`spawn` 把协调者的覆盖写到新会话上（两条 `source: 'delegation'` 事件）、没有权限来源时不碰权限事件。
- `tests/dispatch.test.js` 新增 1 例：`dispatch` 把 `parent.session` 交到 `spawn`，worker 会话上出现两条覆盖——防「模块单测全绿但没接线」。
- 双向验证（两条接线分别做）：
  - 删掉 `spawn` 里的 `inheritPermission(...)` 调用 → `建会话时继承协调者的权限` 变红（29 pass / 1 fail），还原后 30 pass / 0 fail；
  - 删掉 `dispatch` 里的 `permissionFrom: parent.session` → `派工时 worker 继承协调者的权限` 变红（68 pass / 1 fail），还原后 69 pass / 0 fail。
