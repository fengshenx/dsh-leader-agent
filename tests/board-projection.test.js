import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  STALLED_THRESHOLD_MS,
  cardSignal,
  fitLinkChips,
  formatDuration,
  isCardStalled,
  mergeCardSnapshot,
  mergeCardUpdate,
  mergeDetailCard,
  mergeSessionState,
  slotBindingsOf,
  slotViewsForCard,
  sortActiveCards,
  sortDoneCards,
} from '../src/client/board-projection.js'

/**
 * 造一张带槽位绑定的卡。
 * @param {object} [overrides] - 覆盖字段
 * @returns {object} 卡片
 */
function card(overrides = {}) {
  return { id: 'c', number: 1, title: '标题', status: 'active', ...overrides }
}

/**
 * 造一份会话状态表。
 * @param {Array<[string, object]>} entries - 会话 id 到状态
 * @returns {Map<string, object>} 状态表
 */
function states(entries) {
  return new Map(entries)
}

/**
 * 构造一份会话状态，字段与 `mergeSessionState` 的产出同形。
 *
 * @param {object} overrides - 覆盖的字段
 * @returns {object} 会话状态
 */
function sessionState(overrides = {}) {
  return {
    known: true,
    running: false,
    waiting: false,
    unread: false,
    failed: false,
    ...overrides,
  }
}

test('槽位绑定取 sessionId，结构非法的条目被跳过', () => {
  const bindings = slotBindingsOf(card({
    slots: {
      dev: { sessionId: 's1' },
      review: {},
      broken: 'nope',
      arr: [],
    },
  }))
  assert.deepEqual(bindings, [
    { name: 'dev', sessionId: 's1' },
    { name: 'review', sessionId: '' },
  ])
  assert.deepEqual(slotBindingsOf(card({ slots: null })), [])
  assert.deepEqual(slotBindingsOf(card({ slots: [] })), [])
  assert.deepEqual(slotBindingsOf(card()), [])
})

test('槽位状态按会话状态映射，读不到状态时是 unknown 而不是空闲', () => {
  const views = slotViewsForCard(card({
    slots: {
      dev: { sessionId: 's1' },
      review: { sessionId: 's2' },
      idleSlot: { sessionId: 's3' },
      failedSlot: { sessionId: 's4' },
      freeSlot: {},
    },
  }), states([
    ['s1', sessionState({ running: true })],
    ['s3', sessionState()],
    ['s4', sessionState({ failed: true })],
  ]))
  assert.deepEqual(
    views.map((view) => [view.name, view.state]),
    [
      ['dev', 'running'],
      ['review', 'unknown'],
      ['idleSlot', 'idle'],
      ['failedSlot', 'attention'],
      ['freeSlot', 'empty'],
    ],
  )
})

test('卡片信号按等你输入 > 需注意 > 推进中 > 未读 > 空闲 > 未知 > 未派工聚合', () => {
  assert.equal(cardSignal(card({ slots: { a: { sessionId: 's1' } } }), states([
    ['s1', sessionState({ running: true })],
  ])), 'running')
  assert.equal(cardSignal(card({ slots: {
    a: { sessionId: 's1' },
    b: { sessionId: 's2' },
  } }), states([
    ['s1', sessionState({ running: true })],
    ['s2', sessionState({ failed: true })],
  ])), 'attention')
  assert.equal(cardSignal(card({ slots: { a: { sessionId: 's1' } } }), states([
    ['s1', sessionState()],
  ])), 'idle')
  assert.equal(cardSignal(card({ slots: { a: { sessionId: 's1' } } }), new Map()), 'unknown')
  assert.equal(cardSignal(card({ slots: { a: {} } }), new Map()), 'none')
  assert.equal(cardSignal(card(), new Map()), 'none')
  assert.equal(cardSignal(card({ status: 'done', slots: { a: { sessionId: 's1' } } }), states([
    ['s1', sessionState({ running: true, failed: true })],
  ])), 'none')
})

test('等你输入压过需注意，未读压过空闲', () => {
  assert.equal(cardSignal(card({ slots: { a: { sessionId: 's1' } } }), states([
    ['s1', sessionState({ waiting: true, failed: true })],
  ])), 'waiting')
  assert.equal(cardSignal(card({ slots: { a: { sessionId: 's1' } } }), states([
    ['s1', sessionState({ unread: true })],
  ])), 'unread')
  assert.equal(cardSignal(card({ slots: {
    a: { sessionId: 's1' },
    b: { sessionId: 's2' },
  } }), states([
    ['s1', sessionState({ running: true })],
    ['s2', sessionState({ unread: true })],
  ])), 'running')
})

test('未派工的槽位不抬高卡片信号', () => {
  assert.equal(cardSignal(card({ slots: {
    a: { sessionId: 's1' },
    b: {},
  } }), states([
    ['s1', sessionState()],
  ])), 'idle')
})

