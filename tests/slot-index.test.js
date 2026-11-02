import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCardStore } from '../src/host/cards/store.js'

/**
 * 建一个临时 home 下的卡片存储。
 * @returns {Promise<{ store: object, home: string }>} 存储与 home 目录
 */
async function createStore() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-kit-slot-index-'))
  return { store: createCardStore({ home }), home }
}

test('建卡即建索引，槽位名反查到会话', async () => {
  const { store, home } = await createStore()
  try {
    await store.create({ title: '任务', slots: { dev: { sessionId: 'session-dev' } } })
    assert.equal(store.slotIndex.get('session-dev'), 'dev')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('改卡改绑后索引同步更新', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({ title: '任务', slots: { dev: { sessionId: 'session-dev' } } })
    await store.update({ id: card.id, slots: { review: { sessionId: 'session-dev' } } })
    assert.equal(store.slotIndex.get('session-dev'), 'review')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('改卡清空槽位后索引移除该会话', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({ title: '任务', slots: { dev: { sessionId: 'session-dev' } } })
    await store.update({ id: card.id, slots: {} })
    assert.equal(store.slotIndex.has('session-dev'), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('同一会话绑在多张卡上时，编号大的卡片胜出', async () => {
  const { store, home } = await createStore()
  try {
    await store.create({ title: '第一张', slots: { dev: { sessionId: 'session-a' } } })
    await store.create({ title: '第二张', slots: { review: { sessionId: 'session-a' } } })
    assert.equal(store.slotIndex.get('session-a'), 'review')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('重启后能从卡片库重建槽位索引', async () => {
  const { store, home } = await createStore()
  try {
    await store.create({ title: '任务', slots: { dev: { sessionId: 'session-dev' } } })
    // 另一个进程实例：内存索引是空的，只能从落盘的卡片库恢复。
    const reopened = createCardStore({ home })
    assert.equal(reopened.slotIndex.has('session-dev'), false)
    await reopened.loadSlotIndex()
    assert.equal(reopened.slotIndex.get('session-dev'), 'dev')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

/**
 * 造一个可控的文件系统：内容在内存里，第一次读被卡住直到放行。
 *
 * 用来构造「启动重建的读盘还在进行时，落盘已经完成」的交错——真实文件系统下
 * 这个顺序排不出来，卡住第一次读才排得出来。
 *
 * @param {string} initial - 初始卡片库内容
 * @returns {{ io: object, release: () => void }} 文件系统调用与放行动作
 */
function createControlledIo(initial) {
  let content = initial
  let reads = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  return {
    io: {
      mkdir: async () => {},
      rename: async () => {},
      writeFile: async (_file, text) => { content = text },
      readFile: async () => {
        const snapshot = content
        reads += 1
        if (reads === 1) await gate
        return snapshot
      },
    },
    release: () => release(),
  }
}

test('启动重建与写卡交错时不丢最新槽位绑定', async () => {
  const initial = JSON.stringify({
    version: 1,
    counter: 1,
    cards: [{
      id: 'card-a',
      number: 1,
      revision: 0,
      title: '已有卡片',
      status: 'active',
      slots: { dev: { sessionId: 'session-dev' } },
      createdAt: 0,
      updatedAt: 0,
    }],
  })
  const controlled = createControlledIo(initial)
  const store = createCardStore({ home: '/tmp/dsh-leader-kit-slot-index', io: controlled.io })

  // 进程启动时的索引重建：读盘被卡住。
  const loading = store.loadSlotIndex()
  // 重建还没读完时，落盘一次新的槽位绑定。
  const creating = store.create({ title: '新卡片', slots: { review: { sessionId: 'session-review' } } })
  // 让写卡的链路先跑完（微任务跑完才轮到定时器）。
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  controlled.release()
  await Promise.all([loading, creating])

  assert.equal(store.slotIndex.get('session-dev'), 'dev')
  assert.equal(store.slotIndex.get('session-review'), 'review')
})
