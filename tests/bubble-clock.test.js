import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { formatBubbleClock } from '../src/client/bubble-clock.js'
import { translator } from './helpers/locale.js'

afterEach(() => {
  mock.timers.reset()
})

test('气泡时钟与宿主同口径：当天只给时分，往日带日期，跨年带年份', () => {
  const t = translator('zh')
  mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 11, 16, 0, 0).getTime() })
  assert.equal(formatBubbleClock(new Date(2026, 10, 11, 9, 5, 0).getTime(), t), '09:05')
  assert.equal(formatBubbleClock(new Date(2026, 10, 10, 9, 5, 0).getTime(), t), '11月10日 09:05')
  assert.equal(formatBubbleClock(new Date(2025, 10, 10, 9, 5, 0).getTime(), t), '2025年11月10日 09:05')
})

test('气泡时钟的日期模板跟着界面语言走', () => {
  const t = translator('en')
  mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 11, 16, 0, 0).getTime() })
  assert.equal(formatBubbleClock(new Date(2026, 10, 10, 9, 5, 0).getTime(), t), '11/10 09:05')
  assert.equal(formatBubbleClock(new Date(2025, 10, 10, 9, 5, 0).getTime(), t), '11/10/2025 09:05')
})
