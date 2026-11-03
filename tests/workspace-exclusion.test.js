import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  adjustExpandButton,
  createFrameScheduler,
  excludedSessionCountsByWorkspace,
  markRows,
  markSessionRow,
  markWorkspaceRow,
} from '../src/client/workspace-exclusion.js'

/**
 * 造一个假的会话行：只需要 `getAttribute`、`classList`、`children` 与 `dataset`。
 * @param {string} rowKey - 行的 data-row-key
 * @returns {object} 假行
 */
function fakeRow(rowKey) {
  const classes = new Set()
  return {
    rowKey,
    classes,
    children: [],
    dataset: {},
    parentElement: undefined,
    textContent: '',
    getAttribute: (name) => (name === 'data-row-key' ? rowKey : null),
    classList: {
      toggle: (name, force) => {
        if (force === true) classes.add(name)
        else if (force === false) classes.delete(name)
        else if (classes.has(name)) classes.delete(name)
        else classes.add(name)
      },
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      remove: (...names) => { for (const name of names) classes.delete(name) },
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

/**
 * 把一行包进 `HoverCard` 那层 `span` 里：宿主的分组容器直接子元素是包装层，
 * 会话行与工作区行都在包装层内部。
 *
 * @param {object} section - 分组容器
 * @param {object} children - 分组容器的子元素列表（会被追加）
 * @param {object} row - 要包装的行
 * @returns {object} 包装层
 */
function wrapRow(section, children, row) {
  const wrapper = fakeRow(undefined)
  wrapper.children = [row]
  row.parentElement = wrapper
  wrapper.parentElement = section
  children.push(wrapper)
  return wrapper
}

/**
 * 造一个假的工作区分组：工作区行 + 已渲染的会话行 + 展开按钮，结构与宿主
 * `WorkspaceBrowser` 的分组一致（行都包在 HoverCard 的 span 里）。
 *
 * @param {object} options - 选项
 * @param {string} options.key - 工作区 id（也是宿主的 group.key）
 * @param {string[]} options.rendered - 已渲染的会话 id
 * @param {string} [options.buttonText] - 展开按钮的初始文案
 * @returns {{ root: object, section: object, sessions: Map<string, object>, button: object }} 假树
 */
function fakeGroup({ key, rendered, buttonText = '展开其余 3 个会话' }) {
  const section = fakeRow(`section:${key}`)
  const children = []
  wrapRow(section, children, fakeRow(`workspace:${key}`))
  const sessions = new Map()
  for (const id of rendered) {
    const row = fakeRow(`session:${id}`)
    wrapRow(section, children, row)
    sessions.set(id, row)
  }
  const button = fakeRow(`overflow:${key}`)
  button.textContent = buttonText
  button.parentElement = section
  children.push(button)
  section.children = children
  const rows = [...sessions.values()]
  return { root: fakeRoot([...rows, button, ...children]), section, sessions, button }
}

test('展开按钮的剩余数扣掉藏在未渲染部分里的项目会话', () => {
  // 组里 3 条项目会话，已渲染的两条被藏掉，第三条还没渲染出来。
  const group = fakeGroup({ key: 'w1', rendered: ['a', 'w1s', 'b', 'w2s', 'c'] })

  markRows(group.root, {
    excluded: new Set(['w1s', 'w2s', 'w3s']),
    quieted: new Set(),
    excludedByGroup: new Map([['w1', 3]]),
  })

  assert.equal(group.sessions.get('w1s').classes.has('dsh-leader-kit-excluded-session'), true)
  // 宿主说还剩 3 条，其中 1 条是没渲染出来的项目会话 → 真实可看 2 条。
  assert.equal(group.button.textContent, '展开其余 2 个会话')
  assert.equal(group.button.classes.has('dsh-leader-kit-excluded-expand'), false)
})

test('剩余全是项目会话时把展开按钮收起', () => {
  const group = fakeGroup({ key: 'w1', rendered: ['a', 'w1s'], buttonText: '展开其余 1 个会话' })

  markRows(group.root, {
    excluded: new Set(['w1s', 'w2s']),
    quieted: new Set(),
    excludedByGroup: new Map([['w1', 2]]),
  })

  assert.equal(group.button.classes.has('dsh-leader-kit-excluded-expand'), true)
})

test('反复标记不会把改过的数字再减一次', () => {
  const group = fakeGroup({ key: 'w1', rendered: ['a', 'w1s'] })
  const state = {
    excluded: new Set(['w1s', 'w2s']),
    quieted: new Set(),
    excludedByGroup: new Map([['w1', 2]]),
  }

  markRows(group.root, state)
  assert.equal(group.button.textContent, '展开其余 2 个会话')
  markRows(group.root, state)
  assert.equal(group.button.textContent, '展开其余 2 个会话')
})

test('宿主重写文案后按宿主的新数字重算', () => {
  const group = fakeGroup({ key: 'w1', rendered: ['a', 'w1s'] })
  const state = {
    excluded: new Set(['w1s', 'w2s']),
    quieted: new Set(),
    excludedByGroup: new Map([['w1', 2]]),
  }
  markRows(group.root, state)
  assert.equal(group.button.textContent, '展开其余 2 个会话')

  // React 换掉了文本节点：新值是宿主自己的口径（点击展开后的剩余 8 条）。
  group.button.textContent = '展开其余 8 个会话'
  markRows(group.root, state)

  assert.equal(group.button.textContent, '展开其余 7 个会话')
})

test('没有分组统计时不碰展开按钮', () => {
  const group = fakeGroup({ key: 'w1', rendered: ['w1s'] })
  markRows(group.root, { excluded: new Set(['w1s']), quieted: new Set() })
  assert.equal(group.button.textContent, '展开其余 3 个会话')
  assert.equal(group.button.classes.size, 0)
})

test('文案里没有数字（收起）时原样不动', () => {
  const group = fakeGroup({ key: 'w1', rendered: ['a'], buttonText: '收起' })
  markRows(group.root, {
    excluded: new Set(['w1s']),
    quieted: new Set(),
    excludedByGroup: new Map([['w1', 1]]),
  })
  assert.equal(group.button.textContent, '收起')
})

test('完全匹配的剩余数不重写文本', () => {
  const group = fakeGroup({ key: 'w1', rendered: ['a'], buttonText: '展开其余 5 个会话' })
  const written = adjustExpandButton(group.button, 5)
  assert.equal(written, 5)
  assert.equal(group.button.textContent, '展开其余 5 个会话')
  assert.equal(group.button.dataset.expandWritten, undefined)
})

test('按工作区分组统计排除集：归档的会话不计入', () => {
  const counts = excludedSessionCountsByWorkspace({
    workspaceItems: [
      { workspaceId: 'w1', sessionIds: ['s1', 's2', 's3'] },
      { workspaceId: 'w2', sessionIds: ['s4'] },
      { workspaceId: 'w3', sessionIds: ['s5'] },
      { workspaceId: 'w4' },
    ],
    excluded: new Set(['s1', 's2', 's3', 's4']),
    archivedSessionIds: new Set(['s2']),
  })

  // w1：s1、s3 计入，s2 已归档（宿主自己就不渲染）。
  assert.equal(counts.get('w1'), 2)
  assert.equal(counts.get('w2'), 1)
  // 没有排除会话的组不进映射 —— 渲染层据此不改它的按钮。
  assert.equal(counts.has('w3'), false)
  assert.equal(counts.has('w4'), false)
})

test('子工作区的隐藏会话不算进父组的剩余数', () => {
  const parentSection = fakeRow('section:parent')
  const children = []
  wrapRow(parentSection, children, fakeRow('workspace:parent'))
  const parentButton = fakeRow('overflow:parent')
  parentButton.textContent = '展开其余 3 个会话'
  parentButton.parentElement = parentSection

  const childSection = fakeRow('section:child')
  const childChildren = []
  wrapRow(childSection, childChildren, fakeRow('workspace:child'))
  const childRow = fakeRow('session:child-hidden')
  wrapRow(childSection, childChildren, childRow)
  const childButton = fakeRow('overflow:child')
  childButton.textContent = '展开其余 2 个会话'
  childButton.parentElement = childSection
  childChildren.push(childButton)
  childSection.children = childChildren
  childSection.parentElement = parentSection

  children.push(childSection, parentButton)
  parentSection.children = children

  const root = fakeRoot([childRow, parentButton, childButton, ...children, ...childChildren])
  markRows(root, {
    excluded: new Set(['child-hidden', 'parent-hidden']),
    quieted: new Set(),
    excludedByGroup: new Map([['parent', 1], ['child', 1]]),
  })

  // 父组自己一条都没渲染出来：3 - 1 = 2。子组那条已隐藏的不能算到父组头上。
  assert.equal(parentButton.textContent, '展开其余 2 个会话')
  // 子组自身那一条已渲染且隐藏：2 - (1 - 1) = 2。
  assert.equal(childButton.textContent, '展开其余 2 个会话')
  assert.equal(childRow.classes.has('dsh-leader-kit-excluded-session'), true)
})
