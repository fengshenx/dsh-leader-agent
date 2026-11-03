/**
 * 看板的纯投影逻辑。
 *
 * 两部分都不碰 React，便于单测——面板组件只负责渲染：
 *
 * - **看板投影**：把卡片与槽位会话状态投影成信号灯、排序与停滞判定；
 * - **排布计算**：链接 chip 一行放得下几个。
 *
 * 卡片本身从宿主取（`src/client/project-board-data.js`），这里只管「卡片加上会话
 * 状态之后怎么显示」。
 *
 * 信号灯是实时投影零存储：推进/需注意/空闲/未知全部由槽位绑定的会话状态推导，
 * 卡片本体只存显式状态（active/done/archived）。发现任何「可从会话推导的字段落进
 * 卡片存储」即为设计缺陷。
 *
 * @module dsh-leader-kit/client/board-projection
 */

/**
 * 停滞阈值：名下有会话但 24h 无活动。
 */
export const STALLED_THRESHOLD_MS = 24 * 60 * 60 * 1000

/**
 * 槽位状态。
 *
 * - `waiting`：槽位会话在等用户交互（宿主发布了待处理交互请求）；
 * - `attention`：槽位会话最后一次执行失败；
 * - `running`：槽位会话正在执行；
 * - `unread`：槽位会话已停下，且这次停止还没被主视图确认；
 * - `idle`：槽位会话已知且空闲；
 * - `empty`：槽位没有绑定会话（未派工）；
 * - `unknown`：绑定了会话但客户端读不到它的状态（会话不可达）。
 *
 * `empty` 与 `unknown` 都不谎称空闲：前者根本没派活，后者状态不可知。
 */
export const SLOT_STATES = Object.freeze([
  'waiting', 'attention', 'running', 'unread', 'idle', 'empty', 'unknown',
])

/**
 * 卡片级信号灯档位。聚合规则见 {@link cardSignal}.
 */
export const CARD_SIGNALS = Object.freeze([
  'waiting', 'attention', 'running', 'unread', 'idle', 'unknown', 'none',
])

/**
 * 槽位的看板状态。
 *
 * @typedef {object} BoardSlotView
 * @property {string} name - 槽位名
 * @property {string} sessionId - 绑定的会话 id；未绑定时为空串
 * @property {'waiting'|'attention'|'running'|'unread'|'idle'|'empty'|'unknown'} state - 槽位状态
 */

/**
 * 会话的看板可见状态。
 *
 * @typedef {object} BoardSessionState
 * @property {boolean} known - 是否读到了该会话的状态
 * @property {boolean} running - 会话正在执行
 * @property {boolean} waiting - 会话在等用户交互
 * @property {boolean} unread - 会话已停下且未被主视图确认
 * @property {boolean} failed - 会话最后一次执行失败
 */

/**
 * 合并两个来源的会话状态。
 *
 * `status` 是宿主客户端状态存储给的会话状态（`SessionStatus`：权威运行态、
 * 待处理交互、未读确认），`snapshot` 是保留会话后从 `SessionSnapshot` 读到的
 * 失败信息——宿主没有在会话状态里带失败原因，那一项只能从会话快照取。
 *
 * 宿主给出运行态但它还没建立基线（`running` 为 `undefined`）时，状态判为未知：
 * 快照里的 `running` 对列表兜底出来的会话（如历史 subagent 时代的 worker）只是
 * 兜底值，据此说「空闲」是撒谎。
 *
 * @param {object|undefined} status - 宿主会话状态
 * @param {object|undefined} snapshot - 保留会话的快照状态
 * @returns {BoardSessionState} 合并后的状态
 */
export function mergeSessionState(status, snapshot) {
  if (status !== undefined) {
    return {
      known: status.running !== undefined,
      running: status.running === true,
      waiting: status.pendingInteraction !== undefined,
      unread: status.completionUnread === true,
      failed: snapshot?.failed === true,
    }
  }
  return {
    known: snapshot !== undefined,
    running: snapshot?.running === true,
    waiting: false,
    unread: false,
    failed: snapshot?.failed === true,
  }
}

