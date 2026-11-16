import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addOpenTab,
  emptyTabStore,
  hasOpenTab,
  MAX_OPEN_TABS_PER_PROJECT,
  openTabIds,
  parseTabStore,
  removeOpenTab,
  resolveTabView,
  serializeTabStore,
  sessionLabel,
  tabAfterClose,
  tabIdForKey,
  workerTabState,
} from '../src/client/session-tabs-logic.js'

/** 项目摘要。 */
function project(overrides = {}) {
  return {
    id: 'p1',
    name: '网站改版',
    leaderSessionId: 'leader',
    leaderAlive: true,
    directory: '/work/site',
    ...overrides,
  }
}

/** 会话行。 */
function row(overrides = {}) {
  return { title: '会话', displayTitle: undefined, running: false, completed: false, ...overrides }
}

/** 常用输入。 */
function input(overrides = {}) {
  return {
    projects: [project()],
    groups: [{ projectId: 'p1', sessionIds: ['w1', 'w2'] }],
    rows: { w1: row({ displayTitle: '前端' }), w2: row({ title: '后端' }) },
    currentSessionId: 'leader',
    store: emptyTabStore(),
    ...overrides,
  }
}

test('parseTabStore：坏输入回空库', () => {
  assert.deepEqual(parseTabStore(undefined), emptyTabStore())
  assert.deepEqual(parseTabStore(''), emptyTabStore())
  assert.deepEqual(parseTabStore('{'), emptyTabStore())
  assert.deepEqual(parseTabStore('null'), emptyTabStore())
  assert.deepEqual(parseTabStore('{"version":2,"projects":{}}'), emptyTabStore())
  assert.deepEqual(parseTabStore('{"version":1,"projects":[]}'), emptyTabStore())
})

test('parseTabStore：过滤非法 id、去重并按上限截断', () => {
  const ids = Array.from({ length: MAX_OPEN_TABS_PER_PROJECT + 5 }, (_, index) => `s${index}`)
  const parsed = parseTabStore(JSON.stringify({
    version: 1,
    projects: {
      p1: ['w1', 'w1', '', 'w2', 42, ...ids],
      '': ['y'],
    },
  }))
  assert.deepEqual(Object.keys(parsed.projects), ['p1'])
  assert.equal(parsed.projects.p1.length, MAX_OPEN_TABS_PER_PROJECT)
  assert.deepEqual(parsed.projects.p1.slice(0, 2), ['w1', 'w2'])
})

test('parseTabStore：JSON 里的 __proto__ 键不污染原型', () => {
  // 对象字面量里的 `__proto__:` 是改原型语法、`JSON.stringify` 会丢掉它，
  // 必须用真正的 JSON 原文才测到目标。
  const parsed = parseTabStore('{"version":1,"projects":{"p1":["w1"],"__proto__":["evil"]}}')
  assert.deepEqual(parsed.projects.p1, ['w1'])
  assert.equal(Object.getPrototypeOf(parsed.projects), Object.prototype)
  assert.equal({}.evil, undefined)
})

test('serializeTabStore：只写规范后的内容', () => {
  const store = { version: 1, projects: { p1: ['w1', 'w1', 'w2'] } }
  assert.deepEqual(JSON.parse(serializeTabStore(store)), { version: 1, projects: { p1: ['w1', 'w2'] } })
  assert.deepEqual(JSON.parse(serializeTabStore(null)), { version: 1, projects: {} })
})

test('openTabIds：坏项目与坏条目都跳过', () => {
  assert.deepEqual(openTabIds(emptyTabStore(), ''), [])
  assert.deepEqual(openTabIds(emptyTabStore(), 'p1'), [])
  const store = { version: 1, projects: { p1: ['w1', 7, 'w2'] } }
  assert.deepEqual(openTabIds(store, 'p1'), ['w1', 'w2'])
})

test('addOpenTab：新增、去重与上限', () => {
  const first = addOpenTab(emptyTabStore(), 'p1', 'w1')
  assert.deepEqual(first.projects.p1, ['w1'])
  assert.equal(addOpenTab(first, 'p1', 'w1'), first)
  assert.deepEqual(addOpenTab(first, 'p1', 'w2').projects.p1, ['w1', 'w2'])
  assert.equal(addOpenTab(first, '', 'w2'), first)
  assert.equal(addOpenTab(first, 'p1', ''), first)
  const full = { version: 1, projects: { p1: Array.from({ length: MAX_OPEN_TABS_PER_PROJECT }, (_, i) => `s${i}`) } }
  assert.equal(addOpenTab(full, 'p1', 'nope'), full)
})

