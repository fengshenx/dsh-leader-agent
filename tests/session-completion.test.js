import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSessionCompletionTracker } from '../src/client/session-completion.js'

/** 造一次快照：rows 是 [id, 行] 的列表。 */
const snap = (rows, phase = 'ready') => ({
  byId: Object.fromEntries(rows),
  phase,
})

/** 造一个会话行；mainView 大于 0 表示主视图正打开着它。 */
const row = (running, mainView = 0) => ({ running, retainedBy: { mainView } })

test('首见的空闲会话不标记：挂载前就完成的没有「刚完成」可言', () => {
  const tracker = createSessionCompletionTracker()
  assert.equal(tracker.update(snap([['w1', row(false)]])).size, 0)
})

test('执行中转为空闲且没人看着，标记完成未读', () => {
  const tracker = createSessionCompletionTracker()
  tracker.update(snap([['w1', row(true)]]))
  assert.equal(tracker.update(snap([['w1', row(false)]])).has('w1'), true)
})

test('完成时正被打开（主视图）不标记', () => {
  const tracker = createSessionCompletionTracker()
  tracker.update(snap([['w1', row(true, 1)]]))
  // 用户盯着这条会话跑完：转空闲时它就在主视图里，不算「没人看」。
  assert.equal(tracker.update(snap([['w1', row(false, 1)]])).size, 0)
})

test('标记后打开清除，切走不重新点亮', () => {
  const tracker = createSessionCompletionTracker()
  tracker.update(snap([['w1', row(true)]]))
  tracker.update(snap([['w1', row(false)]]))
  assert.equal(tracker.update(snap([['w1', row(false, 1)]])).has('w1'), false)
  // 切走只是 retainedBy 变化，运行态没有新的完成跳变，不该再亮。
  assert.equal(tracker.update(snap([['w1', row(false)]])).has('w1'), false)
})

test('标记后重新执行清除，再次完成再标记：循环派工各亮各的', () => {
  const tracker = createSessionCompletionTracker()
  tracker.update(snap([['w1', row(true)]]))
  tracker.update(snap([['w1', row(false)]]))
  tracker.update(snap([['w1', row(true)]]))
  assert.equal(tracker.update(snap([['w1', row(true)]])).has('w1'), false)
  assert.equal(tracker.update(snap([['w1', row(false)]])).has('w1'), true)
})

test('空闲→空闲没有跳变：已标记的不丢，没标记的不补', () => {
  const tracker = createSessionCompletionTracker()
  tracker.update(snap([['w1', row(true)]]))
  tracker.update(snap([['w1', row(false)]]))
  tracker.update(snap([['w1', row(false)]]))
  // w2 首见空闲不标记，重复快照也不标记；快照是完整列表，w1 一直在场。
  tracker.update(snap([['w1', row(false)], ['w2', row(false)]]))
  const unread = tracker.update(snap([['w1', row(false)], ['w2', row(false)]]))
  assert.equal(unread.has('w1'), true)
  assert.equal(unread.has('w2'), false)
})

test('列表 ready 后消失的会话清掉标记；phase 不是 ready 时保留', () => {
  const tracker = createSessionCompletionTracker()
  tracker.update(snap([['w1', row(true)]]))
  tracker.update(snap([['w1', row(false)]]))
  // pending 期 byId 可能暂时为空（归档、重启重建），不能误清。
  assert.equal(tracker.update(snap([], 'pending')).has('w1'), true)
  assert.equal(tracker.update(snap([], 'ready')).has('w1'), false)
  // 登记也清了：它若回来，按首见处理而不是凭旧的运行态判跳变。
  tracker.update(snap([['w1', row(false)]]))
  assert.equal(tracker.update(snap([['w1', row(false)]])).size, 0)
})

test('快照缺 phase 时不做消失清理：旧版宿主没有该字段', () => {
  const tracker = createSessionCompletionTracker()
  tracker.update(snap([['w1', row(true)]]))
  tracker.update(snap([['w1', row(false)]]))
  assert.equal(tracker.update({ byId: {} }).has('w1'), true)
})
