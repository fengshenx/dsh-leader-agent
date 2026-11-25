import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AUTO_RESUME_LIMIT_DEFAULT,
  AUTO_RESUME_LIMIT_MAX,
  AUTO_RESUME_LIMIT_MIN,
  parseAutoResumeLimit,
} from '../src/shared/settings.js'

test('默认上限是 200，范围 1–10000', () => {
  assert.equal(AUTO_RESUME_LIMIT_DEFAULT, 200)
  assert.equal(AUTO_RESUME_LIMIT_MIN, 1)
  assert.equal(AUTO_RESUME_LIMIT_MAX, 10000)
})

test('解析接受整数与数字字符串，拒绝空串、小数与越界值', () => {
  assert.equal(parseAutoResumeLimit(200), 200)
  assert.equal(parseAutoResumeLimit(' 350 '), 350)
  assert.equal(parseAutoResumeLimit(AUTO_RESUME_LIMIT_MIN), AUTO_RESUME_LIMIT_MIN)
  assert.equal(parseAutoResumeLimit(AUTO_RESUME_LIMIT_MAX), AUTO_RESUME_LIMIT_MAX)
  for (const value of ['', '  ', 'abc', 0, -1, 1.5, AUTO_RESUME_LIMIT_MAX + 1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}]) {
    assert.equal(parseAutoResumeLimit(value), undefined, `${String(value)} 应判非法`)
  }
})
