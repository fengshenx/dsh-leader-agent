import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createNotificationStore, resolveDshHome } from '../src/host/notification-store.js'

/**
 * 建一个临时 home 下的通知队列。
 * @returns {Promise<{ store: object, home: string }>} 队列与 home 目录
 */
async function createStore() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-kit-store-'))
  return { store: createNotificationStore({ home }), home }
}

const SAMPLE = {
  id: 'note-1',
  childId: 'child-1',
  parentSessionId: 'parent-1',
  label: '实现派工',
  text: '任务「实现派工」已结束。',
  createdAt: 1,
  attempts: 0,
}

test('空队列时读出空列表', async () => {
  const { store, home } = await createStore()
  try {
    assert.deepEqual(await store.listPending(), [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('入队后可读出，标记已投递后移出队列', async () => {
  const { store, home } = await createStore()
  try {
    await store.enqueue(SAMPLE)
    assert.equal((await store.listPending()).length, 1)
    await store.markDelivered('note-1')
    assert.equal((await store.listPending()).length, 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('投递失败时通知留在队列并累计尝试次数', async () => {
  const { store, home } = await createStore()
  try {
    await store.enqueue(SAMPLE)
    await store.markUndelivered('note-1', '父会话不在注册表中')
    const pending = await store.listPending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].attempts, 1)
    assert.equal(pending[0].lastError, '父会话不在注册表中')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('同一 id 重复入队只留一条，不覆盖已落盘的内容', async () => {
  const { store, home } = await createStore()
  try {
    await store.enqueue(SAMPLE)
    // 落盘失败重试或投递失败后重结算会再入队同一个 id：内容以第一次落盘的为准。
    await store.enqueue({ ...SAMPLE, text: '新一轮的正文' })
    const pending = await store.listPending()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].text, SAMPLE.text)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('队列文件损坏时备份并以空队列继续', async () => {
  const { store, home } = await createStore()
  const logs = []
  const noisy = createNotificationStore({ home, logger: (message) => logs.push(message) })
  try {
    await mkdir(noisy.directory, { recursive: true })
    await writeFile(noisy.file, '{ 不是合法 JSON', 'utf8')
    assert.deepEqual(await noisy.listPending(), [])
    assert.equal(logs.length, 1)
    assert.match(logs[0], /损坏/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('队列结构非法时按损坏处理：合法 JSON 但缺 pending 数组', async () => {
  const { home } = await createStore()
  const logs = []
  const noisy = createNotificationStore({ home, logger: (message) => logs.push(message) })
  try {
    await mkdir(noisy.directory, { recursive: true })
    await writeFile(noisy.file, JSON.stringify({ version: 1 }), 'utf8')
    assert.deepEqual(await noisy.listPending(), [])
    assert.equal(logs.length, 1)
    assert.match(logs[0], /损坏/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('落盘内容是可读 JSON，便于人工排查', async () => {
  const { store, home } = await createStore()
  try {
    await store.enqueue(SAMPLE)
    const raw = await readFile(store.file, 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.pending[0].label, '实现派工')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('DSH_HOME 优先于默认家目录', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/custom/dsh' }, () => '/home/user'), '/custom/dsh')
  assert.equal(resolveDshHome({}, () => '/home/user'), join('/home/user', '.dsh'))
})

test('换 leader 后只改未投递通知的接收者', async () => {
  const { store, home } = await createStore()
  try {
    await store.enqueue({ ...SAMPLE, id: 'note-pending', childId: 'child-1' })
    await store.enqueue({ ...SAMPLE, id: 'note-other', childId: 'child-2', parentSessionId: 'parent-2' })
    // 已投出的一条：属于旧会话的历史，不该跟着改投
    await store.enqueue({ ...SAMPLE, id: 'note-delivered', childId: 'child-3' })
    await store.markDelivered('note-delivered')

    const moved = await store.reassignParent('parent-1', 'parent-new')
    assert.equal(moved, 1)
    const pending = await store.listPending()
    assert.deepEqual(pending.map((item) => [item.id, item.parentSessionId]), [
      ['note-pending', 'parent-new'],
      ['note-other', 'parent-2'],
    ])
    // 再改一次：没有可动的条目，计数为 0
    assert.equal(await store.reassignParent('parent-1', 'parent-new'), 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
