import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  AUTO_RESUME_LIMIT_DEFAULT,
  AUTO_RESUME_LIMIT_MAX,
  AUTO_RESUME_LIMIT_MIN,
  BOARD_MODE_CINEMA,
  BOARD_MODE_DEFAULT,
  BOARD_MODE_WORK,
  BOARD_MODES,
  normalizeBoardMode,
  parseAutoResumeLimit,
  parseBoardMode,
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

test('看板模式只有 work / cinema，默认 work', () => {
  assert.deepEqual([...BOARD_MODES], [BOARD_MODE_WORK, BOARD_MODE_CINEMA])
  assert.equal(BOARD_MODE_DEFAULT, BOARD_MODE_WORK)
  assert.equal(normalizeBoardMode(BOARD_MODE_CINEMA), BOARD_MODE_CINEMA)
  assert.equal(normalizeBoardMode('spectacle'), BOARD_MODE_WORK)
  assert.equal(normalizeBoardMode(undefined), BOARD_MODE_WORK)
})

test('看板模式保存路径只接受两个合法值', () => {
  assert.equal(parseBoardMode(BOARD_MODE_WORK), BOARD_MODE_WORK)
  assert.equal(parseBoardMode(BOARD_MODE_CINEMA), BOARD_MODE_CINEMA)
  for (const value of ['', 'Cinema', 'spectacle', 1, null, undefined, {}]) {
    assert.equal(parseBoardMode(value), undefined, `${String(value)} 应判非法`)
  }
})
