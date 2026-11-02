import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentToast, dismissToast, showToast, subscribeToasts } from '../src/client/toast.js'

/**
 * 清掉当前提示，让每个用例从空状态开始。
 * @returns {void}
 */
function reset() {
  const toast = currentToast()
  if (toast !== null) dismissToast(toast.id)
}

test('空字符串不弹提示——调用方用空串表达「没必要提示」', () => {
  reset()
  showToast('')
  assert.equal(currentToast(), null)
})

test('弹出的提示带停留时长与淡出时长', () => {
  reset()
  showToast('改名失败')
  const toast = currentToast()
  assert.equal(toast.text, '改名失败')
  assert.ok(toast.holdMs > 0)
  assert.ok(toast.fadeMs > 0)
  reset()
})

test('后一条替换前一条，旧提示的计时器撤不掉新提示', () => {
  reset()
  showToast('读取项目失败')
  const first = currentToast()
  showToast('读取项目会话失败')
  const second = currentToast()
  assert.notEqual(second.id, first.id)
  assert.equal(second.text, '读取项目会话失败')

  // 淡出计时器按 id 撤：旧那条的计时器晚到时不能把刚弹出来的这条撤掉。
  dismissToast(first.id)
  assert.equal(currentToast()?.text, '读取项目会话失败')

  dismissToast(second.id)
  assert.equal(currentToast(), null)
})

test('订阅者在弹出与消失时都收到通知', () => {
  reset()
  let calls = 0
  const unsubscribe = subscribeToasts(() => { calls += 1 })
  showToast('工作区未移除')
  dismissToast(currentToast().id)
  unsubscribe()
  showToast('退订之后')
  assert.equal(calls, 2)
  reset()
})