test('removeOpenTab：删条目、删空项目与无变化原样返回', () => {
  const store = { version: 1, projects: { p1: ['w1', 'w2'], p2: ['w3'] } }
  assert.deepEqual(removeOpenTab(store, 'p1', 'w1').projects.p1, ['w2'])
  assert.deepEqual(removeOpenTab(store, 'p2', 'w3').projects, { p1: ['w1', 'w2'] })
  assert.equal(removeOpenTab(store, 'p1', 'missing'), store)
  assert.equal(removeOpenTab(store, '', 'w1'), store)
  assert.equal(removeOpenTab(store, 'p1', ''), store)
})

test('hasOpenTab 与 openTabIds 同口径', () => {
  const store = addOpenTab(emptyTabStore(), 'p1', 'w1')
  assert.equal(hasOpenTab(store, 'p1', 'w1'), true)
  assert.equal(hasOpenTab(store, 'p1', 'w2'), false)
})

test('workerTabState：运行中盖过完成未查看', () => {
  assert.equal(workerTabState({ running: true, completed: true }), 'ongoing')
  assert.equal(workerTabState({ running: false, completed: true }), 'done')
  assert.equal(workerTabState({ running: false, completed: false }), 'idle')
  assert.equal(workerTabState(undefined), 'idle')
})

test('sessionLabel：displayTitle → title → id', () => {
  assert.equal(sessionLabel({ displayTitle: '甲', title: '乙' }, 'id'), '甲')
  assert.equal(sessionLabel({ displayTitle: '', title: '乙' }, 'id'), '乙')
  assert.equal(sessionLabel({ title: '乙' }, 'id'), '乙')
  assert.equal(sessionLabel(undefined, 'id'), 'id')
})

test('resolveTabView：普通会话不显示', () => {
  assert.deepEqual(resolveTabView(input({ currentSessionId: 'ordinary' })), {
    visible: false,
    project: null,
    leaderId: null,
    tabs: [],
    activeSessionId: 'ordinary',
    isLeaderCurrent: false,
    isWorkerCurrent: false,
    workerIds: [],
  })
  assert.equal(resolveTabView(input({ currentSessionId: undefined })).visible, false)
  assert.equal(resolveTabView(input({ currentSessionId: '' })).visible, false)
  assert.equal(resolveTabView(input({ projects: undefined })).visible, false)
  assert.equal(resolveTabView(input({ groups: undefined })).visible, false)
})

test('resolveTabView：leader 在项目里，标签按登记表顺序只列已打开的 worker', () => {
  const store = { version: 1, projects: { p1: ['w2'] } }
  const view = resolveTabView(input({ store }))
  assert.equal(view.visible, true)
  assert.equal(view.isLeaderCurrent, true)
  assert.equal(view.isWorkerCurrent, false)
  assert.equal(view.leaderId, 'leader')
  assert.deepEqual(view.workerIds, ['w1', 'w2'])
  assert.deepEqual(view.tabs.map((tab) => tab.id), ['leader', 'w2'])
  assert.deepEqual(view.tabs[0], { id: 'leader', kind: 'leader', label: '网站改版', state: 'idle' })
  assert.deepEqual(view.tabs[1], { id: 'w2', kind: 'worker', label: '后端', state: 'idle' })
})

test('resolveTabView：打开 worker 后它成为当前标签，状态灯跟会话行', () => {
  const store = { version: 1, projects: { p1: ['w1'] } }
  const rows = {
    w1: row({ displayTitle: '前端', running: true }),
    w2: row({ title: '后端', completed: true }),
  }
  const view = resolveTabView(input({ store, rows, currentSessionId: 'w1' }))
  assert.equal(view.isWorkerCurrent, true)
  assert.equal(view.isLeaderCurrent, false)
  assert.equal(view.activeSessionId, 'w1')
  assert.equal(view.tabs[1].state, 'ongoing')
  const done = resolveTabView(input({ store: { version: 1, projects: { p1: ['w2'] } }, rows, currentSessionId: 'w2' }))
  assert.equal(done.tabs[1].state, 'done')
})

test('resolveTabView：当前 worker 还没记进标签库时先不出标签', () => {
  const view = resolveTabView(input({ currentSessionId: 'w1' }))
  assert.equal(view.visible, true)
  assert.equal(view.isWorkerCurrent, true)
  assert.deepEqual(view.tabs.map((tab) => tab.id), ['leader'])
})

test('resolveTabView：项目里没有 live worker 时不显示', () => {
  const view = resolveTabView(input({ rows: {}, currentSessionId: 'leader' }))
  assert.equal(view.visible, false)
})

