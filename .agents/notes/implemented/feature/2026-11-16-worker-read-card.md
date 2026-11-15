# Agent Note: worker 读卡：读放开、写收窄

Status: implemented

## Problem

worker 的卡片事实原先只有注入一条通道（`dsh-leader-agent:task-card`）。注入 provider 求值失败、绑定被摘，或压缩后快照被摘要吞掉时，worker 手里没有 cardId，无法确认自己该做什么；它也需要看同项目里依赖卡的现状，而注入只给它自己的卡。现有工具对不上：`list_cards` 只给 leader，`create_card` / `update_card` 是写通道，worker 没有任何读入口。

## Decision

- **`read_card` 只给 worker**。工具面用 deny 模型，所以是「leader 与普通会话都 deny」，而不是反向白名单；`LEADER_UNUSABLE_TOOLS` 保持为宿主 subagent 三件的别名，worker 专属件单独成组再拼进 `LEADER_DENY_TOOLS`。leader 与普通会话不需要它的理由不同：前者已有 `list_cards`，后者不在项目编排里。执行期再判一次 worker 身份，因为默认分支按会话绑定反查，只有 worker 有绑定。
- **不传卡片参数时读唯一绑定的卡**。这是压缩、注入失效、冷恢复后找回任务的入口，价值不在省参数。唯一是硬条件：多张时报错并列出候选 cardId，零绑定时报错并提示回报；替调用方猜会让它对着另一张卡的规格干活。
- **规格分页，按码点切**。2000 码点一页，用返回的 `specPage.nextOffset` 作为 `specOffset` 续读，越界报错而不是给空片段；`specPage` 的 `chars` 与 `total` 都是码点数。按码点而不是 UTF-16 码元切，否则代理对被切开、模型自己数出的位置也与 `nextOffset` 对不上。
- **读放开、写收窄**。worker 能读本项目任意卡，但 `update_card` 仍只作用于自己绑定的卡；`sortOrder` 并入 leader 专属字段——它和分类一样是对看板的组织动作，不是执行者的交付物。读的范围只到单卡：列表仍不给 worker。
- **不做 `presentationMeta`**。看板数据源是宿主的项目通道，工具投影只进会话历史；读操作不产生新事实，而且返回的 `card.spec` 只是当前一页，投影会把看板的完整规格覆盖成片段。

## Alternatives considered

- **leader 也用 `read_card`**：`list_cards` 传 `cardId` 已是单卡读；两个等价入口只会让模型在两件工具之间犹豫。
- **工具面改反向白名单**：现有机制 `tools.restrict({ deny })` 只有 deny 面，白名单要自己枚举全部工具，新增工具默认对所有人关闭。
- **多绑定时替调用方挑一张**（最近绑定或第一张）：会让 worker 对着另一张卡的规格干活，错误被下游放大；报错列候选。
- **不分页、一次返回全文**：长规格本身就是压缩对象，一次灌进上下文会挤掉真正的工作内容。
- **按 UTF-16 码元切页**：代理对被切开，模型数出的位置与 `nextOffset` 对不上。
- **放开 `list_cards` 让 worker 自己读**：会把项目全局视野变成它的决策输入；单卡读只回答「这一张是什么」。
- **让读卡投影 `presentationMeta` 更新看板**：返回的 `card.spec` 只是当前一页，`scope: 'card'` 的投影会把看板上的完整规格覆盖成片段；工具投影只进会话历史，读不产生新事实。

## Consequences

- **只读本项目**：跨项目读拒绝；没有 `projectId` 的存量卡放行，与 `update_card` 同判据——没有归属可冲突，拦下只会让存量卡永远读不到。代价是存量卡的读取面不受项目隔离。
- **分页只影响规格的呈现**：`revision`、链接、槽位照旧是完整事实；改卡前确认 revision 用本工具读落盘真源，注入快照可能过期。
- **注入仍是主通道**：本工具是冗余而不是替代，注入有效时两者内容一致；代价是两条通道的内容口径要一起维护。
- **读卡不更新看板**：读操作不投影，看板不会因一次读而刷新；代价是调用方只能靠返回值判断，换来的是不用一页规格覆盖看板全文。
- **worker 的写边界不变**：仍不建卡、不列卡、不改状态、规格与排序；`read_card` 不改变这条边界。
- **只有单卡读取**：worker 仍看不到项目全貌，依赖关系要靠 leader 在任务里点名；这是有意的读取面收窄。

收益：worker 在压缩、注入失效或冷恢复后能找回自己的任务，也能看同项目依赖卡的现状，而写入面没放开，长规格也不会一次灌满上下文。

## Testing

`tests/cards-tools.test.js` 钉住寻址（两种入口、互斥、零绑定、多绑定候选、同卡双槽位、幽灵卡、缺绑定索引）、只读范围（跨项目、存量卡放行、同项目读别人的卡且切项目后被拒、写仍被拒）、分页（三段续读、码点切分、越界、空规格）、`sortOrder` 禁改与不投影；`tests/tool-gate.test.js` 钉住工具面三条（leader 与普通会话 deny、worker 保留、名单互不重叠）；`tests/projects-service.test.js` 跟着 `LEADER_DENY_TOOLS` 改。双向：撤跨项目范围闸 → 跨项目用例红；撤按 cardId 去重 → 同卡双槽位用例红；让范围闸一律拒绝 → 同项目正向用例红；撤 `sortOrder` 判断 → 排序用例红。
