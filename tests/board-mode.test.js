import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BOARD_MODE_CINEMA,
  BOARD_MODE_DEFAULT,
  BOARD_MODE_WORK,
  BOARD_MODES,
  getBoardMode,
  normalizeBoardMode,
  setBoardMode,
  subscribeBoardMode,
} from '../src/client/board-mode.js'

test('合法模式只有两个，默认是工作模式', () => {
  assert.deepEqual([...BOARD_MODES], [BOARD_MODE_WORK, BOARD_MODE_CINEMA])
  assert.equal(BOARD_MODE_DEFAULT, BOARD_MODE_WORK)
})

test('未知值一律回到工作模式，只有显式 cinema 才进炫酷', () => {
  assert.equal(normalizeBoardMode(BOARD_MODE_WORK), BOARD_MODE_WORK)
  assert.equal(normalizeBoardMode(BOARD_MODE_CINEMA), BOARD_MODE_CINEMA)
  assert.equal(normalizeBoardMode('spectacle'), BOARD_MODE_WORK)
  assert.equal(normalizeBoardMode(''), BOARD_MODE_WORK)
  assert.equal(normalizeBoardMode(undefined), BOARD_MODE_WORK)
  assert.equal(normalizeBoardMode(null), BOARD_MODE_WORK)
})

test('运行时快照默认是工作模式，set 后读得到', () => {
  setBoardMode(BOARD_MODE_WORK)
  assert.equal(getBoardMode(), BOARD_MODE_WORK)
  assert.equal(setBoardMode(BOARD_MODE_CINEMA), BOARD_MODE_CINEMA)
  assert.equal(getBoardMode(), BOARD_MODE_CINEMA)
  assert.equal(setBoardMode('nonsense'), BOARD_MODE_WORK)
  assert.equal(getBoardMode(), BOARD_MODE_WORK)
})

test('订阅收到规范化后的模式，取消后不再收到；同值不重复广播', () => {
  setBoardMode(BOARD_MODE_WORK)
  const seen = []
  const off = subscribeBoardMode((mode) => seen.push(mode))
  setBoardMode(BOARD_MODE_CINEMA)
  setBoardMode(BOARD_MODE_CINEMA)
  setBoardMode('bogus')
  off()
  setBoardMode(BOARD_MODE_CINEMA)
  assert.deepEqual(seen, [BOARD_MODE_CINEMA, BOARD_MODE_WORK])
})
