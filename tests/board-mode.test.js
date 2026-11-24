import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BOARD_DEFAULT_KEY,
  BOARD_MODE_CINEMA,
  BOARD_MODE_DEFAULT,
  BOARD_MODE_KEY,
  BOARD_MODE_WORK,
  BOARD_MODES,
  announceBoardMode,
  cacheBoardDefault,
  normalizeBoardMode,
  readBoardMode,
  readBoardModeSnapshot,
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

test('合法模式只有两个，默认是炫酷', () => {
  assert.deepEqual([...BOARD_MODES], [BOARD_MODE_CINEMA, BOARD_MODE_WORK])
  assert.equal(BOARD_MODE_DEFAULT, BOARD_MODE_CINEMA)
})

test('未知值一律回到默认模式', () => {
  assert.equal(normalizeBoardMode(BOARD_MODE_WORK), BOARD_MODE_WORK)
  assert.equal(normalizeBoardMode(BOARD_MODE_CINEMA), BOARD_MODE_CINEMA)
  assert.equal(normalizeBoardMode('spectacle'), BOARD_MODE_CINEMA)
  assert.equal(normalizeBoardMode(''), BOARD_MODE_CINEMA)
  assert.equal(normalizeBoardMode(undefined), BOARD_MODE_CINEMA)
  assert.equal(normalizeBoardMode(null), BOARD_MODE_CINEMA)
})

test('没写过时读默认模式', () => {
  assert.equal(readBoardMode(createStorage()), BOARD_MODE_CINEMA)
})

test('没有任何偏好时快照标记未就绪：首帧不能把内置炫酷当成用户选择', () => {
  assert.deepEqual(readBoardModeSnapshot(createStorage()), { mode: BOARD_MODE_CINEMA, resolved: false })
  assert.deepEqual(readBoardModeSnapshot(undefined), { mode: BOARD_MODE_CINEMA, resolved: false })
})

test('显式选择与宿主默认缓存都算已就绪', () => {
  assert.deepEqual(
    readBoardModeSnapshot(createStorage({ [BOARD_MODE_KEY]: BOARD_MODE_WORK })),
    { mode: BOARD_MODE_WORK, resolved: true },
  )
  assert.deepEqual(
    readBoardModeSnapshot(createStorage({ [BOARD_DEFAULT_KEY]: BOARD_MODE_WORK })),
    { mode: BOARD_MODE_WORK, resolved: true },
  )
})

test('存储读不出来时同样是未就绪，而不是内置默认', () => {
  const throwing = {
    getItem: () => { throw new Error('privacy mode') },
  }
  assert.deepEqual(readBoardModeSnapshot(throwing), { mode: BOARD_MODE_CINEMA, resolved: false })
})

test('没有显式选择时用宿主缓存的默认值', () => {
  const storage = createStorage({ [BOARD_DEFAULT_KEY]: BOARD_MODE_WORK })
  assert.equal(readBoardMode(storage), BOARD_MODE_WORK)
})

test('显式选择永远压过宿主默认', () => {
  const storage = createStorage({
    [BOARD_MODE_KEY]: BOARD_MODE_CINEMA,
    [BOARD_DEFAULT_KEY]: BOARD_MODE_WORK,
  })
  assert.equal(readBoardMode(storage), BOARD_MODE_CINEMA)
})

test('缓存宿主默认：只在没有显式选择时写，同值不重复写', () => {
  const storage = createStorage()
  assert.equal(cacheBoardDefault(storage, BOARD_MODE_WORK), BOARD_MODE_WORK)
  assert.deepEqual(storage.writes, [[BOARD_DEFAULT_KEY, BOARD_MODE_WORK]])
  assert.equal(cacheBoardDefault(storage, BOARD_MODE_WORK), undefined)
  assert.equal(storage.writes.length, 1)

  const explicit = createStorage({ [BOARD_MODE_KEY]: BOARD_MODE_CINEMA })
  assert.equal(cacheBoardDefault(explicit, BOARD_MODE_WORK), undefined)
  assert.deepEqual(explicit.writes, [])
})

test('存储抛错时读回退默认，缓存写失败仍让默认值本次生效', () => {
  const throwing = {
    getItem: () => {
      throw new Error('privacy mode')
    },
    setItem: () => {
      throw new Error('privacy mode')
    },
  }
  assert.equal(readBoardMode(throwing), BOARD_MODE_CINEMA)
  // 写不进缓存也要广播给订阅者，否则看板会永远停在「偏好未就绪」
  assert.equal(cacheBoardDefault(throwing, BOARD_MODE_WORK), BOARD_MODE_WORK)
})

test('写进去的值读得回来', () => {
  const storage = createStorage()
  assert.equal(writeBoardMode(storage, BOARD_MODE_WORK), BOARD_MODE_WORK)
  assert.deepEqual(storage.writes, [[BOARD_MODE_KEY, BOARD_MODE_WORK]])
  assert.equal(readBoardMode(storage), BOARD_MODE_WORK)
})

test('写入前先规范化，坏值不会落盘', () => {
  const storage = createStorage()
  assert.equal(writeBoardMode(storage, 'nonsense'), BOARD_MODE_CINEMA)
  assert.deepEqual(storage.writes, [[BOARD_MODE_KEY, BOARD_MODE_CINEMA]])
})

test('存储缺失或抛错时按默认值读，写入静默丢弃', () => {
  assert.equal(readBoardMode(undefined), BOARD_MODE_CINEMA)
  const throwing = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
  }
  assert.equal(readBoardMode(throwing), BOARD_MODE_CINEMA)
  assert.equal(writeBoardMode(throwing, BOARD_MODE_WORK), BOARD_MODE_WORK)
})

test('订阅收到规范化后的模式，取消后不再收到', () => {
  const seen = []
  const off = subscribeBoardMode((mode) => seen.push(mode))
  announceBoardMode(BOARD_MODE_WORK)
  announceBoardMode('bogus')
  off()
  announceBoardMode(BOARD_MODE_WORK)
  assert.deepEqual(seen, [BOARD_MODE_WORK, BOARD_MODE_CINEMA])
})

test('setBoardMode 同时写盘与广播', () => {
  const storage = createStorage()
  const seen = []
  const off = subscribeBoardMode((mode) => seen.push(mode))
  assert.equal(setBoardMode(storage, BOARD_MODE_WORK), BOARD_MODE_WORK)
  off()
  assert.deepEqual(storage.writes, [[BOARD_MODE_KEY, BOARD_MODE_WORK]])
  assert.deepEqual(seen, [BOARD_MODE_WORK])
})