test('resolveTabView：退役 leader 不出现在 worker 标签里', () => {
  const view = resolveTabView(input({
    projects: [project({ retiredLeaderSessionIds: ['w1'] })],
    store: { version: 1, projects: { p1: ['w1', 'w2'] } },
  }))
  assert.deepEqual(view.workerIds, ['w2'])
  assert.deepEqual(view.tabs.map((tab) => tab.id), ['leader', 'w2'])
  assert.equal(resolveTabView(input({
    projects: [project({ retiredLeaderSessionIds: ['w1'] })],
    currentSessionId: 'w1',
  })).visible, false)
})

test('resolveTabView：死掉或残缺的项目归属按不显示处理', () => {
  assert.equal(resolveTabView(input({
    projects: [project({ leaderAlive: false })],
  })).visible, false)
  assert.equal(resolveTabView(input({
    projects: [project({ leaderAlive: false })],
    currentSessionId: 'w1',
  })).visible, false)
  assert.equal(resolveTabView(input({ projects: [] })).visible, false)
  assert.equal(resolveTabView(input({
    groups: [{ projectId: 'missing', sessionIds: ['w1'] }],
    currentSessionId: 'w1',
  })).visible, false)
  assert.equal(resolveTabView(input({
    projects: [project({ leaderSessionId: '' })],
    currentSessionId: 'w1',
  })).visible, false)
  assert.equal(resolveTabView(input({
    groups: [{ projectId: 'p1', sessionIds: [] }],
    currentSessionId: 'w1',
  })).visible, false)
})

test('resolveTabView：登记表里的非法 id、leader 自己与重复项被清掉', () => {
  const view = resolveTabView(input({
    groups: [{ projectId: 'p1', sessionIds: ['w1', 'w1', 'leader', '', 'w2', 7] }],
    store: { version: 1, projects: { p1: ['w1', 'w2'] } },
  }))
  assert.deepEqual(view.workerIds, ['w1', 'w2'])
})

test('resolveTabView：项目没名字时标签退回项目 id', () => {
  const view = resolveTabView(input({ projects: [project({ name: '' })] }))
  assert.equal(view.tabs[0].label, 'p1')
})

test('resolveTabView：leader 项目没有登记表条目时也能显示（只有 leader 标签）', () => {
  const view = resolveTabView(input({
    groups: [],
    rows: { w1: row() },
  }))
  assert.equal(view.visible, false)
  const withWorker = resolveTabView(input({
    groups: [{ projectId: 'p1', sessionIds: ['w1'] }],
    rows: { w1: row() },
  }))
  assert.equal(withWorker.visible, true)
  assert.deepEqual(withWorker.tabs.map((tab) => tab.id), ['leader'])
})

test('tabAfterClose：只有关当前标签才导航回 leader', () => {
  const view = resolveTabView(input({ store: { version: 1, projects: { p1: ['w1'] } }, currentSessionId: 'w1' }))
  assert.equal(tabAfterClose(view, 'w1'), 'leader')
  assert.equal(tabAfterClose(view, 'w2'), null)
  assert.equal(tabAfterClose({ visible: false }, 'w1'), null)
  assert.equal(tabAfterClose(view, undefined), null)
})

test('tabIdForKey：左右循环、Home/End 到首尾', () => {
  const tabs = [{ id: 'leader' }, { id: 'w1' }, { id: 'w2' }]
  assert.equal(tabIdForKey(tabs, 'leader', 'ArrowRight'), 'w1')
  assert.equal(tabIdForKey(tabs, 'w2', 'ArrowRight'), 'leader')
  assert.equal(tabIdForKey(tabs, 'leader', 'ArrowLeft'), 'w2')
  assert.equal(tabIdForKey(tabs, 'w1', 'ArrowLeft'), 'leader')
  assert.equal(tabIdForKey(tabs, 'w1', 'Home'), 'leader')
  assert.equal(tabIdForKey(tabs, 'w1', 'End'), 'w2')
})

test('tabIdForKey：当前标签不在列表里时从第一个算，其它键不处理', () => {
  const tabs = [{ id: 'leader' }, { id: 'w1' }]
  assert.equal(tabIdForKey(tabs, 'missing', 'ArrowRight'), 'w1')
  assert.equal(tabIdForKey(tabs, 'missing', 'ArrowLeft'), 'w1')
  assert.equal(tabIdForKey(tabs, 'leader', 'Enter'), undefined)
  assert.equal(tabIdForKey([], 'leader', 'ArrowRight'), undefined)
  assert.equal(tabIdForKey(undefined, 'leader', 'ArrowRight'), undefined)
})
