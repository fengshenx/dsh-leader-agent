# 看板卡片视觉与交互

**状态**：implemented（P4，2026-10-27）
**范围**：`src/client/board.js`、`src/client/board-card.js`、`src/client/board-styles.js`、`src/client/card-detail.js`、`src/client/modal-shell.js`、`src/client/board-projection.js`、`src/client/slot-retain.js`、`src/client/link-row.js`、`src/client/modal-focus.js`、`src/client/card-detail-view.js`、`src/client/confirm-dialog.js`、`src/client/icons.js`

## 背景

P2 的看板只有数据通道与一个能列出卡片的壳：卡面是带边框的方框，正文把 `spec` 与 `checkpoint` 全量铺开，状态做成右上角胶囊，没有链接、没有槽位、没有信号灯、没有详情视图、没有已完成区。用户指认「Card 的交互完全不对，太难看」，要求重做看板。

看板的信息结构定为：active 卡三层（标题行 / 链接行 / 元信息行）、done 卡单行变体、信号灯五档、链接 chip 按实测宽度排布、点击开只读详情浮层、已完成收进折叠区。宿主差异集中在三处：视觉令牌（`--dsw-*`）、图标（宿主运行时无 sprite → 内联路径）、浮层组件（官方 `Modal` 不可 import → 复制改写）。

## 决策

**卡面零操作铬**。卡片只做信息与导航，不放操作按钮（完成、置顶、重命名、删除都没有）。卡片是协调者维护的事实，UI 越权写会把「谁在改」搅浑；本仓不做。

**视觉走「复制宿主数值 + `--dsw-*` 变量」**。不引 Tailwind、不 import 宿主 UI 包。类名统一 `dsh-leader-kit-board-*` 前缀，样式由 `board-styles.js` 注入一次（`<style id="dsh-leader-kit-board">`），沿用确认弹窗既有的「同一页面只注入一次」做法。

**active 卡三层**：标题行（14px 固定信号槽 → `#编号` mono 11px → 标题 13px/500 两行 clamp → 停滞时长）→ 链接行（缩进 22px，圆角胶囊 chip）→ 元信息行（槽位 chip：状态点 + 槽位名）。done 卡是单行轻量变体（绿勾 + 编号 + 标题 + 相对完成时间）。卡面无边框无阴影，静态零装饰，hover 只出背景。

> 卡面视觉在 P6 被推翻：信息结构（三层 / done 单行 / 信号灯 / chip 排布）保留，材质换成宿主的行内卡片材质，见[看板卡面改用宿主卡片材质](2026-10-30-board-card-host-materials.md)。

**链接 chip 按实测宽度排布**。`fitLinkChips` 的做法：可见 chip 数由实测宽度决定，放不下的收进「+N」胶囊；测量层是全量 chip 的不可见副本（`visibility:hidden` 仍参与布局，`<a>`/`<button>` 与真实 chip 同构），`ResizeObserver` 监听行宽变化重排。首帧未测量时全量展示而不是藏链接。chip 间距取 CSS 的真值（`getComputedStyle`），JS 里不再写第二份常量——两份会各改各的，排布就算错。

**交互三语义**：点卡面其他区域 → 开只读详情浮层；点有 URL 的链接 chip → 新标签打开（`stopPropagation`）；点槽位 chip → 打开该槽位绑定的会话。键盘 Enter/Space 只在事件来自卡面根本身时触发——嵌套控件的 Enter/Space 归自己。

**卡面根是 `role="button"` 且内嵌可聚焦控件**，严格说违反 ARIA 的「button 不含可聚焦后代」。这是刻意的取舍：整卡热区与嵌套控件并存，子控件保留独立按钮语义优先，键盘可达性由子控件自己保证。

**信号灯七档**：`waiting`（蓝脉冲）> `attention`（红实心）> `running`（琥珀脉冲）> `unread`（蓝实心）> `idle`（灰实心）> `unknown`（虚线圈）> `none`（虚线圈）。聚合自卡片声明的槽位会话状态，**不落存储**。未派工与状态未知共用虚线圈：两者都不谎称空闲，形状上与实心档区分；这两种情况在卡面上本来就不同——有槽位的卡多一行槽位 chip，空的没有。