/**
 * 取卡片绑定的槽位。
 *
 * 槽位绑定是 `{ 槽位名: { sessionId } }`；结构不对的条目整体跳过，不猜。
 * 槽位存在但没有可用 sessionId 时保留该槽位（状态为 `empty`）：「这个角色还没
 * 派工」本身就是要显示的状态。
 *
 * @param {object} card - 卡片
 * @returns {Array<{ name: string, sessionId: string }>} 槽位名与绑定会话 id
 */
export function slotBindingsOf(card) {
  const slots = card?.slots
  if (slots === null || typeof slots !== 'object' || Array.isArray(slots)) return []
  const bindings = []
  for (const [name, binding] of Object.entries(slots)) {
    if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) continue
    const sessionId = typeof binding.sessionId === 'string' && binding.sessionId !== ''
      ? binding.sessionId
      : ''
    bindings.push({ name, sessionId })
  }
  return bindings
}

/**
 * 单个槽位的状态。
 *
 * 绑定了会话但状态读不到时是 `unknown` 而不是 `idle`：把不可知说成空闲，
 * 等于在卡面上撒一个不实的信号。档位顺序：等你输入 > 需注意 > 执行中 >
 * 未读 > 空闲。
 *
 * @param {string} sessionId - 绑定的会话 id
 * @param {ReadonlyMap<string, BoardSessionState>} states - 会话 id 到状态
 * @returns {'waiting'|'attention'|'running'|'unread'|'idle'|'empty'|'unknown'} 槽位状态
 */
function slotStateOf(sessionId, states) {
  if (sessionId === '') return 'empty'
  const state = states.get(sessionId)
  if (state === undefined || !state.known) return 'unknown'
  if (state.waiting) return 'waiting'
  if (state.failed) return 'attention'
  if (state.running) return 'running'
  if (state.unread) return 'unread'
  return 'idle'
}

/**
 * 卡片的全部槽位视图（声明序 = 卡片 `slots` 的键序）。
 *
 * 只列卡片自己声明的槽位：dsh 的槽位集合由项目 `SLOTS.md` 决定，客户端不知道，
 * 渲染没声明的槽位等于宣称存在一个不存在的 worker。
 *
 * @param {object} card - 卡片
 * @param {ReadonlyMap<string, BoardSessionState>} states - 会话 id 到状态
 * @returns {BoardSlotView[]} 槽位视图
 */export function slotViewsForCard(card, states) {
  return slotBindingsOf(card).map(({ name, sessionId }) => ({
    name,
    sessionId,
    state: slotStateOf(sessionId, states),
  }))
}

/**
 * 卡片信号灯：由名下槽位会话聚合。
 *
 * 取名下槽位里档位最高的一档。优先级：等你输入 > 需注意 > 执行中 > 未读 >
 * 空闲 > 未派工 > 状态未知。等你输入压过需注意——有人在等你，别的都不急；
 * 需注意压过执行中：失败是更该先看的事实，worker 可能还在跑但已经错了。
 * 卡片本体不存信号——信号由会话状态实时推导。
 *
 * @param {object} card - 卡片
 * @param {ReadonlyMap<string, BoardSessionState>} states - 会话 id 到状态
 * @returns {'waiting'|'attention'|'running'|'unread'|'idle'|'unknown'|'none'} 信号档位
 */
export function cardSignal(card, states) {
  if (card?.status === 'done') return 'none'
  const slots = slotViewsForCard(card, states)
  if (slots.length === 0) return 'none'
  let best = 'none'
  let bestRank = signalRank('none')
  for (const slot of slots) {
    const rank = signalRank(slot.state)
    if (rank < bestRank) {
      best = slot.state
      bestRank = rank
    }
  }
  return best
}

