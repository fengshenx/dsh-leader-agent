import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prefersReducedMotion, watchReducedMotion } from '../src/client/motion-preference.js'

/**
 * 造一个假的 matchMedia 查询对象。
 *
 * @param {object} options - 选项
 * @param {boolean} [options.matches] - 初始匹配值
 * @param {'event-target' | 'legacy'} [options.style] - 监听接口形态
 * @returns {object} 查询对象与触发变化的函数
 */
function createQuery({ matches = false, style = 'event-target' } = {}) {
  const listeners = new Set()
  const query = {
    matches,
    addEventListener: style === 'event-target' ? (type, listener) => listeners.add(type === 'change' ? listener : () => {}) : undefined,
    removeEventListener: style === 'event-target' ? (type, listener) => listeners.delete(listener) : undefined,
    addListener: style === 'legacy' ? (listener) => listeners.add(listener) : undefined,
    removeListener: style === 'legacy' ? (listener) => listeners.delete(listener) : undefined,
    /** 模拟系统偏好切换。
     * @param {boolean} next - 新匹配值
     * @returns {void}
     */
    change(next) {
      query.matches = next
      for (const listener of Array.from(listeners)) listener()
    },
    listenerCount: () => listeners.size,
  }
  return query
}

test('读偏好：matchMedia 缺失或抛错时按不减少处理', () => {
  assert.equal(prefersReducedMotion({}), false)
  assert.equal(prefersReducedMotion({ matchMedia: () => { throw new Error('denied') } }), false)
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: true }) }), true)
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false)
})

test('订阅后偏好变化会回调，退订后不再回调', () => {
  const query = createQuery({ matches: false })
  const seen = []
  const off = watchReducedMotion({ matchMedia: () => query }, (reduced) => seen.push(reduced))
  query.change(true)
  query.change(false)
  off()
  query.change(true)
  assert.deepEqual(seen, [true, false])
  assert.equal(query.listenerCount(), 0)
})

test('老 WebKit 只有 addListener 时同样能订阅与退订', () => {
  const query = createQuery({ matches: true, style: 'legacy' })
  const seen = []
  const off = watchReducedMotion({ matchMedia: () => query }, (reduced) => seen.push(reduced))
  query.change(false)
  off()
  query.change(true)
  assert.deepEqual(seen, [false])
  assert.equal(query.listenerCount(), 0)
})

test('没有可用的 matchMedia 或两个监听接口都没有时，订阅退化为空操作', () => {
  assert.doesNotThrow(() => watchReducedMotion({}, () => {})())
  assert.doesNotThrow(() => watchReducedMotion({ matchMedia: () => { throw new Error('denied') } }, () => {})())
  const inert = createQuery({ style: 'event-target' })
  inert.addEventListener = undefined
  inert.addListener = undefined
  assert.doesNotThrow(() => watchReducedMotion({ matchMedia: () => inert }, () => {})())
})
