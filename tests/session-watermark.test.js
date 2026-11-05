import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SESSION_WATERMARK_AUTO_MAX,
  SESSION_WATERMARK_BASE,
  foldSessions,
  nextWatermark,
  requiredWatermark,
  watermarkRows,
} from '../src/client/session-watermark.js'

/**
 * 造一批会话行。
 * @param {number} count - 条数
 * @param {number[]} [runningAt] - 运行中的位置（从 1 数）
 * @param {number[]} [completedAt] - 完成未读的位置（从 1 数）
 * @returns {object[]} 会话行
 */
function makeRows(count, runningAt = [], completedAt = []) {
  return Array.from({ length: count }, (_, index) => ({
    id: `s-${index + 1}`,
    running: runningAt.includes(index + 1),
    completed: completedAt.includes(index + 1),
  }))
}

test('watermarkRows 按水位切出前缀，并报出藏了几条', () => {
  const rows = makeRows(8)
  assert.deepEqual(watermarkRows(rows, 5).rows.map((row) => row.id), ['s-1', 's-2', 's-3', 's-4', 's-5'])
  assert.equal(watermarkRows(rows, 5).hiddenCount, 3)
  assert.equal(watermarkRows(rows, Number.POSITIVE_INFINITY).hiddenCount, 0)
  assert.equal(watermarkRows(rows, 0).hiddenCount, 8)
})

test('requiredWatermark 抬到最后一个运行中会话说在的位置', () => {
  assert.equal(requiredWatermark(makeRows(10)), 0)
  assert.equal(requiredWatermark(makeRows(10, [3])), 3)
  assert.equal(requiredWatermark(makeRows(10, [2, 9])), 9)
})

test('requiredWatermark 也抬到最后一个完成未读会话的位置', () => {
  assert.equal(requiredWatermark(makeRows(10, [], [6])), 6)
  assert.equal(requiredWatermark(makeRows(10, [8], [3])), 8)
  assert.equal(requiredWatermark(makeRows(10, [2], [9])), 9)
})

test('requiredWatermark 也认当前会话：点开后水位不回落', () => {
  assert.equal(requiredWatermark(makeRows(8), 's-6'), 6)
  assert.equal(requiredWatermark(makeRows(8), 's-1'), 1)
  assert.equal(requiredWatermark(makeRows(8), 'missing'), 0)
})

test('requiredWatermark 只在前 50 条内生效', () => {
  assert.equal(requiredWatermark(makeRows(80, [SESSION_WATERMARK_AUTO_MAX])), SESSION_WATERMARK_AUTO_MAX)
  assert.equal(requiredWatermark(makeRows(80, [SESSION_WATERMARK_AUTO_MAX + 1])), 0)
  assert.equal(requiredWatermark(makeRows(80, [], [SESSION_WATERMARK_AUTO_MAX])), SESSION_WATERMARK_AUTO_MAX)
  assert.equal(requiredWatermark(makeRows(80, [], [SESSION_WATERMARK_AUTO_MAX + 1])), 0)
})

test('nextWatermark 剩余不足一页时一次放完', () => {
  assert.equal(nextWatermark(5, 5), Number.POSITIVE_INFINITY)
  assert.equal(nextWatermark(1, 5), Number.POSITIVE_INFINITY)
  assert.equal(nextWatermark(6, 5), 10)
  assert.equal(nextWatermark(20, 10), 15)
})

test('foldSessions 默认露出基准条数，运行中的会话不被折起来', () => {
  const plain = foldSessions(makeRows(8), 0)
  assert.equal(plain.rows.length, SESSION_WATERMARK_BASE)
  assert.equal(plain.hiddenCount, 3)
  assert.equal(plain.expanded, false)
  assert.equal(plain.expandLabel, '展开其余 3 个会话')

  const withRunning = foldSessions(makeRows(8, [7]), 0)
  assert.equal(withRunning.rows.length, 7)
  assert.equal(withRunning.hiddenCount, 1)

  // 绿点是通知：第 6 条完成未读被折起来就看不见了，水位要把它露出来。
  const withCompleted = foldSessions(makeRows(8, [], [6]), 0)
  assert.equal(withCompleted.rows.length, 6)
  assert.equal(withCompleted.hiddenCount, 2)

  // 点开第 6 条后 completed 清除；它成了当前会话，水位不能跟着回落，
  // 否则这一行会在用户眼前当场消失。
  const opened = makeRows(8)
  const stillVisible = foldSessions(opened, 0, 's-6')
  assert.equal(stillVisible.rows.length, 6)
  assert.equal(stillVisible.rows[5].id, 's-6')
})

test('foldSessions 展开后全部可见并给出收起态', () => {
  const expanded = foldSessions(makeRows(8), Number.POSITIVE_INFINITY)
  assert.equal(expanded.rows.length, 8)
  assert.equal(expanded.expanded, true)
})

test('foldSessions 在会话本来就装得下时不出现按钮', () => {
  const short = foldSessions(makeRows(3), 0)
  assert.equal(short.hiddenCount, 0)
  assert.equal(short.expanded, false)
})