test('会话状态合并：宿主状态优先，未建立基线不谎称空闲', () => {
  assert.deepEqual(
    mergeSessionState(
      { running: true, pendingInteraction: undefined, completionUnread: false },
      { running: false, failed: true },
    ),
    { known: true, running: true, waiting: false, unread: false, failed: true },
  )
  assert.deepEqual(
    mergeSessionState(
      { running: false, pendingInteraction: { key: 'k', kind: 'approval', sessionId: 's1' }, completionUnread: true },
      undefined,
    ),
    { known: true, running: false, waiting: true, unread: true, failed: false },
  )
  // 宿主给了条目但运行态还没建立基线：判未知，不拿快照里的兜底值说空闲
  assert.deepEqual(
    mergeSessionState(
      { running: undefined, pendingInteraction: undefined, completionUnread: false },
      { running: false, failed: false },
    ),
    { known: false, running: false, waiting: false, unread: false, failed: false },
  )
  // 宿主没给状态（未挂 ui-session）：退回快照，等你输入与未读无从表达
  assert.deepEqual(
    mergeSessionState(undefined, { running: true, failed: false }),
    { known: true, running: true, waiting: false, unread: false, failed: false },
  )
  assert.deepEqual(
    mergeSessionState(undefined, undefined),
    { known: false, running: false, waiting: false, unread: false, failed: false },
  )
})

test('active 卡排序按信号档位、sortOrder、最后活动、编号依次决胜', () => {
  const table = states([
    ['running', sessionState({ running: true })],
    ['failed', sessionState({ failed: true })],
  ])
  const cards = [
    card({ id: 'idle', number: 1, slots: { a: { sessionId: 'idle' } } }),
    card({ id: 'none', number: 2 }),
    card({ id: 'attention', number: 3, slots: { a: { sessionId: 'failed' } } }),
    card({ id: 'running', number: 4, slots: { a: { sessionId: 'running' } } }),
  ]
  assert.deepEqual(
    sortActiveCards(cards, table).map((entry) => entry.id),
    ['attention', 'running', 'idle', 'none'],
  )
  const pinned = [
    card({ id: 'noOrder', number: 1, updatedAt: 100 }),
    card({ id: 'order2', number: 2, sortOrder: 2, updatedAt: 300 }),
    card({ id: 'order1', number: 3, sortOrder: 1, updatedAt: 200 }),
  ]
  assert.deepEqual(
    sortActiveCards(pinned, new Map()).map((entry) => entry.id),
    ['order1', 'order2', 'noOrder'],
  )
  const sameLevel = [
    card({ id: 'older', number: 1, updatedAt: 100 }),
    card({ id: 'newer', number: 2, updatedAt: 200 }),
  ]
  assert.deepEqual(
    sortActiveCards(sameLevel, new Map()).map((entry) => entry.id),
    ['newer', 'older'],
  )
  const sameActivity = [
    card({ id: 'b', number: 2, updatedAt: 100 }),
    card({ id: 'a', number: 1, updatedAt: 100 }),
  ]
  assert.deepEqual(
    sortActiveCards(sameActivity, new Map()).map((entry) => entry.id),
    ['a', 'b'],
  )
})

test('done 卡按完成时间倒序', () => {
  const cards = [
    card({ id: 'old', number: 1, status: 'done', doneAt: 100 }),
    card({ id: 'new', number: 2, status: 'done', doneAt: 300 }),
    card({ id: 'mid', number: 3, status: 'done', doneAt: 200 }),
  ]
  assert.deepEqual(
    sortDoneCards(cards).map((entry) => entry.id),
    ['new', 'mid', 'old'],
  )
})

test('停滞判定要求有绑定会话且超过阈值，非 active 不计时', () => {
  const now = 100 * 60 * 60 * 1000
  const bound = { status: 'active', slots: { a: { sessionId: 's1' } } }
  const idle = { status: 'active', slots: { a: {} } }
  const states = new Map([['s1', sessionState()]])
  assert.equal(isCardStalled({ ...bound, updatedAt: now - STALLED_THRESHOLD_MS - 1 }, states, now), true)
  assert.equal(isCardStalled({ ...bound, updatedAt: now - STALLED_THRESHOLD_MS }, states, now), false)
  assert.equal(isCardStalled({ ...idle, updatedAt: 0 }, states, now), false)
  assert.equal(isCardStalled({ ...bound, status: 'done', updatedAt: 0 }, states, now), false)
  assert.equal(isCardStalled({ ...bound, updatedAt: now }, states, now), false)
})

test('停滞判定：会话状态不可知时不断言卡住', () => {
  const now = 100 * 60 * 60 * 1000
  const target = { status: 'active', slots: { a: { sessionId: 's1' } }, updatedAt: 0 }
  const unknown = new Map([['s1', sessionState({ known: false })]])
  assert.equal(isCardStalled(target, unknown, now), false)
  assert.equal(isCardStalled(target, new Map(), now), false)
})