**状态有两个来源，合并后成一表**。运行态、等你输入、未读读宿主客户端状态存储 `SessionStatus`（`useSessionStatus`，宿主 `packages/client/ui-session/src/client/index.ts:60-67`）——它是宿主按 `api-session/status` 事件维护的权威值；失败原因不在会话状态里，只在会话快照 `lastAgentError` 里，所以仍要 `ctx.sessions.retain(sessionId, {source})` → `reference.ready` → `binding.session.getSnapshot()` + `subscribe`。保留同时让会话不被宿主回收。

**此前读错了数据源**：会话快照 `SessionSnapshot` 只有 `running` 一项，据此断定「宿主没有未读与审批投影」是错的——那两项在客户端状态存储里，官方 AgentTeam UI 读的就是它（`packages/experimental/client-ui-agent-team/src/client/TeamAction.tsx:83-84`）。会话列表对未保留的 subagent 子会话给的 `running` 是兜底值（宿主 `packages/client/ui-session/src/client/index.ts:521` 有注释说明），据此说「空闲」是撒谎，所以运行态必须以会话状态存储为准；状态存储里 `running` 还没建立基线（`undefined`）时判「状态未知」，不退回快照里的兜底值。

**「等你输入」档当前不亮**：它读 `pendingInteraction`，而宿主的 `SessionPendingInteractionMap` 是空的声明合并表——没有任何域发布待处理交互。机制留着，档位留着，等真有域发布时自动生效。

**槽位只渲染卡片实际声明的**。dsh 的槽位集合由项目 `SLOTS.md` 决定，客户端拿不到；恒渲染空槽等于宣称存在不存在的 worker。未派工的槽位（没有绑定会话）不是按钮——没有会话可打开。

**排序**：active = 信号档位升序 → `sortOrder` 升序（未设置排后）→ `updatedAt` 降序 → 编号升序；done = `doneAt` 倒序；archived 不展示。

**停滞判定**阈值 24 小时。没有绑定会话的卡不计时（那是「没开始」不是「卡住」）；名下会话正在跑的卡也不计时（它正在干活，只是协调者没更新卡片）；**名下会话状态不可知的卡同样不计时**——读不到运行态不等于它停了，断言「卡住」和说「空闲」一样是撒谎，这与信号灯「状态不可知就显示状态未知」是同一条口径。活动的度量只能用卡片自己的 `updatedAt`——dsh 会话列表的 `updatedAt` 是「最后一次被提示的时间」（`packages/api/session-controller/src/list.ts:360`），拿它当活动度量会把「在跑」误判成「卡住」。60 秒计时器驱动停滞判定与相对时长展示。

**事件窗口按增量重放**。宿主的事件窗口「每接受一次变更就同步发布一次」（`packages/api/session-controller/src/client/contract/events.ts:119`），流式输出时每个 chunk 都是一次发布；每次都全量重放整扇窗口，等于把「窗口有多大」乘上「chunk 有多少」，看板会在协调者流式输出时卡住。改按宿主给的 `change` 分派：`append` 与 `settle-assistant` 只处理增量条目，`replace` 与 `prepend` 全量重建——`prepend` 往窗口前面补历史，早到的投影与后到的投影谁作数取决于窗口顺序。卡片表为空时同样全量重建：增量条目只覆盖增量部分，空表靠增量拼不出完整的视图。

> P5 起看板的数据源从会话事件流换成宿主卡片库，本节的重放机制整段删除，见[看板按项目组织](2026-10-27-project-bound-board.md)。保留本节是为了记录「为什么会走偏」：事件窗口既跨不了会话（worker 建的卡不在协调者的窗口里），也扛不住宿主回收（窗口丢了卡就没了），而卡片真源一直在宿主的 `cards.json` 里。信号灯、排序、停滞判定、chip 排布这些不依赖数据来源的部分原样保留。

**会话保留的账本独立于 React**。`retain`/`release` 的配对是看板最容易出错的地方（多释放一次宿主引用计数错位，少释放一次就永久持有会话），抽成 `slot-retain.js` 的独立模块，配对关系才能被直接断言。释放先于保留，且不受会话服务可用与否影响——保留的副作用正是阻止宿主回收会话，服务不可用这段时间里也得把不再需要的会话放掉。

**组件的可判定逻辑拆成纯模块**。bundle 的运行时依赖只有 Node 内置模块，React 来自宿主、不在本仓依赖里——组件本身进不了单测，引入 jsdom 也不划算（本仓刻意不引）。于是把「能判定的那部分」从组件里拆出来：`link-row.js`（链接能否跳转、chip 的 key、排布计划）、`modal-focus.js`（初始焦点、Tab 绕回、Escape 动作）、`card-detail-view.js`（详情分段内容）。组件只管把纯模块的结果渲染出来。这样「Tab 到边缘要绕回」「没有进展就不出现该段」这类最容易写错的规则能被直接断言，而不是靠肉眼数 DOM。

