import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFrameScheduler, markRows, markSessionRow, markWorkspaceRow } from '../src/client/workspace-exclusion.js'

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
 * @returns {{ quieted: Set<string> }} 状态
 */
function markState({ quieted = [] } = {}) {
  return { quieted: new Set(quieted) }
}

test('命中压灰集的工作区行被标记为不激活', () => {
  const row = fakeRow('workspace:w1')
  const quiet = markWorkspaceRow(row, markState({ quieted: ['w1'] }))
  assert.equal(quiet, true)
  assert.equal(row.classes.has('dsh-leader-kit-quiet-workspace'), true)
})

test('不在压灰集里的工作区行保持激活态', () => {
  const row = fakeRow('workspace:w2')
  const quiet = markWorkspaceRow(row, markState({ quieted: ['w1'] }))
  assert.equal(quiet, false)
  assert.equal(row.classes.has('dsh-leader-kit-quiet-workspace'), false)
})

test('压灰集变化后重新标记能恢复激活态', () => {
  const row = fakeRow('workspace:w1')
  markWorkspaceRow(row, markState({ quieted: ['w1'] }))
  assert.equal(row.classes.has('dsh-leader-kit-quiet-workspace'), true)
  markWorkspaceRow(row, markState())
  assert.equal(row.classes.has('dsh-leader-kit-quiet-workspace'), false)
})

test('工作区行不被整行隐藏：项目目录也照常出现在树里', () => {
  const row = fakeRow('workspace:w1')
  assert.equal(markWorkspaceRow(row, markState()), false)
  assert.equal(row.classes.size, 0)
})

/**
 * 造一个假的查询根：按 `data-row-key` 前缀查后代，形状照 `markRows` 用到的
 * `querySelectorAll`（只认选择器里的 `^="…"` 前缀）。
 *
 * @param {object[]} rows - 若干行
 * @returns {object} 根
 */
function fakeRoot(rows) {
  return {
    querySelectorAll: (selector) => {
      const prefix = /\[data-row-key\^="([^"]*)"\]/.exec(selector)?.[1] ?? ''
      return rows.filter((row) => row.getAttribute('data-row-key')?.startsWith(prefix))
    },
  }
}

test('真实标记路径下工作区行只带压灰类，不会被整行隐藏', () => {
  // 与 createWorkspaceExclusion 的 update → markAll 同一条路径：真正落类的是 markRows。
  const quietRow = fakeRow('workspace:w1')
  const plainRow = fakeRow('workspace:w2')
  // 工作区 id 恰好也出现在会话排除集里：那也不该让它整行消失。
  const collidedRow = fakeRow('workspace:s9')
  const sessionRow = fakeRow('session:s9')
  const root = fakeRoot([quietRow, plainRow, collidedRow, sessionRow])

  markRows(root, { excluded: new Set(['s9']), quieted: new Set(['w1']) })

  // 会话行按排除集隐藏——排除机制本身仍在。
  assert.deepEqual([...sessionRow.classes], ['dsh-leader-kit-excluded-session'])
  // 工作区行只认压灰：没命中的一行类都没有，命中的只有压灰类。
  assert.deepEqual([...quietRow.classes], ['dsh-leader-kit-quiet-workspace'])
  assert.deepEqual([...plainRow.classes], [])
  assert.deepEqual([...collidedRow.classes], [])
})

test('会话行与工作区行各认各的前缀', () => {
  const sessionRow = fakeRow('session:s1')
  const workspaceRow = fakeRow('workspace:session:junk')
  assert.equal(markSessionRow(workspaceRow, new Set(['session:junk'])), false)
  assert.equal(markWorkspaceRow(sessionRow, markState({ quieted: ['s1'] })), false)
})

test('排除集变化后重新标记能改回可见', () => {
  const row = fakeRow('session:s1')
  markSessionRow(row, new Set(['s1']))
  assert.equal(row.classes.has('dsh-leader-kit-excluded-session'), true)
  markSessionRow(row, new Set())
  assert.equal(row.classes.has('dsh-leader-kit-excluded-session'), false)
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