test('停滞判定：名下会话正在跑不算停滞', () => {
  const now = 100 * 60 * 60 * 1000
  const card = { status: 'active', slots: { a: { sessionId: 's1' } }, updatedAt: 0 }
  const running = new Map([['s1', sessionState({ running: true })]])
  assert.equal(isCardStalled(card, running, now), false)
  const idle = new Map([['s1', sessionState()]])
  assert.equal(isCardStalled(card, idle, now), true)
})

test('时长文案按小时或天展示，负差值钳制为 0h', () => {
  const now = 100 * 60 * 60 * 1000
  assert.equal(formatDuration(now - 3 * 60 * 60 * 1000, now), '3h')
  assert.equal(formatDuration(now - 26 * 60 * 60 * 1000, now), '1d')
  assert.equal(formatDuration(now + 60 * 60 * 1000, now), '0h')
  assert.equal(formatDuration(now, now), '0h')
})

test('链接 chip 排布：宽度未量出时全量展示，放不下时为 +N 预留', () => {
  assert.equal(fitLinkChips({
    availableWidth: 0,
    chipWidths: [50, 60],
    overflowWidth: 30,
    gap: 6,
  }), 2)
  assert.equal(fitLinkChips({
    availableWidth: 200,
    chipWidths: [50, 50, 50],
    overflowWidth: 30,
    gap: 6,
  }), 3)
  assert.equal(fitLinkChips({
    availableWidth: 120,
    chipWidths: [50, 50, 50],
    overflowWidth: 30,
    gap: 6,
  }), 1)
  assert.equal(fitLinkChips({
    availableWidth: 40,
    chipWidths: [50],
    overflowWidth: 30,
    gap: 6,
  }), 0)
  assert.equal(fitLinkChips({
    availableWidth: 200,
    chipWidths: [],
    overflowWidth: 30,
    gap: 6,
  }), 0)
})

test('链接 chip 排布：间距非法时全量展示，不藏链接', () => {
  assert.equal(fitLinkChips({
    availableWidth: 100,
    chipWidths: [50, 50],
    overflowWidth: 20,
    gap: Number.NaN,
  }), 2)
  assert.equal(fitLinkChips({
    availableWidth: 100,
    chipWidths: [50, 50],
    overflowWidth: 20,
    gap: -1,
  }), 2)
})

test('改卡结果只替换同 id 的那张，其余保持原引用', () => {
  const first = { id: 'c1', revision: 0, links: [] }
  const second = { id: 'c2', revision: 0, links: [] }
  const updated = { id: 'c2', revision: 1, links: [{ label: 'PR' }] }

  const merged = mergeCardUpdate([first, second], updated)
  assert.equal(merged[0], first)
  assert.equal(merged[1], updated)
  // 不是对象（宿主异常返回）时原样返回同一份列表，不把列表打坏
  const cards = [first, second]
  assert.equal(mergeCardUpdate(cards, undefined), cards)
  assert.equal(mergeCardUpdate(cards, null), cards)
})

test('保存期间切到另一张卡，旧卡结果不落到新卡', () => {
  const cardA = { id: 'c1', revision: 1, links: [] }
  const cardB = { id: 'c2', revision: 1, links: [] }
  const detailB = { card: cardB, anchor: { x: 1 } }
  const savedA = { id: 'c1', revision: 2, links: [{ label: 'PR' }] }

  // A 的保存响应晚到，浮层已经是 B：原样保留 B，连对象引用都不变
  const kept = mergeDetailCard(detailB, savedA)
  assert.equal(kept, detailB)
  assert.equal(kept.card.id, 'c2')

  // 浮层仍是 A 时才替换卡片，anchor 跟着保留
  const detailA = { card: cardA, anchor: { x: 2 } }
  const merged = mergeDetailCard(detailA, savedA)
  assert.notEqual(merged, detailA)
  assert.equal(merged.card, savedA)
  assert.equal(merged.anchor, detailA.anchor)

  // 浮层已经关掉
  assert.equal(mergeDetailCard(null, savedA), null)
})

test('轮询快照不覆盖版本更高的本地回填', () => {
  const local = { id: 'c1', revision: 3, links: [{ label: '刚保存的' }] }
  const fresh = { id: 'c2', revision: 0, links: [] }

  // 在途请求是保存之前发出的，晚到时带回的是旧版本
  const merged = mergeCardSnapshot([local], [{ id: 'c1', revision: 2, links: [] }, fresh])
  assert.equal(merged[0], local)
  assert.equal(merged[1], fresh)

  // 同版本以宿主快照为准：别处（leader）的改动照样能落到看板
  const equal = mergeCardSnapshot([local], [{ id: 'c1', revision: 3, links: [{ label: '别处改的' }] }])
  assert.equal(equal[0].links[0].label, '别处改的')
})
