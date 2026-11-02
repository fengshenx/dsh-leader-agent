import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCardStore } from '../src/host/cards/store.js'

/**
 * 建一个临时 home 下的卡片存储。
 * @returns {Promise<{ store: object, home: string }>} 存储与 home 目录
 */
async function createStore() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-kit-cards-'))
  return { store: createCardStore({ home }), home }
}

test('建卡分配编号，编号逐张递增且不复用', async () => {
  const { store, home } = await createStore()
  try {
    const first = await store.create({ title: '第一张' })
    const second = await store.create({ title: '第二张' })
    assert.equal(first.number, 1)
    assert.equal(second.number, 2)
    assert.equal(first.revision, 0)
    assert.equal(first.status, 'active')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('改卡递增内容版本，版本不符即冲突且不落盘', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({ title: '标题' })
    const updated = await store.update({ id: card.id, title: '新标题', expectedRevision: 0 })
    assert.equal(updated.revision, 1)
    assert.equal(updated.title, '新标题')
    await assert.rejects(
      () => store.update({ id: card.id, title: '再改', expectedRevision: 0 }),
      /版本冲突/,
    )
    const current = await store.get(card.id)
    assert.equal(current.title, '新标题')
    assert.equal(current.revision, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('状态流转：切 done 记 doneAt，回到 active 清除', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({ title: '任务' })
    const done = await store.update({ id: card.id, status: 'done' })
    assert.equal(done.status, 'done')
    assert.equal(typeof done.doneAt, 'number')
    const active = await store.update({ id: card.id, status: 'active' })
    assert.equal(active.status, 'active')
    assert.equal(active.doneAt, undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('归档是终态，归档后不可再改', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({ title: '任务' })
    const archived = await store.update({ id: card.id, status: 'archived' })
    assert.equal(archived.status, 'archived')
    await assert.rejects(() => store.update({ id: card.id, title: '再改' }), /已归档/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('列表按编号升序，可按状态过滤', async () => {
  const { store, home } = await createStore()
  try {
    const first = await store.create({ title: '一' })
    await store.create({ title: '二' })
    await store.update({ id: first.id, status: 'done' })
    const all = await store.list()
    assert.deepEqual(all.map((card) => card.number), [1, 2])
    const done = await store.list({ status: 'done' })
    assert.equal(done.length, 1)
    assert.equal(done[0].number, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('改不存在的卡片报错', async () => {
  const { store, home } = await createStore()
  try {
    await assert.rejects(() => store.update({ id: 'nope', title: 'x' }), /卡片不存在/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('卡片库损坏时备份原文件并以空库继续', async () => {
  const { store, home } = await createStore()
  try {
    await store.create({ title: '一张' })
    await writeFile(store.file, '{ 坏掉的 json', 'utf8')
    const cards = await store.list()
    assert.deepEqual(cards, [])
    const raw = await readFile(store.file, 'utf8')
    assert.deepEqual(JSON.parse(raw).cards, [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('并发建卡不丢卡、编号不重复', async () => {
  const { store, home } = await createStore()
  try {
    const created = await Promise.all(
      Array.from({ length: 5 }, (_, index) => store.create({ title: `卡 ${index}` })),
    )
    const numbers = created.map((card) => card.number).sort((a, b) => a - b)
    assert.deepEqual(numbers, [1, 2, 3, 4, 5])
    const cards = await store.list()
    assert.equal(cards.length, 5)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('counter 丢失或落后时以存量卡片的最大编号续号，不重号', async () => {
  const { store, home } = await createStore()
  try {
    await store.create({ title: '一' })
    await store.create({ title: '二' })
    const raw = JSON.parse(await readFile(store.file, 'utf8'))
    delete raw.counter
    await writeFile(store.file, JSON.stringify(raw), 'utf8')
    const third = await store.create({ title: '三' })
    assert.equal(third.number, 3)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('零字段更新不递增版本，也不刷新更新时间与落盘', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({ title: '任务' })
    const before = await readFile(store.file, 'utf8')
    const same = await store.update({ id: card.id })
    assert.equal(same.revision, 0)
    assert.equal(same.updatedAt, card.updatedAt)
    assert.equal(await readFile(store.file, 'utf8'), before)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('按会话反查它挂在哪些卡上，带卡号、状态与槽位名', async () => {
  const { store, home } = await createStore()
  try {
    const first = await store.create({ title: '实现登录', slots: { dev: { sessionId: 's1' } } })
    const second = await store.create({ title: '审查登录', slots: { review: { sessionId: 's1' }, dev: { sessionId: 's2' } } })
    await store.update({ id: second.id, status: 'done' })

    // 一个会话可以同时被多张卡绑到不同槽位：投递门禁要看到全部，不能只挑最新那张。
    assert.deepEqual(await store.bindingsOf('s1'), [
      { cardId: first.id, number: first.number, title: '实现登录', status: 'active', slot: 'dev' },
      { cardId: second.id, number: second.number, title: '审查登录', status: 'done', slot: 'review' },
    ])
    assert.deepEqual(await store.bindingsOf('s2'), [
      { cardId: second.id, number: second.number, title: '审查登录', status: 'done', slot: 'dev' },
    ])
    assert.deepEqual(await store.bindingsOf('没挂卡的会话'), [])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('状态没变不算内容更新，不递增版本', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({ title: '任务' })
    const same = await store.update({ id: card.id, status: 'active' })
    assert.equal(same.revision, 0)
    assert.equal(same.updatedAt, card.updatedAt)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('按项目列卡：无归属的存量卡不进任何项目', async () => {
  const { store, home } = await createStore()
  try {
    await store.create({ title: '项目一的卡', projectId: 'p1' })
    await store.create({ title: '项目二的卡', projectId: 'p2' })
    await store.create({ title: '存量卡' })
    const mine = await store.list({ projectId: 'p1' })
    assert.deepEqual(mine.map((card) => card.title), ['项目一的卡'])
    // 空串是「无归属」这一档：存量卡没有 projectId 字段，算在里头
    const orphan = await store.list({ projectId: '' })
    assert.deepEqual(orphan.map((card) => card.title), ['存量卡'])
    const all = await store.list()
    assert.equal(all.length, 3)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('改卡不改变归属：卡片始终留在建卡时的项目里', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({ title: '任务', projectId: 'p1' })
    const updated = await store.update({ id: card.id, title: '改了' })
    assert.equal(updated.projectId, 'p1')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('摘会话：删掉指向它的槽位，同卡其它槽位与其它卡不动', async () => {
  const { store, home } = await createStore()
  try {
    const bound = await store.create({
      title: '绑了两个槽位',
      slots: { builder: { sessionId: 's1' }, reviewer: { sessionId: 's2' } },
    })
    const other = await store.create({ title: '别的卡', slots: { builder: { sessionId: 's9' } } })
    await store.loadIndexes()

    const result = await store.detachSession('s1')
    assert.deepEqual(result, { cards: [bound.id], slots: 1 })

    const after = await store.get(bound.id)
    assert.deepEqual(after.slots, { reviewer: { sessionId: 's2' } })
    // 内容变了就要 bump 版本：否则别的会话拿着旧 revision 改卡会被误判成并发冲突。
    assert.equal(after.revision, 1)
    const untouched = await store.get(other.id)
    assert.deepEqual(untouched.slots, { builder: { sessionId: 's9' } })
    assert.equal(untouched.revision, 0)
    // 槽位反查索引必须同步：不然归档的会话下一轮 turn 仍会被注入角色。
    assert.equal(store.slotIndex.has('s1'), false)
    assert.equal(store.slotIndex.get('s2'), 'reviewer')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('摘会话：没有绑定时不改任何卡、不落盘', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({ title: '没绑槽位' })
    assert.deepEqual(await store.detachSession('s1'), { cards: [], slots: 0 })
    assert.equal((await store.get(card.id)).revision, 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('摘会话：已归档的卡片也摘，槽位索引不区分卡片状态', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({ title: '已归档', slots: { builder: { sessionId: 's1' } } })
    await store.update({ id: card.id, status: 'archived' })
    await store.loadIndexes()
    assert.equal(store.slotIndex.has('s1'), true)

    assert.deepEqual(await store.detachSession('s1'), { cards: [card.id], slots: 1 })
    const after = await store.get(card.id)
    assert.deepEqual(after.slots, {})
    assert.equal(after.status, 'archived')
    assert.equal(store.slotIndex.has('s1'), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('addLinks 追加链接并保留原有条目', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({
      title: '任务',
      links: [{ id: 'issue', label: 'Issue', url: 'https://example.test/1' }],
    })
    const updated = await store.update({
      id: card.id,
      addLinks: [{ label: 'PR', url: 'https://example.test/pr/2' }],
    })
    assert.deepEqual(updated.links, [
      { id: 'issue', label: 'Issue', url: 'https://example.test/1' },
      { label: 'PR', url: 'https://example.test/pr/2' },
    ])
    assert.equal(updated.revision, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('addLinks 同 id 原位更新字段，不产生重复条目', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({
      title: '任务',
      links: [{ id: 'pr', label: 'PR', url: 'https://example.test/draft' }],
    })
    const updated = await store.update({
      id: card.id,
      addLinks: [{ id: 'pr', label: 'PR', url: 'https://example.test/pr/2', purpose: '交付' }],
    })
    assert.equal(updated.links.length, 1)
    assert.equal(updated.links[0].url, 'https://example.test/pr/2')
    assert.equal(updated.links[0].purpose, '交付')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('addLinks 没带 id 时按 label+url 去重，重复调用不长出重复链接', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({ title: '任务' })
    const link = { label: 'PR', url: 'https://example.test/pr/2' }
    await store.update({ id: card.id, addLinks: [link] })
    const again = await store.update({ id: card.id, addLinks: [link] })
    assert.equal(again.links.length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('addLinks 与 links 互斥：同次传会覆盖别人刚写的链接，必须拒绝', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({ title: '任务' })
    await assert.rejects(
      () => store.update({
        id: card.id,
        links: [{ label: 'PR', url: 'https://example.test/pr/2' }],
        addLinks: [{ label: 'Issue', url: 'https://example.test/1' }],
      }),
      /不能同时传/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('addLinks 没有实质变化时不递增版本', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({ title: '任务' })
    const added = await store.update({ id: card.id, addLinks: [{ label: 'PR' }] })
    const same = await store.update({ id: card.id, addLinks: [{ label: 'PR' }] })
    assert.equal(same.revision, added.revision)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bindSlot 把槽位绑到指定会话并同步索引', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({ title: '任务' })
    const updated = await store.bindSlot({ cardId: card.id, slot: 'dev', sessionId: 'worker-1' })
    assert.deepEqual(updated.slots, { dev: { sessionId: 'worker-1' } })
    assert.equal(updated.revision, 1)
    assert.equal(store.slotIndex.get('worker-1'), 'dev')
    assert.equal(store.cardIndex.get('worker-1')[0].cardId, card.id)
    // 幂等：同一个会话再绑一次不改版本。
    const again = await store.bindSlot({ cardId: card.id, slot: 'dev', sessionId: 'worker-1' })
    assert.equal(again.revision, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('bindSlot 拒绝顶替已绑到别的会话的槽位', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({ title: '任务', slots: { dev: { sessionId: 'worker-1' } } })
    await assert.rejects(
      () => store.bindSlot({ cardId: card.id, slot: 'dev', sessionId: 'worker-2' }),
      /已绑到会话 worker-1/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('卡片事实索引随建卡、改卡、摘绑定同步', async () => {
  const { store, home } = await createStore()
  try {
    const card = await store.create({
      title: '任务',
      spec: '第一版规格',
      slots: { dev: { sessionId: 'worker-1' } },
    })
    const before = store.cardIndex.get('worker-1')
    assert.equal(before[0].spec, '第一版规格')
    assert.equal(before[0].revision, 0)

    await store.update({ id: card.id, spec: '第二版规格', addLinks: [{ label: 'PR' }] })
    const after = store.cardIndex.get('worker-1')
    assert.equal(after[0].spec, '第二版规格')
    assert.equal(after[0].revision, 1)
    assert.deepEqual(after[0].links, [{ label: 'PR' }])

    await store.detachSession('worker-1')
    assert.equal(store.cardIndex.has('worker-1'), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
