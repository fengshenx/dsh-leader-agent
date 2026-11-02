import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCardStore } from '../src/host/cards/store.js'
import {
  createCreateCardTool,
  createUpdateCardTool,
  createListCardsTool,
} from '../src/host/tools/cards.js'

/**
 * 建一组卡片工具与它们共用的存储。
 * @param {(sessionId: string | undefined) => Promise<object | undefined>} [resolveProject] -
 *   解析调用方会话所属项目；不传则卡片没有归属
 * @returns {Promise<{ home: string, tools: Record<string, object> }>} 工具集与 home 目录
 */
async function createTools(resolveProject) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-kit-cardtools-'))
  // 可控时钟：卡片排序按更新时间戳，两次写入落在同一毫秒会退回插入序，
  // 断言「最近更新的排前面」就成了碰运气的 flaky 用例。
  let tick = 0
  const store = createCardStore({ home, clock: () => Date.now() + (tick += 1) })
  return {
    home,
    tools: {
      create_card: createCreateCardTool({ store, resolveProject }),
      update_card: createUpdateCardTool({ store, resolveProject }),
      list_cards: createListCardsTool({ store, resolveProject }),
    },
  }
}

/** 假的执行上下文：只需 agent 与 signal。 */
const exec = { agent: { id: 'session-1' }, signal: undefined }

