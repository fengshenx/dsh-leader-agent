import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BOARD_MODE_CINEMA,
  BOARD_MODE_DEFAULT,
  BOARD_MODE_KEY,
  BOARD_MODE_WORK,
  BOARD_MODES,
  announceBoardMode,
  normalizeBoardMode,
  readBoardMode,
  setBoardMode,
  subscribeBoardMode,
  writeBoardMode,
} from '../src/client/board-mode.js'

/**
 * 造一个够用的存储桩。
 * @param {Record<string, string>} [initial] - 初始内容
 * @returns {object} 存储桩与它收到的写入
 */
function createStorage(initial = {}) {
  const entries = new Map(Object.entries(initial))
  const writes = []
  return {
    writes,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      writes.push([key, value])
      entries.set(key, value)
    },
  }
}

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

test('没写过时读工作模式', () => {
  assert.equal(readBoardMode(createStorage()), BOARD_MODE_WORK)
  assert.equal(readBoardMode(undefined), BOARD_MODE_WORK)
})

test('显式选择读得回来', () => {
  assert.equal(readBoardMode(createStorage({ [BOARD_MODE_KEY]: BOARD_MODE_CINEMA })), BOARD_MODE_CINEMA)
  assert.equal(readBoardMode(createStorage({ [BOARD_MODE_KEY]: BOARD_MODE_WORK })), BOARD_MODE_WORK)
})

// 迁移回归：上一版把宿主判定的默认值缓存在 board.default，它不是用户选择；
// 默认统一为 work 后这个键必须被彻底忽略，否则旧浏览器的 cinema 缓存会把用户留在炫酷。
test('旧默认缓存键不再读取', () => {
  assert.equal(
    readBoardMode(createStorage({ 'dsh-leader-agent.board.default': BOARD_MODE_CINEMA })),
    BOARD_MODE_WORK,
  )
  assert.equal(
    readBoardMode(createStorage({ 'dsh-leader-agent.board.default': BOARD_MODE_WORK })),
    BOARD_MODE_WORK,
  )
})

test('显式选择压过旧默认缓存', () => {
  assert.equal(
    readBoardMode(createStorage({
      [BOARD_MODE_KEY]: BOARD_MODE_CINEMA,
      'dsh-leader-agent.board.default': BOARD_MODE_WORK,
    })),
    BOARD_MODE_CINEMA,
  )
  assert.equal(
    readBoardMode(createStorage({
      [BOARD_MODE_KEY]: BOARD_MODE_WORK,
      'dsh-leader-agent.board.default': BOARD_MODE_CINEMA,
    })),
    BOARD_MODE_WORK,
  )
})

test('存储读不出来时回到工作模式', () => {
  const throwing = {
    getItem: () => { throw new Error('privacy mode') },
  }
  assert.equal(readBoardMode(throwing), BOARD_MODE_WORK)
})

test('写进去的值读得回来', () => {
  const storage = createStorage()
  assert.equal(writeBoardMode(storage, BOARD_MODE_CINEMA), BOARD_MODE_CINEMA)
  assert.deepEqual(storage.writes, [[BOARD_MODE_KEY, BOARD_MODE_CINEMA]])
  assert.equal(readBoardMode(storage), BOARD_MODE_CINEMA)
})

test('写入前先规范化，坏值不会落盘成未知模式', () => {
  const storage = createStorage()
  assert.equal(writeBoardMode(storage, 'nonsense'), BOARD_MODE_WORK)
  assert.deepEqual(storage.writes, [[BOARD_MODE_KEY, BOARD_MODE_WORK]])
})

test('存储缺失或抛错时按默认值读，写入静默丢弃', () => {
  assert.equal(readBoardMode(undefined), BOARD_MODE_WORK)
  const throwing = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
  }
  assert.equal(readBoardMode(throwing), BOARD_MODE_WORK)
  assert.equal(writeBoardMode(throwing, BOARD_MODE_CINEMA), BOARD_MODE_CINEMA)
})

test('订阅收到规范化后的模式，取消后不再收到', () => {
  const seen = []
  const off = subscribeBoardMode((mode) => seen.push(mode))
  announceBoardMode(BOARD_MODE_CINEMA)
  announceBoardMode('bogus')
  off()
  announceBoardMode(BOARD_MODE_CINEMA)
  assert.deepEqual(seen, [BOARD_MODE_CINEMA, BOARD_MODE_WORK])
})

test('setBoardMode 同时写盘与广播', () => {
  const storage = createStorage()
  const seen = []
  const off = subscribeBoardMode((mode) => seen.push(mode))
  assert.equal(setBoardMode(storage, BOARD_MODE_CINEMA), BOARD_MODE_CINEMA)
  off()
  assert.deepEqual(storage.writes, [[BOARD_MODE_KEY, BOARD_MODE_CINEMA]])
  assert.deepEqual(seen, [BOARD_MODE_CINEMA])
})
