import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { findColumn, findMainPanel, findMainSlot, mainBodyOf } from '../src/client/main-panel.js'

/**
 * 造一个最小元素桩。
 * @param {object} [options] - 结构
 * @param {object | null} [options.parentElement] - 父节点
 * @param {boolean} [options.slot] - 是否带 `data-slot` 标记
 * @param {object | null} [options.firstElementChild] - 第一个子节点
 * @returns {object} 元素桩
 */
function makeElement({ parentElement = null, slot = false, firstElementChild = null } = {}) {
  return {
    parentElement,
    firstElementChild,
    hasAttribute(name) {
      return name === 'data-slot' && slot
    },
  }
}

afterEach(() => {
  delete globalThis.document
  delete globalThis.window
})

test('没有 document 时找不到主槽位', () => {
  assert.equal(findMainSlot(), null)
})

test('主槽位优先按真实 mainPanel 类名找', () => {
  const target = makeElement()
  const seen = []
  globalThis.document = {
    querySelector(selector) {
      seen.push(selector)
      return selector === '#root [class*="mainPanel"]' ? target : null
    },
  }
  assert.equal(findMainSlot(), target)
  assert.deepEqual(seen, ['#root [class*="mainPanel"]'])
})

test('隐藏定位不把 data-slot main 当主面板', () => {
  globalThis.document = {
    querySelector(selector) {
      return selector === '#root [data-slot="main"]' ? makeElement() : null
    },
  }
  assert.equal(findMainPanel(), null)
  assert.notEqual(findMainSlot(), null)
})

test('没有 mainPanel 时 data-slot 作为兼容兜底', () => {
  const target = makeElement()
  const seen = []
  globalThis.document = {
    querySelector(selector) {
      seen.push(selector)
      if (selector === '#root [data-slot="main"]') return target
      return null
    },
  }
  assert.equal(findMainSlot(), target)
  assert.deepEqual(seen, [
    '#root [class*="mainPanel"]',
    '[class*="mainPanel"]',
    '#root [data-slot="main"]',
  ])
})


test('容器是主槽位外侧最后一个带槽位标记的节点', () => {
  const outer = makeElement({ slot: true })
  const inner = makeElement({ slot: true, parentElement: outer })
  const slot = makeElement({ parentElement: inner })
  assert.equal(findColumn(slot), outer)
})

test('主槽位没有带标记的父节点时容器就是它自己', () => {
  const slot = makeElement()
  assert.equal(findColumn(slot), slot)
})

test('会话体跳过 display:contents 包装', () => {
  const surface = makeElement()
  const wrapper = makeElement({ firstElementChild: surface })
  const slot = makeElement({ firstElementChild: wrapper })
  globalThis.window = {
    getComputedStyle(element) {
      return { display: element === wrapper ? 'contents' : 'block' }
    },
  }
  assert.equal(mainBodyOf(slot), surface)
})

test('会话体没有包装时就是槽位的第一个子节点', () => {
  const surface = makeElement()
  const slot = makeElement({ firstElementChild: surface })
  globalThis.window = { getComputedStyle: () => ({ display: 'block' }) }
  assert.equal(mainBodyOf(slot), surface)
})