test('建卡工具返回完整卡片，模型视图是简短确认', async () => {
  const { home, tools } = await createTools()
  try {
    const result = await tools.create_card.execute(
      { title: '实现派工', spec: '验收：能派工并回报' },
      exec,
    )
    assert.equal(result.card.title, '实现派工')
    assert.equal(result.card.number, 1)
    assert.equal(result.card.revision, 0)
    assert.equal(result.card.status, 'active')
    const rendered = tools.create_card.output.render({}, result)
    assert.match(rendered[0].text, /已建卡 #1「实现派工」/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('建卡工具拒绝空标题', async () => {
  const { home, tools } = await createTools()
  try {
    await assert.rejects(() => tools.create_card.execute({ title: '  ' }, exec), /title 不能为空/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('建卡工具补齐链接条目 id', async () => {
  const { home, tools } = await createTools()
  try {
    const result = await tools.create_card.execute(
      { title: '任务', links: [{ label: 'MR', url: 'https://example.test/mr/1' }] },
      exec,
    )
    assert.equal(result.card.links.length, 1)
    assert.equal(typeof result.card.links[0].id, 'string')
    assert.equal(result.card.links[0].label, 'MR')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('改卡工具透传版本校验，冲突时报错', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    const updated = await tools.update_card.execute(
      { id: created.card.id, status: 'done', expectedRevision: 0 },
      exec,
    )
    assert.equal(updated.card.status, 'done')
    assert.equal(updated.card.revision, 1)
    await assert.rejects(
      () => tools.update_card.execute(
        { id: created.card.id, title: 'x', expectedRevision: 0 },
        exec,
      ),
      /版本冲突/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('改卡工具拒绝空 id', async () => {
  const { home, tools } = await createTools()
  try {
    await assert.rejects(() => tools.update_card.execute({ id: '' }, exec), /id 不能为空/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('查卡工具默认只列 active，归档卡要显式要', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    await tools.update_card.execute({ id: created.card.id, status: 'archived' }, exec)
    const listed = await tools.list_cards.execute({}, exec)
    // 工具值是全量卡片：客户端看板要按全量重建视图，不能被状态过滤裁掉
    assert.equal(listed.cards.length, 1)
    assert.match(tools.list_cards.output.render({}, listed)[0].text, /项目当前没有 active 卡/)
    const withArchived = await tools.list_cards.execute({ status: 'all' }, exec)
    assert.match(tools.list_cards.output.render({}, withArchived)[0].text, /任务 \[archived\]/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('查卡工具按状态过滤，模型视图列出编号与标题', async () => {
  const { home, tools } = await createTools()
  try {
    await tools.create_card.execute({ title: '一' }, exec)
    await tools.create_card.execute({ title: '二' }, exec)
    const listed = await tools.list_cards.execute({}, exec)
    assert.equal(listed.cards.length, 2)
    const rendered = tools.list_cards.output.render({}, listed)[0].text
    assert.match(rendered, /# #1 一 \[active\]/)
    assert.match(rendered, /# #2 二 \[active\]/)
    // 最近更新的排前面：协调者关心的是正在动的卡
    assert.ok(rendered.indexOf('# #2 二') < rendered.indexOf('# #1 一'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('卡片数据投影到 presentationMeta，客户端据此重建看板', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    const single = tools.create_card.output.presentationMeta({}, created)
    assert.equal(single.kind, 'dsh-leader-kit-cards')
    assert.equal(single.scope, 'card')
    assert.equal(single.cards[0].title, '任务')
    const listed = await tools.list_cards.execute({}, exec)
    const all = tools.list_cards.output.presentationMeta({}, listed)
    assert.equal(all.scope, 'all')
    assert.equal(all.cards.length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('查卡工具显式指定 archived 时返回归档卡，不被默认排除滤空', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    await tools.update_card.execute({ id: created.card.id, status: 'archived' }, exec)
    const listed = await tools.list_cards.execute({ status: 'archived' }, exec)
    assert.equal(listed.cards.length, 1)
    assert.equal(listed.cards[0].status, 'archived')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('建卡工具拒绝缺 label 的链接条目', async () => {
  const { home, tools } = await createTools()
  try {
    await assert.rejects(
      () => tools.create_card.execute({ title: '任务', links: [{ url: 'https://example.test/mr/1' }] }, exec),
      /links 条目缺 label/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('改卡工具拒绝空标题', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    await assert.rejects(
      () => tools.update_card.execute({ id: created.card.id, title: '  ' }, exec),
      /title 不能为空/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('建卡与改卡工具接受中文槽位名', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute(
      { title: '任务', slots: { 开发: { sessionId: 's1' } } },
      exec,
    )
    assert.deepEqual(Object.keys(created.card.slots), ['开发'])
    const updated = await tools.update_card.execute(
      { id: created.card.id, slots: { 开发: { sessionId: 's1' }, 审核: { sessionId: 's2' } } },
      exec,
    )
    assert.deepEqual(Object.keys(updated.card.slots), ['开发', '审核'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('建卡与改卡工具拒绝非法槽位名', async () => {
  const { home, tools } = await createTools()
  try {
    await assert.rejects(
      () => tools.create_card.execute(
        { title: '任务', slots: { 'Bad Name': { sessionId: 's1' } } },
        exec,
      ),
      /槽位名 "Bad Name" 不合法/,
    )
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    await assert.rejects(
      () => tools.update_card.execute(
        { id: created.card.id, slots: { '开发/审核': { sessionId: 's1' } } },
        exec,
      ),
      /槽位名 "开发\/审核" 不合法/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('建卡与改卡工具拒绝缺 sessionId 的槽位绑定', async () => {
  const { home, tools } = await createTools()
  try {
    await assert.rejects(
      () => tools.create_card.execute({ title: '任务', slots: { dev: {} } }, exec),
      /槽位 dev 缺 sessionId/,
    )
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    await assert.rejects(
      () => tools.update_card.execute({ id: created.card.id, slots: { review: { sessionId: '  ' } } }, exec),
      /槽位 review 缺 sessionId/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('改卡工具拒绝非整数的 expectedRevision', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    await assert.rejects(
      () => tools.update_card.execute({ id: created.card.id, title: '新标题', expectedRevision: '0' }, exec),
      /expectedRevision 必须是整数/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('只带 id 的改卡不递增版本，不作废他人持有的 expectedRevision', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    const updated = await tools.update_card.execute({ id: created.card.id }, exec)
    assert.equal(updated.card.revision, 0)
    const after = await tools.update_card.execute(
      { id: created.card.id, title: '新标题', expectedRevision: 0 },
      exec,
    )
    assert.equal(after.card.revision, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('建卡与改卡工具拒绝类型不符的规格', async () => {
  const { home, tools } = await createTools()
  try {
    await assert.rejects(
      () => tools.create_card.execute({ title: '任务', spec: 123 }, exec),
      /spec 必须是字符串/,
    )
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    await assert.rejects(
      () => tools.update_card.execute({ id: created.card.id, spec: 123 }, exec),
      /spec 必须是字符串/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('改卡工具拒绝非数字的排序序号', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    await assert.rejects(
      () => tools.update_card.execute({ id: created.card.id, sortOrder: '1' }, exec),
      /sortOrder 必须是数字/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('建卡与改卡拒收已移除的 checkpoint', async () => {
  const { home, tools } = await createTools()
  try {
    await assert.rejects(
      () => tools.create_card.execute({ title: '任务', checkpoint: { summary: '旧事实' } }, exec),
      /checkpoint 已移除/,
    )
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    await assert.rejects(
      () => tools.update_card.execute({ id: created.card.id, checkpoint: { summary: '旧事实' } }, exec),
      /checkpoint 已移除/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('建卡工具拒绝类型不符的链接字段', async () => {
  const { home, tools } = await createTools()
  try {
    await assert.rejects(
      () => tools.create_card.execute({ title: '任务', links: [{ label: 'MR', url: 42 }] }, exec),
      /url 必须是字符串/,
    )
    await assert.rejects(
      () => tools.create_card.execute({ title: '任务', links: [{ label: 'MR', purpose: 1 }] }, exec),
      /purpose 必须是字符串/,
    )
    await assert.rejects(
      () => tools.create_card.execute({ title: '任务', links: [{ label: 'MR', id: 7 }] }, exec),
      /id 必须是非空字符串/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('查卡工具拒绝非法状态与非法的分页参数', async () => {
  const { home, tools } = await createTools()
  try {
    await assert.rejects(
      () => tools.list_cards.execute({ status: 'archivedd' }, exec),
      /status 非法/,
    )
    await assert.rejects(
      () => tools.list_cards.execute({ limit: 0 }, exec),
      /limit 必须是正整数/,
    )
    await assert.rejects(
      () => tools.list_cards.execute({ offset: -1 }, exec),
      /offset 必须是非负整数/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('建卡按调用方会话归属项目，归属由宿主判定而非模型传参', async () => {
  const { home, tools } = await createTools(async () => ({ id: 'p1', name: '项目一', directory: '/repo' }))
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    assert.equal(created.card.projectId, 'p1')
    assert.equal(created.card.createdBy, 'session-1')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('会话不归属任何项目时，卡片没有归属', async () => {
  const { home, tools } = await createTools(async () => undefined)
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    assert.equal(created.card.projectId, undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('查卡默认只列本项目的卡，scope=all 才跨项目', async () => {
  const { home, tools } = await createTools(async () => ({ id: 'p1', name: '项目一', directory: '/repo' }))
  try {
    await tools.create_card.execute({ title: '本项目的卡' }, exec)
    // 另一个项目的卡直接写进存储：归属是建卡时定下的，不会被后来的调用改写
    const store = createCardStore({ home })
    await store.create({ title: '别的项目的卡', projectId: 'p2' })
    const listed = await tools.list_cards.execute({}, exec)
    assert.equal(listed.cards.length, 1)
    assert.equal(listed.cards[0].title, '本项目的卡')
    const all = await tools.list_cards.execute({ scope: 'all' }, exec)
    assert.equal(all.cards.length, 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('跨项目改卡被拒绝', async () => {
  const { home, tools } = await createTools(async () => ({ id: 'p1', name: '项目一', directory: '/repo' }))
  try {
    const store = createCardStore({ home })
    const other = await store.create({ title: '别的项目的卡', projectId: 'p2' })
    await assert.rejects(
      () => tools.update_card.execute({ id: other.id, title: '改它' }, exec),
      /属于另一个项目/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('无归属的存量卡仍可改：没有归属可冲突', async () => {
  const { home, tools } = await createTools(async () => ({ id: 'p1', name: '项目一', directory: '/repo' }))
  try {
    const store = createCardStore({ home })
    const legacy = await store.create({ title: '存量卡' })
    const updated = await tools.update_card.execute({ id: legacy.id, title: '改过了' }, exec)
    assert.equal(updated.card.title, '改过了')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('项目外的会话改不了有归属的卡', async () => {
  const { home, tools } = await createTools(async () => undefined)
  try {
    const store = createCardStore({ home })
    const owned = await store.create({ title: '某个项目的卡', projectId: 'p1' })
    await assert.rejects(
      () => tools.update_card.execute({ id: owned.id, title: '改它' }, exec),
      /属于另一个项目/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
