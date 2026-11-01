import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFrameScheduler, markGroupRows, markSessionRow, markWorkspaceRow } from '../src/client/workspace-exclusion.js'

/**
 * 造一个假的会话行：只需要 `getAttribute` 与 `classList.toggle`。
 * @param {string} rowKey - 行的 data-row-key
 * @returns {object} 假行
 */
function fakeRow(rowKey) {
  const classes = new Set()
  return {
    classes,
    getAttribute: (name) => (name === 'data-row-key' ? rowKey : null),
    classList: {
      toggle: (name, force) => {
        if (force === true) classes.add(name)
        else classes.delete(name)
      },
    },
  }
}

test('命中排除集的会话行被标记为隐藏', () => {
  const row = fakeRow('session:s1')
  const hidden = markSessionRow(row, new Set(['s1']))
  assert.equal(hidden, true)
  assert.equal(row.classes.has('dsh-leader-kit-excluded-session'), true)
})

test('不在排除集里的会话行保持可见', () => {
  const row = fakeRow('session:s2')
  const hidden = markSessionRow(row, new Set(['s1']))
  assert.equal(hidden, false)
  assert.equal(row.classes.has('dsh-leader-kit-excluded-session'), false)
})

test('不是会话行的标识不参与排除', () => {
  const row = fakeRow('workspace:group-1')
  const hidden = markSessionRow(row, new Set(['group-1']))
  assert.equal(hidden, false)
  assert.equal(row.classes.size, 0)
})

/**
 * 造一份工作区标记状态。
 *
 * @param {object} [state] - 覆盖项
 * @param {string[]} [state.quieted] - 压灰集
 * @param {string[]} [state.hidden] - 藏行集
 * @returns {{ quieted: Set<string>, hidden: Set<string> }} 状态
 */
function markState({ quieted = [], hidden = [] } = {}) {
  return { quieted: new Set(quieted), hidden: new Set(hidden) }
}

test('命中压灰集的工作区行被标记为不激活', () => {
  const row = fakeRow('workspace:w1')
  const mark = markWorkspaceRow(row, markState({ quieted: ['w1'] }))
  assert.equal(mark.quiet, true)
  assert.equal(row.classes.has('dsh-leader-kit-quiet-workspace'), true)
})

test('不在压灰集里的工作区行保持激活态', () => {
  const row = fakeRow('workspace:w2')
  const mark = markWorkspaceRow(row, markState({ quieted: ['w1'] }))
  assert.equal(mark.quiet, false)
  assert.equal(row.classes.has('dsh-leader-kit-quiet-workspace'), false)
})

test('压灰集变化后重新标记能恢复激活态', () => {
  const row = fakeRow('workspace:w1')
  markWorkspaceRow(row, markState({ quieted: ['w1'] }))
  assert.equal(row.classes.has('dsh-leader-kit-quiet-workspace'), true)
  markWorkspaceRow(row, markState())
  assert.equal(row.classes.has('dsh-leader-kit-quiet-workspace'), false)
})

test('命中藏行集的工作区行被整行隐藏', () => {
  const row = fakeRow('workspace:w1')
  const mark = markWorkspaceRow(row, markState({ hidden: ['w1'] }))
  assert.equal(mark.hidden, true)
  assert.equal(row.classes.has('dsh-leader-kit-hidden-workspace'), true)
})

test('藏行集变化后重新标记能恢复显示', () => {
  const row = fakeRow('workspace:w1')
  markWorkspaceRow(row, markState({ hidden: ['w1'] }))
  assert.equal(row.classes.has('dsh-leader-kit-hidden-workspace'), true)
  markWorkspaceRow(row, markState())
  assert.equal(row.classes.has('dsh-leader-kit-hidden-workspace'), false)
})

test('会话行与工作区行各认各的前缀', () => {
  const sessionRow = fakeRow('session:s1')
  const workspaceRow = fakeRow('workspace:session:junk')
  assert.equal(markSessionRow(workspaceRow, new Set(['session:junk'])), false)
  assert.equal(markWorkspaceRow(sessionRow, markState({ quieted: ['s1'], hidden: ['s1'] })).quiet, false)
  assert.equal(markWorkspaceRow(sessionRow, markState({ quieted: ['s1'], hidden: ['s1'] })).hidden, false)
})

test('排除集变化后重新标记能改回可见', () => {
  const row = fakeRow('session:s1')
  markSessionRow(row, new Set(['s1']))
  assert.equal(row.classes.has('dsh-leader-kit-excluded-session'), true)
  markSessionRow(row, new Set())
  assert.equal(row.classes.has('dsh-leader-kit-excluded-session'), false)
})

/**
 * 造一个最小的元素桩：只支持本模块用到的 `parentElement`、`getAttribute`、
 * `classList` 与按 `data-row-key` 前缀查后代（选择器里的 `^="…"` 逐个取前缀）。
 *
 * 形状照宿主：分组容器的父元素带 `role`（顶层 `tree` / 嵌套 `group`），行元素外面
 * 包一层 HoverCard 的 `span`，所以行不是容器的直接子元素。
 *
 * @param {Record<string, string>} [attributes] - 属性
 * @param {object[]} [children] - 子元素
 * @returns {object} 元素桩
 */
