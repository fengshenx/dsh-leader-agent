# Agent Note: worker 继承协调者的权限

Status: implemented

## Problem

worker 是本 bundle 用 `agents.create` 建的独立新会话，而宿主的 `permissionPresets` 在 `session/created` 上给每个新会话按**用户默认 preset** pin 权限，于是协调者切到更宽的档位时 worker 仍停在默认值，后台 worker 又没人应答审批，一律落到 `unavailable`。

## Decision

- **继承协调者的两个 knob**：建 worker 之后、首轮之前，把协调者的有效沙箱模式（`sandboxPolicy.resolve`）与审批策略（`approval.overrideOf(session) ?? approval.config.policy`）追加到 worker 会话，并带 `source: 'delegation'`——那是宿主给派生子会话的既有标记，表示不是用户在这条会话里的选择。写的都是已知 session event，不新增事件类型。
- **普通 preset 不写 `permission/preset`**：名字由 `derive()` 从 knob 值反推，knobs 一致时 UI 自然显示同一档；写一个与 knobs 不匹配的名字会让客户端显示错的档。
- **`auto` 是例外，必须写 preset 名**：auto 的身份不在 knob 值里，其 bundle 不匹配任何配置 preset，只继承裸 knobs 会落到 `custom`，而 auto-review 的审查门判据是 `permissionPresets.current(session) === 'auto'`——结果是「沙箱放开、审查门关掉」，比不继承更宽。写它的前提是沙箱模式已落定（值本来就相同或写成功），否则反推不出 auto；`permission/preset` 照宿主的形状只带 `preset`。
- **读不到 preset 身份时整体放弃继承**：`permissionPresets` 服务在、但 `current()` 读失败时无法排除协调者正处于 auto，只写裸 knobs 可能落成「无沙箱、无审查门」，所以让 worker 停在**部署默认 preset** 上，把原因交给 `skipped`。这条回退不保证比协调者更严，回执必须给实际值。组合里根本没有该服务时不在此列——auto 注册在那个服务上，服务不在就不可能有 auto。
- **值相同时不写事件**：`permissionPresets` 已 pin 过默认 knobs、协调者也没切过时两边一致，再写只会留噪声；比较对象是 `overrideOf(worker)` 而不是部署默认。
- **派工回执带 worker 的实际权限**：`spawn` 返回 `{ sessionId, permission }`，`dispatch` 放进 record，`spawn_worker` 的输出与渲染文案都带上，完全权限与 auto 各自点名后果。描述的是**回读到的实际值**而不是继承目标——写失败或放弃继承时两者不是一回事，拿目标值当结果会少报或多报；读不到的键不写，因为 `undefined` 过不了宿主工具结果的 lossless JSON 判定，而报错发生在派工完成之后，会留下挂卡的孤儿 worker。
- **放在 `spawn` 里、`present` 之前**：权限要在首轮请求组装之前生效，继承紧跟 `agents.create` 之后；`dispatch` 只负责把协调者的活会话（`parent.session`）交下去。
- **降级只记日志、不阻塞派工**：两个权限服务都不在时返回 `undefined` 且不告警；只露出一半、读协调者有效值失败或写事件失败时记日志，该 knob 保持默认、另一个照常继承。会话已经建好，为一次权限读取失败打掉派工，代价比权限偏差更大；偏差不再只落日志——`skipped` 一路透到回执。

## Alternatives considered

- **让 worker 停在部署默认 preset**：协调者切宽档时 worker 仍窄，后台没人应答审批；继承协调者的沙箱与审批 knob。
- **只写裸 knobs、不写 `permission/preset`**：`auto` 的身份不在 knob 值里，会落成 `custom` 并关掉审查门；auto 必须写 preset 名。
- **普通 preset 也写名字**：名字由 `derive()` 从 knobs 反推，写错会让客户端显示错的档；普通档只写 knobs。
- **读不到 `current()` 时仍写裸 knobs**：无法排除协调者正处于 auto，可能落成「无沙箱、无审查门」；整体放弃继承，停在部署默认。
- **协调者是 `ask` 时无条件钉 `never`**：worker 会话可被人下钻对话，应答可能性应保留；保留 `ask`。

## Consequences

- **只继承一次**（派工那一刻）：协调者之后切换 preset 不影响已派出的 worker，权限在宿主里本来就是逐会话的。
- **冷恢复不重算**：`sandbox/mode` 与 `approval/policy` 都在会话日志里，`agents.resume` 会把 fold 恢复回来，`pinInitialPermission()` 对已有 knobs 只补缺失项。继承成 `auto` 的 worker 冷恢复要求 auto 集成在场。
- **`ask` 方向仍是死路**：协调者是 `ask` 时 worker 也是 `ask`（值相同不写），后台没有 answerer，工具仍被拒；保留 `ask` 而不是无条件钉 `never`，是因为 worker 会话可被人下钻对话，应答的可能性应保留。
- **读有效值而非只读显式覆盖**：代价是协调者没有显式覆盖时也会落一条 `source: 'delegation'`，把部署默认标成继承；当前 worker 的 pin 值与部署默认一致时不会产生差异。
- **不改宿主默认值**：继承只写在自己的会话上，用户默认 preset 仍决定其他新会话；也不扩大到工具面（工具面按角色裁剪）。
- **`inheritPermission()` 不在 `spawn` 的 `try` 里**：内部读写都就地 catch，唯一可能逃出的是 logger 自身抛错；那种情况下派工失败（Fail Loud 方向正确），活表里留一个已建会话的句柄，只影响这一次派工。

收益：worker 按协调者当前的有效权限开工，auto 不会退化成无审查门，回执报的是实际生效值。

## Testing

`tests/permission-inherit.test.js`、`tests/worker-sessions.test.js` 与 `tests/dispatch.test.js`。双向：撤掉 `auto` 分支 → 3 例红；把回读会话从 worker 换成协调者（回执报目标值）→ 6 例红。还原后全绿。
