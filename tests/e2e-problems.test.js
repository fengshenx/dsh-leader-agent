import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { watchProblems } from './e2e/harness.mjs'

/** 造一个只发 console / pageerror 事件的假页面。 */
function fakePage() {
  return new EventEmitter()
}

/**
 * 宿主在「视图 ready 之前被 release」时打出的那条 error。
 *
 * 原文来自 `ui-sidebar-right/src/client/session-view.ts` 的 `console.error('Sidebar Session opening failed:', error)`。
 */
const SESSION_RELEASED = 'Sidebar Session opening failed: Error: Session reference "session-1" is released\n    at ClientSessionReference.binding'

test('未捕获异常与普通 console.error 仍然是失败', () => {
  const page = fakePage()
  const problems = watchProblems(page)
  page.emit('pageerror', new Error('boom'))
  page.emit('console', { type: () => 'error', text: () => '真实故障：订阅断了' })
  assert.deepEqual(problems, [
    'pageerror: boom',
    'console.error: 真实故障：订阅断了',
  ])
})

test('宿主的 session 引用释放是预期取消，按文案放行', () => {
  const page = fakePage()
  const problems = watchProblems(page)
  page.emit('console', { type: () => 'error', text: () => SESSION_RELEASED })
  assert.deepEqual(problems, [])
})

test('放行只认这一条：同一前缀但不同原因的 error 仍然报', () => {
  const page = fakePage()
  const problems = watchProblems(page)
  page.emit('console', { type: () => 'error', text: () => 'Sidebar Session opening failed: Error: network down' })
  assert.deepEqual(problems, ['console.error: Sidebar Session opening failed: Error: network down'])
})

test('归集数组可复用：多个页面写同一个 problems', () => {
  const problems = []
  const first = fakePage()
  const second = fakePage()
  watchProblems(first, problems)
  watchProblems(second, problems)
  first.emit('pageerror', new Error('a'))
  second.emit('pageerror', new Error('b'))
  assert.deepEqual(problems, ['pageerror: a', 'pageerror: b'])
})
