import assert from 'node:assert/strict'
import { test } from 'node:test'
import { railSignature } from '../src/client/board-rail-signature.js'

/**
 * 一份稳定的输入：两张卡，行高 60，stage 641×198。
 * @returns {object} 签名输入
 */
function baseInput() {
  return {
    railKey: 'cinema|dark|a:running:running|b:idle:idle',
    orthogonal: false,
    theme: 'dark',
    reduced: false,
    width: 641,
    height: 198,
    rows: [{ top: 104, height: 60 }, { top: 172, height: 60 }],
  }
}

test('相同输入给出相同签名：轮询重渲染不会因此重画', () => {
  assert.equal(railSignature(baseInput()), railSignature(baseInput()))
})

test('行高变化改签名：标题 1 行变 2 行、locale/字体加载都会走到', () => {
  const input = baseInput()
  const changed = { ...input, rows: [{ top: 104, height: 80 }, { top: 192, height: 60 }] }
  assert.notEqual(railSignature(input), railSignature(changed))
})

test('stage 高度变化改签名：即使行几何暂时没变也算几何变了', () => {
  const input = baseInput()
  assert.notEqual(
    railSignature(input),
    railSignature({ ...input, height: input.height + 20 }),
  )
})

test('宽度变化改签名：卡片换行与行高都可能跟着变', () => {
  const input = baseInput()
  assert.notEqual(
    railSignature(input),
    railSignature({ ...input, width: input.width - 128 }),
  )
})

test('行的纵向位置变化改签名：总高不变也要重画', () => {
  const input = baseInput()
  const shifted = { ...input, rows: [{ top: 104, height: 80 }, { top: 192, height: 40 }] }
  assert.notEqual(railSignature(input), railSignature(shifted))
})

test('行顺序与行数进入签名', () => {
  const input = baseInput()
  const reordered = { ...input, rows: [input.rows[1], input.rows[0]] }
  assert.notEqual(railSignature(input), railSignature(reordered))
  assert.notEqual(railSignature(input), railSignature({ ...input, rows: input.rows.slice(0, 1) }))
})

test('内容签名、走线、主题、减少动效各自改签名', () => {
  const input = baseInput()
  const variants = [
    { ...input, railKey: 'cinema|dark|a:idle:idle|b:idle:idle' },
    { ...input, orthogonal: true },
    { ...input, theme: 'light' },
    { ...input, reduced: true },
  ]
  const signatures = new Set([railSignature(input), ...variants.map(railSignature)])
  assert.equal(signatures.size, variants.length + 1)
})
