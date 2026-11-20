import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  applyHideState,
  ensureLeaderChangesStyles,
  HIDE_ATTR,
  isLeaderSession,
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