/**
 * 信号档位的排序权重（值越小越靠前）。
 *
 * 未派工与不可知都收在末尾；未派工与「无信号」同权重——卡片有槽位但都没派活，
 * 卡片级的说法就是「无信号」，把「未派工」抬到卡片级等于宣称存在一个状态档。
 *
 * @param {string} signal - 信号档位
 * @returns {number} 权重
 */
function signalRank(signal) {
  switch (signal) {
    case 'waiting': return 0
    case 'attention': return 1
    case 'running': return 2
    case 'unread': return 3
    case 'idle': return 4
    case 'unknown': return 6
    default: return 7
  }
}

/**
 * 收件箱序排序 active 卡：信号档位升序 → 显式 sortOrder 升序（未设置排后）→
 * 最后活动降序 → 编号升序。档位按 dsh 可得的会话状态收敛。
 *
 * @param {readonly object[]} cards - 卡片列表
 * @param {ReadonlyMap<string, BoardSessionState>} states - 会话 id 到状态
 * @returns {object[]} 排好序的卡片
 */
export function sortActiveCards(cards, states) {
  return [...cards].sort((left, right) => {
    const rank = signalRank(cardSignal(left, states)) - signalRank(cardSignal(right, states))
    if (rank !== 0) return rank
    if (left.sortOrder !== right.sortOrder) {
      if (left.sortOrder === undefined) return 1
      if (right.sortOrder === undefined) return -1
      return left.sortOrder - right.sortOrder
    }
    const activity = (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    if (activity !== 0) return activity
    return (left.number ?? 0) - (right.number ?? 0)
  })
}

/**
 * done 卡按完成时间倒序（折叠区展示序）。
 *
 * @param {readonly object[]} cards - 卡片列表
 * @returns {object[]} 排好序的卡片
 */
export function sortDoneCards(cards) {
  return [...cards].sort((left, right) => {
    const activity = (right.doneAt ?? right.updatedAt ?? 0) - (left.doneAt ?? left.updatedAt ?? 0)
    if (activity !== 0) return activity
    return (left.number ?? 0) - (right.number ?? 0)
  })
}

/**
 * 把一次改卡的结果合进看板列表。
 *
 * 只替换同 id 的那张，其余保持原引用——列表每 2 秒换一次，整份重建会让所有
 * 卡面跟着重渲染。
 *
 * @param {readonly object[]} cards - 当前列表
 * @param {object} updated - 宿主返回的新卡片
 * @returns {object[]} 合并后的列表
 */
export function mergeCardUpdate(cards, updated) {
  if (updated === null || typeof updated !== 'object') return cards
  return cards.map((card) => (card.id === updated.id ? updated : card))
}

/**
 * 把一次改卡的结果合进详情浮层。
 *
 * 浮层里的卡片是打开瞬间的快照；保存返回时浮层可能已经关掉、又点开了另一张
 * 卡。只有浮层仍停在同一张卡上时才替换，否则 A 的保存结果会显示成 B 的内容。
 *
 * @param {{ card: object, anchor?: unknown } | null} current - 当前详情状态
 * @param {object} updated - 宿主返回的新卡片
 * @returns {{ card: object, anchor?: unknown } | null} 合并后的详情状态
 */
export function mergeDetailCard(current, updated) {
  if (current === null || current === undefined) return null
  if (updated === null || typeof updated !== 'object') return current
  return current.card?.id === updated.id ? { ...current, card: updated } : current
}

/**
 * 把一轮轮询结果合进看板列表。
 *
 * 本地刚回填过的卡片版本更高（保存链接后立刻回填，而在途的取数请求是保存之前
 * 发出的）：它的响应晚到时不能把内容打回旧值。同版本以宿主快照为准。
 *
 * @param {readonly object[]} current - 当前列表
 * @param {readonly object[]} next - 宿主快照
 * @returns {object[]} 合并后的列表
 */
export function mergeCardSnapshot(current, next) {
  const byId = new Map(current.map((card) => [card.id, card]))
  return next.map((card) => {
    const kept = byId.get(card.id)
    return kept !== undefined && (kept.revision ?? 0) > (card.revision ?? 0) ? kept : card
  })
}

/**
 * 停滞判定：名下有会话、会话都不在跑、且超过阈值没有更新。
 *
 * 没有绑定会话的卡不参与停滞计时——那是「没开始」不是「卡住」。会话正在跑的卡
 * 同样不算停滞——它正在干活，只是 leader 没更新卡片。
 *
 * 状态不可知的会话也不算停滞：读不到运行态不等于它停了，断言「卡住」同样是
 * 撒谎。这与信号灯的口径一致——状态不可知显示「状态未知」，不冒充空闲。
 *
 * 活动的度量只能用卡片自己的 `updatedAt`：dsh 会话列表的 `updatedAt` 是「最后一次
 * 被提示的时间」（`packages/api/session-controller/src/list.ts:360`），不是会话的
 * 最后活动时间，拿它当活动度量会把「在跑」误判成「卡住」。
 *
 * @param {object} card - 卡片
 * @param {ReadonlyMap<string, BoardSessionState>} states - 会话 id 到状态
 * @param {number} now - 当前时间戳
 * @returns {boolean} 是否停滞
 */
export function isCardStalled(card, states, now) {
  if (card?.status !== 'active') return false
  const bound = slotBindingsOf(card).filter((binding) => binding.sessionId !== '')
  if (bound.length === 0) return false
  const boundStates = bound.map((binding) => states.get(binding.sessionId))
  if (boundStates.some((state) => state === undefined || state.known !== true)) return false
  if (boundStates.some((state) => state.running === true)) return false
  return now - (card.updatedAt ?? 0) > STALLED_THRESHOLD_MS
}

/**
 * 时长展示（Xd / Xh）。
 *
 * 差值钳制非负：完成瞬间 `doneAt` 可能领先渲染层的 `now`，负数一律显示 0h。
 *
 * @param {number} since - 起始时间戳
 * @param {number} now - 当前时间戳
 * @returns {string} 时长文案
 */
export function formatDuration(since, now) {
  const hours = Math.floor(Math.max(0, now - since) / (60 * 60 * 1000))
  return hours >= 24 ? `${Math.floor(hours / 24)}d` : `${hours}h`
}

/**
 * 一行放得下几个链接 chip。
 *
 * 宽度没量出来时返回全部：测量发生在布局之后，首帧还没有布局数据，此时全量展示
 * 而不是藏链接。只有「放不下全部」才为「+N」预留一格；预留后连第一个都放不下
 * 则返回 0，让唯一可见入口是自己。
 *
 * @param {object} input - 输入
 * @param {number} input.availableWidth - 链接行可用宽度（已扣掉左侧缩进）
 * @param {readonly number[]} input.chipWidths - 各 chip 的实测宽度，按渲染顺序
 * @param {number} input.overflowWidth - 「+N」chip 的实测宽度
 * @param {number} input.gap - 相邻 chip 间距
 * @returns {number} 可见 chip 数
 */
export function fitLinkChips({ availableWidth, chipWidths, overflowWidth, gap }) {
  const total = chipWidths.length
  if (total === 0) return 0
  const usable = (value) => Number.isFinite(value) && value > 0
  if (
    !usable(availableWidth)
    || !Number.isFinite(overflowWidth)
    || overflowWidth < 0
    || !Number.isFinite(gap)
    || gap < 0
    || chipWidths.some((width) => !usable(width))
  ) {
    return total
  }
  let used = 0
  let visible = 0
  for (const [index, width] of chipWidths.entries()) {
    const next = used + (index > 0 ? gap : 0) + width
    // 这一格放下之后，若还有剩余 chip，还得容得下「间距 + +N」
    const fitsOverflowAfter = index === chipWidths.length - 1 || next + gap + overflowWidth <= availableWidth
    if (next > availableWidth || !fitsOverflowAfter) break
    used = next
    visible = index + 1
  }
  return visible
}
