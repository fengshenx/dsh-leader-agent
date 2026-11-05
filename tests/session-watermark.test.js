import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SESSION_WATERMARK_AUTO_MAX,
  SESSION_WATERMARK_BASE,
  foldRows,
  foldSessions,
  nextRowWatermark,
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

test('会话列表一页 5 条', () => {
  assert.equal(SESSION_WATERMARK_BASE, 5)
})

test('foldRows 按页大小切行，基线高于一页时全露也不算展开完', () => {
  const rows = makeRows(8)

  const folded = foldRows(rows, 0, { pageSize: 2, noun: '会话' })
  assert.equal(folded.rows.length, 2)
  assert.equal(folded.hiddenCount, 6)
  assert.equal(folded.expanded, false)
  assert.equal(folded.expandLabel, '展开其余 6 个会话')

  // 注意力会话把基线抬到 5：全部露出也还是折叠态，按钮不该凭空变成「收起」。
  const raised = foldRows(rows, 0, { pageSize: 2, baseline: 5, noun: '会话' })
  assert.equal(raised.rows.length, 5)
  assert.equal(raised.hiddenCount, 3)
  assert.equal(raised.expanded, false)
  assert.equal(foldRows(rows, 8, { pageSize: 2, baseline: 5, noun: '会话' }).expanded, true)

  // 基线正好等于全部行数：全露但用户没展开过，不能算「展开完」。
  assert.equal(foldRows(makeRows(4), 0, { pageSize: 2, baseline: 4, noun: '会话' }).expanded, false)
})

test('foldSessions 的页大小可参数化', () => {
  const folded = foldSessions(makeRows(8), 0, undefined, 3)
  assert.equal(folded.rows.length, 3)
  assert.equal(folded.hiddenCount, 5)
  assert.equal(folded.expandLabel, '展开其余 5 个会话')
  // 剩余 5 条 > 一页 3 条：再加一页；剩余 3 条正好一页：一次放完。
  assert.equal(nextRowWatermark(5, 3, 3), 6)
  assert.equal(nextRowWatermark(3, 3, 3), Number.POSITIVE_INFINITY)
  assert.equal(nextWatermark(5, 3, 3), 6)
  assert.equal(nextWatermark(3, 3, 3), Number.POSITIVE_INFINITY)
})

test('nextWatermark 剩余不超过一页时一次放完', () => {
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

  // 当前会话让基线正好覆盖全部行时，全露也不是用户展开出来的，按钮不应变「收起」。
  const allVisible = foldSessions(makeRows(6), 0, 's-6')
  assert.equal(allVisible.rows.length, 6)
  assert.equal(allVisible.expanded, false)
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