function fakeElement(attributes = {}, children = []) {
  const element = { children, parentElement: null, classes: new Set() }
  for (const child of children) child.parentElement = element
  element.getAttribute = (name) => attributes[name] ?? null
  element.classList = {
    toggle: (name, force) => {
      if (force === true) element.classes.add(name)
      else element.classes.delete(name)
    },
  }
  element.querySelectorAll = (selector) => {
    const prefixes = [...selector.matchAll(/\^="([^"]*)"/g)].map((match) => match[1])
    const found = []
    const walk = (node) => {
      for (const child of node.children) {
        const key = child.getAttribute('data-row-key')
        if (typeof key === 'string' && prefixes.some((prefix) => key.startsWith(prefix))) found.push(child)
        walk(child)
      }
    }
    walk(element)
    return found
  }
  return element
}

/**
 * 造一行官方形状的行：HoverCard 的 span 包着带 `data-row-key` 的行元素。
 * @param {string} rowKey - 行的 data-row-key
 * @returns {{ row: object, wrapper: object }} 行与包着它的 span
 */
function wrappedRow(rowKey) {
  const row = fakeElement({ 'data-row-key': rowKey })
  return { row, wrapper: fakeElement({}, [row]) }
}

test('藏掉工作区 header 时，组内会话行与展开按钮一起藏掉', () => {
  const header = wrappedRow('workspace:w1')
  const first = wrappedRow('session:s1')
  const second = wrappedRow('session:s2')
  const overflow = fakeElement({ 'data-row-key': 'overflow:w1' })
  const section = fakeElement({}, [header.wrapper, first.wrapper, second.wrapper, overflow])
  fakeElement({ role: 'tree' }, [section])

  markGroupRows(header.row, true)

  for (const row of [first.row, second.row, overflow]) {
    assert.equal(row.classes.has('dsh-leader-kit-hidden-workspace-group'), true)
  }
  assert.equal(header.row.classes.has('dsh-leader-kit-hidden-workspace-group'), false)
})

test('工作区重新显示时组内行不残留隐藏标记', () => {
  const header = wrappedRow('workspace:w1')
  const session = wrappedRow('session:s1')
  const section = fakeElement({}, [header.wrapper, session.wrapper])
  fakeElement({ role: 'tree' }, [section])

  markGroupRows(header.row, true)
  assert.equal(session.row.classes.has('dsh-leader-kit-hidden-workspace-group'), true)
  markGroupRows(header.row, false)
  assert.equal(session.row.classes.has('dsh-leader-kit-hidden-workspace-group'), false)
})

test('嵌套分组的会话行不跟着外层分组一起藏', () => {
  const outerHeader = wrappedRow('workspace:outer')
  const outerSession = wrappedRow('session:outer-1')
  const innerHeader = wrappedRow('workspace:inner')
  const innerSession = wrappedRow('session:inner-1')
  const innerSection = fakeElement({}, [innerHeader.wrapper, innerSession.wrapper])
  const outerSection = fakeElement({}, [
    outerHeader.wrapper,
    fakeElement({ role: 'group' }, [innerSection]),
    outerSession.wrapper,
  ])
  fakeElement({ role: 'tree' }, [outerSection])

  markGroupRows(outerHeader.row, true)

  assert.equal(outerSession.row.classes.has('dsh-leader-kit-hidden-workspace-group'), true)
  assert.equal(innerSession.row.classes.has('dsh-leader-kit-hidden-workspace-group'), false)
  assert.equal(innerHeader.row.classes.has('dsh-leader-kit-hidden-workspace-group'), false)
})

test('找不到分组容器时不动任何行', () => {
  const header = wrappedRow('workspace:w1')
  assert.doesNotThrow(() => { markGroupRows(header.row, true) })
  assert.equal(header.row.classes.size, 0)
})

/**
 * 造一个假的帧调度器：记录排了几次，并交出待执行的回调。
 * @returns {{ scheduler: object, scheduled: () => number, run: () => void, cancel: () => void }} 调度器与操作
 */
function fakeFrameScheduler() {
  let count = 0
  let callback
  let cancelled = 0
  const scheduler = createFrameScheduler({
    schedule: (task) => {
      count += 1
      callback = task
      return count
    },
    cancel: () => { cancelled += 1 },
  })
  return {
    scheduler,
    scheduled: () => count,
    cancelled: () => cancelled,
    run: () => callback?.(),
  }
}

test('同一帧内重复排任务只排一次', () => {
  const frame = fakeFrameScheduler()
  frame.scheduler.run(() => {})
  frame.scheduler.run(() => {})
  frame.scheduler.run(() => {})
  assert.equal(frame.scheduled(), 1)
})

test('任务执行后可以再排下一次', () => {
  const frame = fakeFrameScheduler()
  let count = 0
  frame.scheduler.run(() => { count += 1 })
  frame.run()
  assert.equal(count, 1)
  frame.scheduler.run(() => { count += 1 })
  frame.run()
  assert.equal(count, 2)
  assert.equal(frame.scheduled(), 2)
})

test('取消后回调即使被调用也不执行任务', () => {
  const frame = fakeFrameScheduler()
  let count = 0
  frame.scheduler.run(() => { count += 1 })
  frame.scheduler.cancel()
  assert.equal(frame.cancelled(), 1)
  frame.run()
  assert.equal(count, 0)
})