**详情浮层只读**，用 `headless` 模式自带头部（标题就是卡片标题本身，不用宿主默认的「无信息标题」）。卡片写权限归协调者工具，UI 不越权写。

**浮层外壳抽成 `modal-shell.js`** 供确认弹窗与详情浮层共用：portal、遮罩、ESC、Tab 焦点陷阱、初始焦点、关闭回焦，以及宿主 `Modal.module.css` 的样式全文（style id `dsh-leader-kit-modal`）。`confirm-dialog.js` 改为复用它，行为不变。

**焦点的抑制与释放整段照抄宿主 `focus.ts`**：只设 `data-dsh-automatic-focus` 属性而照抄释放逻辑（失焦或键盘导航时撤掉），焦点环就再也回不来——简化这一段会削掉键盘可达性，属静默回归。

## 边界

- **「等你输入」档暂无数据源**：宿主有机制（`pendingInteraction`）但当前没有域发布，这一档不会亮（见 [capability-gaps 第 35 条](../../../../docs/capability-gaps.md)）。
- **详情浮层是打开瞬间的卡片快照**：卡片随后被协调者更新，浮层不会跟着刷新，要关掉重开。浮层只读，刷新它没有意义。
- **详情只读**：完成、置顶、重命名、删除需要新增一组卡片远程方法（本仓的 Typert 写通道已有，缺的是卡片方法本身），属独立议题。
- **无 workspace chip**：卡片按项目归属，不按工作区分区；编号全局递增（见[卡片存储与编号作用域](../architecture/2026-10-23-card-storage-and-numbering-scope.md)）。
- **浮层与宿主 Modal 是复制改写**：宿主改 `Modal.tsx` 时本仓要同步（与确认弹窗同一条耦合）。
- **卡面根的 ARIA 冲突**：见上。
- **看板会保留槽位会话**：`retain` 的会话在卡片撤掉该槽位后释放，否则状态表会随卡片增删漂移。

## 证据

单测 246 例全绿（本 PR 累计新增 34 例：槽位绑定提取、槽位视图、信号档位、active 排序、done 排序、停滞判定（含「会话在跑不算停滞」「状态不可知不算停滞」）、时长格式化、链接排布（含「间距非法时全量展示」），「等你输入 / 未读」两档的聚合与两个来源的合并规则，事件增量的六条分派规则，会话保留的六条配对规则，以及链接 chip 的判定与 key、排布计划、浮层焦点循环与 Escape 判定、详情分段内容共 20 例）。

真实实例取证用隔离 mock profile（`DSH_HOME=/tmp/dsh-mock`）：mock provider 发 `create_card` / `update_card` / `spawn_worker` 工具调用，**真实卡片工具与真实派工执行** → 投影进 session log → 看板渲染，全程不触达真实 API。截图不入仓库（证据图不进 git），见 PR #4 的评论「证据」条：改前（P2 旧卡面）、改后、详情浮层、悬停态、已完成区展开五张，另加一张「未读档」取证。改前/改后取自同一会话的同一批卡片。

**未读档实测**：mock provider 派一个 worker 子会话，worker 跑完停下；看板上该卡槽位点变蓝（未读），同一会话里的协调者自身卡片是灰（空闲——主视图看过的会话未读被清），绑不存在会话的卡仍是虚线圈（状态未知）。

**增量重放实测**：新会话跑完一轮（派工 → 建 4 张卡 → 标记 1 张完成），看板在挂载状态下从 0 张变 4 张 active + 1 张 done，编号续到全局序号，槽位点分别落在未读、空闲、状态未知、无信号四档；状态不可知的卡不再被误标「停滞」；chip 间距从 CSS 读到 `4px`；控制台无报错。

**浮层焦点实测**：点卡面开详情浮层，浮层里可聚焦元素是两个（关闭按钮、链接），连按 6 次 Tab 在两者间往返且焦点始终在浮层内；Shift+Tab 从首元素绕到末元素；Escape 关闭浮层后焦点回到刚才点的卡面。分段只出现有内容的那些（说明 / 当前进展 / 链接，下一步与阻塞为空时不出现）。
