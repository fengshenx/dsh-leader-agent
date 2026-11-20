import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  applyHideState,
  ensureLeaderChangesStyles,
  HIDE_ATTR,
  isLeaderSession,
  watchLeaderChanges,
} from '../src/client/leader-changes.js'

/**
 * 造一个够用的 document 桩。
 *
 * 幂等判重靠 `getElementById`，桩要像真实 DOM 一样记住已插入的节点。
 *
 * @returns {object[]} 已追加到 head 的节点
 */
function installDocument() {
  const head = []
  const byId = new Map()
  globalThis.document = {
    head: {
      append(node) {
        head.push(node)
        if (node.id !== '') byId.set(node.id, node)
      },
    },
    createElement(tag) {
      return { tag, id: '', textContent: '' }
    },
    getElementById(id) {
      return byId.get(id) ?? null
    },
  }
  return head
}

/** 造一个观察器夹具，记录 observe 选项与节流回调。 */
function makeObserverHarness() {
  const callbacks = []
  const timers = []
  const observations = []
  class FakeObserver {
    constructor(callback) {
      callbacks.push(callback)
    }

    observe(target, options) {
      observations.push({ target, options })
    }

    disconnect() {}
  }
  return {
    FakeObserver,
    callbacks,
    observations,
    schedule: (callback) => {
      timers.push(callback)
      return timers.length
    },
    flush: () => timers.shift()?.(),
  }
}

/** 造一个只记录标记的容器桩。 */
function makeColumn() {
  const attributes = new Map()
  return {
    setAttribute(name, value) {
      attributes.set(name, value)
    },
    removeAttribute(name) {
      attributes.delete(name)
    },
    has(name) {
      return attributes.has(name)
    },
  }
}

afterEach(() => {
  delete globalThis.document
})

test('只有名单里的 leader 会话要隐藏卡片', () => {
  const leaders = new Set(['leader-a', 'leader-b'])
  assert.equal(isLeaderSession(leaders, 'leader-a'), true)
  assert.equal(isLeaderSession(leaders, 'worker-a'), false)
  assert.equal(isLeaderSession(leaders, 'ordinary'), false)
  assert.equal(isLeaderSession(leaders, undefined), false)
  assert.equal(isLeaderSession(leaders, ''), false)
  assert.equal(isLeaderSession(undefined, 'leader-a'), false)
})

test('隐藏标记按判定加上与摘掉', () => {
  const column = makeColumn()
  applyHideState(column, true)
  assert.equal(column.has(HIDE_ATTR), true)
  applyHideState(column, false)
  assert.equal(column.has(HIDE_ATTR), false)
})

test('容器缺失时安静返回，不抛错', () => {
  assert.doesNotThrow(() => applyHideState(null, true))
  assert.doesNotThrow(() => applyHideState(undefined, false))
})

test('样式表把标记作用域下的改动卡片藏掉，且只注入一次', () => {
  const head = installDocument()
  ensureLeaderChangesStyles()
  ensureLeaderChangesStyles()
  assert.equal(head.length, 1)
  assert.equal(head[0].id, 'dsh-leader-agent-leader-changes')
  assert.match(head[0].textContent, new RegExp(`\\[${HIDE_ATTR}\\] \\[data-changed-files\\]`))
  assert.match(head[0].textContent, /display: none !important/)
})

test('没有 document 时样式注入直接返回', () => {
  delete globalThis.document
  assert.doesNotThrow(() => ensureLeaderChangesStyles())
})

test('切换主面板后旧 column 摘标记，卸载时 observer 断开', () => {
  const first = makeColumn()
  const second = makeColumn()
  let slot = first
  const callbacks = []
  const timers = []
  let observed = 0
  let disconnected = 0
  let cancelled = 0

  class FakeObserver {
    constructor(callback) {
      callbacks.push(callback)
    }

    observe() {
      observed += 1
    }

    disconnect() {
      disconnected += 1
    }
  }

  const cleanup = watchLeaderChanges(true, {
    documentRef: { body: {} },
    findPanel: () => slot,
    Observer: FakeObserver,
    schedule: (callback) => {
      timers.push(callback)
      return timers.length
    },
    cancel: () => { cancelled += 1 },
  })

  assert.equal(first.has(HIDE_ATTR), true)
  assert.equal(second.has(HIDE_ATTR), false)
  assert.equal(observed, 1)

  slot = second
  callbacks[0]()
  assert.equal(timers.length, 1)
  timers[0]()
  assert.equal(first.has(HIDE_ATTR), false, '旧主面板不能留着跨会话的隐藏标记')
  assert.equal(second.has(HIDE_ATTR), true)

  callbacks[0]()
  cleanup()
  assert.equal(disconnected, 1)
  assert.equal(cancelled, 1, '清理时必须取消未执行的节流任务')
  assert.equal(second.has(HIDE_ATTR), false)
})

test('不需要隐藏时不创建 observer', () => {
  let constructed = 0
  class FakeObserver {
    constructor() { constructed += 1 }
    observe() {}
    disconnect() {}
  }
  const column = makeColumn()
  const cleanup = watchLeaderChanges(false, {
    documentRef: { body: {} },
    findPanel: () => column,
    Observer: FakeObserver,
    schedule: () => 1,
    cancel: () => {},
  })
  assert.equal(constructed, 0)
  assert.equal(column.has(HIDE_ATTR), false)
  cleanup()
})

test('findPanel 返回 null 时摘掉旧标记', () => {
  const panel = makeColumn()
  let present = true
  const harness = makeObserverHarness()
  const cleanup = watchLeaderChanges(true, {
    documentRef: { body: {} },
    findPanel: () => present ? panel : null,
    Observer: harness.FakeObserver,
    schedule: harness.schedule,
    cancel: () => {},
  })

  assert.equal(panel.has(HIDE_ATTR), true)
  present = false
  harness.callbacks[0]()
  harness.flush()
  assert.equal(panel.has(HIDE_ATTR), false, '主面板消失后不能留着隐藏标记')
  cleanup()
})

test('宿主移除 mainPanel 类后卡片恢复，恢复 class 后重新隐藏', () => {
  const panel = makeColumn()
  let hasMainPanelClass = true
  const harness = makeObserverHarness()
  const cleanup = watchLeaderChanges(true, {
    documentRef: { body: {} },
    findPanel: () => hasMainPanelClass ? panel : null,
    Observer: harness.FakeObserver,
    schedule: harness.schedule,
    cancel: () => {},
  })

  assert.equal(panel.has(HIDE_ATTR), true)
  hasMainPanelClass = false
  harness.callbacks[0]()
  harness.flush()
  assert.equal(panel.has(HIDE_ATTR), false)

  hasMainPanelClass = true
  harness.callbacks[0]()
  harness.flush()
  assert.equal(panel.has(HIDE_ATTR), true, 'class 恢复后应重新加标记')
  cleanup()
})

test('observer 订阅 class 属性变化并重新判定', () => {
  const panel = makeColumn()
  const harness = makeObserverHarness()
  const cleanup = watchLeaderChanges(true, {
    documentRef: { body: {} },
    findPanel: () => panel,
    Observer: harness.FakeObserver,
    schedule: harness.schedule,
    cancel: () => {},
  })

  assert.deepEqual(harness.observations[0].options, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  })
  harness.callbacks[0]()
  harness.flush()
  assert.equal(panel.has(HIDE_ATTR), true)
  cleanup()
})
