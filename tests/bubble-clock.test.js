import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { formatBubbleClock } from '../src/client/bubble-clock.js'

afterEach(() => {
  mock.timers.reset()
})

test('气泡时钟与宿主同口径：当天只给时分，往日带日期，跨年带年份', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 11, 16, 0, 0).getTime() })
  assert.equal(formatBubbleClock(new Date(2026, 10, 11, 9, 5, 0).getTime()), '09:05')
  assert.equal(formatBubbleClock(new Date(2026, 10, 10, 9, 5, 0).getTime()), '11月10日 09:05')
  assert.equal(formatBubbleClock(new Date(2025, 10, 10, 9, 5, 0).getTime()), '2025年11月10日 09:05')
})
