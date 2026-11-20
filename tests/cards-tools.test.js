import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCardStore } from '../src/host/cards/store.js'
import { createBundleTools } from '../src/host/index.js'
import { SPEC_PAGE_CHARS } from '../src/host/cards/card-list-view.js'
import {
  createCreateCardTool,
  createUpdateCardTool,
  createListCardsTool,
  createReadCardTool,
} from '../src/host/tools/cards.js'

/**
 * 建一组卡片工具与它们共用的存储。
 * @param {(sessionId: string | undefined) => Promise<object | undefined>} [resolveProject] -
 *   解析调用方会话所属项目；不传则卡片没有归属
 * @param {(sessionId: string | undefined) => boolean} [canWrite] - 写卡身份判定；不传则放行
 * @param {object} [options] - worker 判定与卡片绑定
 * @param {(sessionId: string | undefined) => boolean} [options.isWorkerSession] - worker 判定
 * @param {(sessionId: string) => Promise<object[]>} [options.cardBindingsOf] - 会话的卡片绑定
 * @returns {Promise<{ home: string, store: object, tools: Record<string, object> }>} 工具集、存储与 home 目录
 */
async function createTools(resolveProject, canWrite, { isWorkerSession, cardBindingsOf, logger } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-cardtools-'))
  // 可控时钟：卡片排序按更新时间戳，两次写入落在同一毫秒会退回插入序，
  // 断言「最近更新的排前面」就成了碰运气的 flaky 用例。
  let tick = 0
  const store = createCardStore({ home, clock: () => Date.now() + (tick += 1) })
  return {
    home,
    store,
    tools: {
      create_card: createCreateCardTool({ store, resolveProject, canWrite, logger }),
      update_card: createUpdateCardTool({ store, resolveProject, canWrite, isWorkerSession, cardBindingsOf, logger }),
      list_cards: createListCardsTool({ store, resolveProject }),
      read_card: createReadCardTool({ store, resolveProject, isWorkerSession, cardBindingsOf }),
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

test('改卡工具用 addLinks 追加链接，不覆盖已有条目', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute(
      { title: '任务', links: [{ label: 'Issue', url: 'https://example.test/1' }] },
      exec,
    )
    const updated = await tools.update_card.execute(
      { id: created.card.id, addLinks: [{ label: 'PR', url: 'https://example.test/pr/2' }] },
      exec,
    )
    assert.deepEqual(updated.card.links.map((link) => link.label), ['Issue', 'PR'])
    assert.equal(updated.card.revision, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('改卡工具重复 addLinks 同一条链接不会长出重复条目', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    const link = { label: 'PR', url: 'https://example.test/pr/2' }
    await tools.update_card.execute({ id: created.card.id, addLinks: [link] }, exec)
    const again = await tools.update_card.execute({ id: created.card.id, addLinks: [link] }, exec)
    // 工具层不能给增量追加补 id：补了每次都算新条目，去重永远不生效。
    assert.equal(again.card.links.length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('addLinks 与整体替换共用 URL 归一化，且不补 id', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    const updated = await tools.update_card.execute(
      { id: created.card.id, addLinks: [{ label: '单斜杠', url: 'https:/example.com' }] },
      exec,
    )
    // 归一化在落盘前做：增量路径不能绕过 #53 的写入边界。
    assert.equal(updated.card.links[0].url, 'https://example.com/')
    // 不补 id 是增量路径的语义：store 靠 label+url 判重。
    assert.equal('id' in updated.card.links[0], false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('addLinks 的非法 URL 与整体替换同口径拒绝', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    await assert.rejects(
      () => tools.update_card.execute(
        { id: created.card.id, addLinks: [{ label: '本地文件', url: 'docs/report.md' }] },
        exec,
      ),
      /第 1 条.*http\(s\) 绝对地址/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('改卡工具拒绝同次传 links 与 addLinks', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    await assert.rejects(
      () => tools.update_card.execute(
        {
          id: created.card.id,
          links: [{ label: 'PR', url: 'https://example.test/pr/2' }],
          addLinks: [{ label: 'Issue' }],
        },
        exec,
      ),
      /不能同时传/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('改卡工具拒绝缺标签的 addLinks 条目', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    await assert.rejects(
      () => tools.update_card.execute({ id: created.card.id, addLinks: [{ url: 'https://example.test' }] }, exec),
      /label/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('改卡工具拒绝关闭卡片的同时绑定槽位', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    await assert.rejects(
      () => tools.update_card.execute(
        { id: created.card.id, status: 'done', slots: { dev: { sessionId: 'worker-1' } } },
        exec,
      ),
      /会释放槽位上的执行者/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('改卡工具关闭卡片时释放原有槽位', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute(
      { title: '任务', slots: { dev: { sessionId: 'worker-1' } } },
      exec,
    )
    const done = await tools.update_card.execute({ id: created.card.id, status: 'done' }, exec)
    assert.deepEqual(done.card.slots, {})
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('改卡工具的入参 schema 暴露 addLinks，模型才用得到', async () => {
  const { home, tools } = await createTools()
  try {
    assert.equal(tools.update_card.parameters.properties.addLinks.type, 'array')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('卡片工具的链接描述只放交付物入口，不挂评论与行内评论锚点', async () => {
  const { home, tools } = await createTools()
  try {
    for (const description of [
      tools.update_card.parameters.properties.addLinks.description,
      tools.update_card.parameters.properties.links.description,
      tools.create_card.parameters.properties.links.description,
    ]) {
      assert.match(description, /交付物入口/)
      assert.match(description, /#issuecomment-/)
      assert.match(description, /#discussion_r/)
      assert.match(description, /#pullrequestreview-/)
      assert.match(description, /过程证据.*回报正文/)
      assert.doesNotMatch(description, /spec/)
    }
    assert.match(tools.update_card.parameters.properties.links.description, /行内评论/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('评论锚点写入只告警不阻断，普通交付物链接不告警', async () => {
  const messages = []
  const { home, tools } = await createTools(undefined, undefined, {
    logger: (message) => messages.push(message),
  })
  try {
    const created = await tools.create_card.execute({
      title: '审查',
      links: [{
        label: '审查评论',
        url: 'https://github.com/o/r/pull/1#issuecomment-123',
      }],
    }, exec)
    assert.equal(created.card.number, 1)
    assert.equal(messages.length, 1)
    assert.match(messages[0], /卡片 #1 的 links 含评论锚点/)
    assert.match(messages[0], /回报正文/)

    const updated = await tools.update_card.execute({
      id: created.card.id,
      addLinks: [{
        label: '讨论',
        url: 'https://github.com/o/r/pull/1#discussion_r456',
      }],
    }, exec)
    assert.equal(updated.card.number, 1)
    assert.equal(messages.length, 2)
    assert.match(messages[1], /卡片 #1 的 addLinks 含评论锚点/)

    await tools.update_card.execute({
      id: created.card.id,
      links: [{
        label: 'Review',
        url: 'https://github.com/o/r/pull/1#pullrequestreview-789',
      }],
    }, exec)
    assert.equal(messages.length, 3)
    assert.match(messages[2], /卡片 #1 的 links 含评论锚点/)

    await tools.update_card.execute({
      id: created.card.id,
      links: [{ label: 'PR', url: 'https://github.com/o/r/pull/1' }],
    }, exec)
    assert.equal(messages.length, 3, '普通交付物入口不产生告警')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('logger 抛错时评论锚点写入仍成功', async () => {
  const { home, tools } = await createTools(undefined, undefined, {
    logger: () => { throw new Error('logger boom') },
  })
  try {
    const created = await tools.create_card.execute({
      title: '审查',
      links: [{
        label: '审查评论',
        url: 'https://github.com/o/r/pull/1#issuecomment-123',
      }],
    }, exec)
    assert.equal(created.card.number, 1)

    const updated = await tools.update_card.execute({
      id: created.card.id,
      addLinks: [{
        label: '讨论',
        url: 'https://github.com/o/r/pull/1#discussion_r456',
      }],
    }, exec)
    assert.equal(updated.card.number, 1)
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
    // 最近更新的排前面：leader 关心的是正在动的卡
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
    assert.equal(single.kind, 'dsh-leader-agent-cards')
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

test('建卡工具拒绝缺 label 的链接条目，报错说清是哪一条、带了什么 url', async () => {
  const { home, tools } = await createTools()
  try {
    await assert.rejects(
      () => tools.create_card.execute({ title: '任务', links: [{ url: 'https://example.test/mr/1' }] }, exec),
      (error) => {
        assert.match(error.message, /links 第 1 条缺 label/)
        // 模型要能照着改：告诉它这一条其实带了 url、以及规则是什么
        assert.match(error.message, /https:\/\/example\.test\/mr\/1/)
        assert.match(error.message, /每条链接都要有非空 label/)
        return true
      },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('建卡与改卡工具拒绝非 http(s) 的 url，并告知是第几条、哪个标签、怎么改', async () => {
  const { home, tools } = await createTools()
  try {
    for (const url of ['javascript:alert(1)', 'ftp://example.test/mr/1', 'docs/report.md', 'example.test/mr/1']) {
      await assert.rejects(
        () => tools.create_card.execute({
          title: '任务',
          links: [{ label: 'MR', url: 'https://example.test/mr/1' }, { label: 'Issue', url }],
        }, exec),
        (error) => {
          assert.match(error.message, /links 第 2 条/)
          assert.match(error.message, /label「Issue」/)
          assert.match(error.message, /http\(s\) 绝对地址/)
          assert.match(error.message, /https:\/\/…/)
          return true
        },
      )
    }

    const created = await tools.create_card.execute({ title: '任务' }, exec)
    await assert.rejects(
      () => tools.update_card.execute({
        id: created.card.id,
        links: [{ label: '危险', url: 'javascript:alert(1)' }],
      }, exec),
      /label「危险」[\s\S]*http\(s\) 绝对地址/,
    )
    // 被拒的写入不能落盘
    const listed = await tools.list_cards.execute({ cardId: created.card.id }, exec)
    assert.equal(listed.cards[0].links, undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('链接字段 trim 后落盘，空 url / purpose 不落空串，重复 id 被换成新 id', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute({
      title: '任务',
      links: [
        { id: 'same', label: ' MR ', url: ' https://example.test/mr/1 ', purpose: ' 交付 ' },
        { id: 'same', label: 'Issue', url: '   ', purpose: '  ' },
      ],
    }, exec)

    const [first, second] = created.card.links
    assert.equal(first.id, 'same')
    assert.equal(first.label, 'MR')
    assert.equal(first.url, 'https://example.test/mr/1')
    assert.equal(first.purpose, '交付')
    assert.notEqual(second.id, 'same')
    assert.equal(second.label, 'Issue')
    assert.equal('url' in second, false)
    assert.equal('purpose' in second, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('工具写入边界把非规范 http(s) 地址归一化后落盘', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute({
      title: '任务',
      links: [
        { label: '简写', url: 'http:example.test/mr/1' },
        { label: '单斜杠', url: 'https:/example.test/mr/2' },
        { label: '换行', url: 'https://exa\nmple.test/mr/3' },
      ],
    }, exec)

    assert.deepEqual(
      created.card.links.map(({ label, url }) => ({ label, url })),
      [
        { label: '简写', url: 'http://example.test/mr/1' },
        { label: '单斜杠', url: 'https://example.test/mr/2' },
        { label: '换行', url: 'https://example.test/mr/3' },
      ],
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

test('建卡与改卡工具接受 ASCII 槽位名', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await tools.create_card.execute(
      { title: '任务', slots: { dev: { sessionId: 's1' } } },
      exec,
    )
    assert.deepEqual(Object.keys(created.card.slots), ['dev'])
    const updated = await tools.update_card.execute(
      { id: created.card.id, slots: { dev: { sessionId: 's1' }, review: { sessionId: 's2' } } },
      exec,
    )
    assert.deepEqual(Object.keys(updated.card.slots), ['dev', 'review'])
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
        { id: created.card.id, slots: { 开发: { sessionId: 's1' } } },
        exec,
      ),
      /槽位名 "开发" 不合法/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

/**
 * 宿主 rc.2 的 JSON Schema 执行子集（`packages/core/tools/src/json-schema.ts` 的
 * `CONSTRAINT_KEYWORDS` / `ANNOTATION_KEYWORDS`）。不在这个集合里的关键字会被
 * `assertSupportedJsonSchema` 判 `UNSUPPORTED_SCHEMA`，而 `tools.register` 对
 * `output.schema` 就跑这一条断言——写了不是「不生效」，是注册直接失败。
 */
const HOST_SCHEMA_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
])

/**
 * 收集 schema 树里超出宿主执行子集的地方。
 * @param {unknown} node - schema 节点
 * @param {string} path - 断言里的出错路径
 * @param {string[]} violations - 违规列表
 */
function collectSchemaViolations(node, path, violations) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(`${path} 不是 schema 对象`)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (!HOST_SCHEMA_KEYWORDS.has(key)) {
      violations.push(`${path}.${key} 不在宿主支持的关键字里`)
      continue
    }
    if (key === 'properties') {
      for (const [name, child] of Object.entries(value)) collectSchemaViolations(child, `${path}.properties.${name}`, violations)
    }
    if (key === 'items') collectSchemaViolations(value, `${path}.items`, violations)
    if (key === 'oneOf') value.forEach((child, index) => collectSchemaViolations(child, `${path}.oneOf[${index}]`, violations))
    if (key === 'additionalProperties' && typeof value !== 'boolean') {
      violations.push(`${path}.additionalProperties 必须是布尔`)
    }
  }
}

test('卡片工具的 schema 只用宿主执行子集里的关键字', async () => {
  const { home, tools } = await createTools()
  try {
    for (const tool of [tools.create_card, tools.update_card, tools.list_cards, tools.read_card]) {
      const violations = []
      collectSchemaViolations(tool.parameters, `${tool.name}.parameters`, violations)
      collectSchemaViolations(tool.output.schema, `${tool.name}.output`, violations)
      assert.deepEqual(violations, [])
    }
    // 槽位名是 map 键，子集表达不了键级约束；名字合法性只在 normalizeSlots 执行。
    for (const tool of [tools.create_card, tools.update_card]) {
      const slots = tool.parameters.properties.slots
      assert.match(slots.description, /小写 ASCII 机器标识/)
      assert.equal(slots.additionalProperties, true)
      assert.equal(Object.hasOwn(slots, 'propertyNames'), false)
    }
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

test('退役 leader 不能跨项目查卡：scope=all 与单卡 cardId 两条路径都被拒', async () => {
  // 退役会话按 cwd 仍解析到项目；摘要里的退役集合就是判据。
  const project = {
    id: 'p1',
    name: '项目一',
    directory: '/repo',
    leaderSessionId: 'session-new',
    retiredLeaderSessionIds: ['session-1'],
  }
  const { home, tools } = await createTools(async () => project)
  try {
    await tools.create_card.execute({ title: '本项目的卡' }, exec)
    const store = createCardStore({ home })
    const other = await store.create({ title: '别的项目的卡', projectId: 'p2' })

    // 本项目范围照旧可读：它与同目录的普通会话同档
    const listed = await tools.list_cards.execute({}, exec)
    assert.deepEqual(listed.cards.map((card) => card.title), ['本项目的卡'])

    await assert.rejects(
      () => tools.list_cards.execute({ scope: 'all' }, exec),
      /不再有跨项目查询权限/,
    )
    // 单卡查询是跨项目寻址（工具在解析归属前就读了全库），同样收口
    await assert.rejects(
      () => tools.list_cards.execute({ cardId: other.id }, exec),
      /不再有跨项目查询权限/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('当前 leader 的跨项目查卡不受影响', async () => {
  const project = {
    id: 'p1',
    name: '项目一',
    directory: '/repo',
    leaderSessionId: 'session-1',
    retiredLeaderSessionIds: ['session-old'],
  }
  const { home, tools } = await createTools(async () => project)
  try {
    await tools.create_card.execute({ title: '本项目的卡' }, exec)
    const store = createCardStore({ home })
    const other = await store.create({ title: '别的项目的卡', projectId: 'p2' })

    const all = await tools.list_cards.execute({ scope: 'all' }, exec)
    assert.equal(all.cards.length, 2)
    const single = await tools.list_cards.execute({ cardId: other.id }, exec)
    assert.match(tools.list_cards.output.render({}, single)[0].text, /别的项目的卡/)
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

test('普通会话不能写卡：建卡与改卡都被身份闸拒绝，且不落盘', async () => {
  // 工具面在 agent/created 裁，换 leader 不重建旧会话——退役者手里仍有写入工具，
  // 所以执行时再判一次身份。
  const { home, tools } = await createTools(async () => undefined, () => false)
  try {
    const store = createCardStore({ home })
    const existing = await store.create({ title: 'leader 建的卡' })

    await assert.rejects(
      () => tools.create_card.execute({ title: '普通会话的卡' }, exec),
      /只有 leader 与 worker 能写卡/,
    )
    await assert.rejects(
      () => tools.update_card.execute({ id: existing.id, title: '改 leader 的卡' }, exec),
      /只有 leader 与 worker 能写卡/,
    )
    // 被拒的写入不能落盘：卡库里仍只有那一张，标题没变
    const cards = await store.list()
    assert.deepEqual(cards.map((card) => card.title), ['leader 建的卡'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('leader 与 worker 都过写卡身份闸', async () => {
  const { home, tools } = await createTools(async () => undefined, (sessionId) => sessionId !== 'plain-1')
  try {
    const created = await tools.create_card.execute({ title: '任务' }, exec)
    assert.equal(created.card.title, '任务')

    // worker 挂产物链接：这是协议层给它的写卡动作（`implementation.md` 的交付一节）
    const worker = { agent: { id: 'worker-1' }, signal: undefined }
    const updated = await tools.update_card.execute(
      { id: created.card.id, addLinks: [{ label: 'PR', url: 'https://example.test/pr/1' }] },
      worker,
    )
    assert.equal(updated.card.links.length, 1)
    assert.equal(updated.card.status, 'active')

    const plain = { agent: { id: 'plain-1' }, signal: undefined }
    await assert.rejects(
      () => tools.create_card.execute({ title: '普通会话的卡' }, plain),
      /只有 leader 与 worker 能写卡/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('身份闸先于入参校验：普通会话传空标题也报身份错误', async () => {
  const { home, tools } = await createTools(async () => undefined, () => false)
  try {
    await assert.rejects(
      () => tools.create_card.execute({ title: '  ' }, exec),
      /只有 leader 与 worker 能写卡/,
    )
    await assert.rejects(
      () => tools.update_card.execute({ id: '' }, exec),
      /只有 leader 与 worker 能写卡/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('createBundleTools 把写卡身份判定透传给卡片工具', async () => {
  // 漏传就是闸静默失效：装配出来的工具看起来正常，写卡不校验身份。
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-cardtools-'))
  try {
    const store = createCardStore({ home })
    const tools = createBundleTools({
      cards: store,
      resolveProject: async () => undefined,
      canWriteCards: (sessionId) => sessionId === 'leader-1',
      isWorkerSession: () => false,
      cardBindingsOf: async () => [],
    })
    const createCard = tools.find((tool) => tool.name === 'create_card')
    const updateCard = tools.find((tool) => tool.name === 'update_card')

    await assert.rejects(
      () => createCard.execute({ title: '普通会话的卡' }, exec),
      /只有 leader 与 worker 能写卡/,
    )
    const created = await createCard.execute(
      { title: 'leader 的卡' },
      { agent: { id: 'leader-1' }, signal: undefined },
    )
    await assert.rejects(
      () => updateCard.execute({ id: created.card.id, status: 'done' }, exec),
      /只有 leader 与 worker 能写卡/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('createBundleTools 传了 cards 却不传写卡判定时直接报错，不留静默放行的装配', () => {
  // 装配漏传时工具面照裁、执行时却对所有会话开放——全量用例都不会红，只有调用
  // 契约本身能拦住。文档门禁走无参调用（没有 cards），不受这条约束。
  assert.throws(
    () => createBundleTools({ cards: {} }),
    /传了 cards 就必须传 canWriteCards/,
  )
})

test('createBundleTools 缺 worker 写卡范围依赖时同样直接报错', () => {
  // 漏传只影响 worker 的写卡范围：身份闸还在，能写卡的 worker 仍能改任意卡。
  assert.throws(
    () => createBundleTools({ cards: {}, canWriteCards: () => true }),
    /必须传 isWorkerSession 与 cardBindingsOf/,
  )
})

test('worker 只能改自己挂着的卡，且不能改槽位、状态、规格与标题', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-cardtools-'))
  try {
    const store = createCardStore({ home })
    const mine = await store.create({ title: '我的卡', slots: { dev: { sessionId: 'worker-1' } } })
    const other = await store.create({ title: '别人的卡', slots: { dev: { sessionId: 'worker-2' } } })
    const updateCard = createUpdateCardTool({
      store,
      canWrite: () => true,
      isWorkerSession: (sessionId) => sessionId === 'worker-1',
      cardBindingsOf: (sessionId) => store.bindingsOf(sessionId),
    })
    const worker = { agent: { id: 'worker-1' }, signal: undefined }

    // 自己的卡：挂产物链接是 worker 的写卡动作
    const linked = await updateCard.execute(
      { id: mine.id, addLinks: [{ label: 'PR', url: 'https://example.test/pr/1' }] },
      worker,
    )
    assert.equal(linked.card.links.length, 1)

    // 标题与 spec 走同一条注入通道：只收 spec 的话，规格语义能从标题塞回来
    await assert.rejects(
      () => updateCard.execute({ id: mine.id, title: '范围：只改文档；验收：不新增依赖' }, worker),
      /worker 不能改卡片标题/,
    )

    // 槽位绑定会换执行者、也能制造「一个会话挂多张 active 卡」的坏状态
    await assert.rejects(
      () => updateCard.execute({ id: mine.id, slots: { dev: { sessionId: 'worker-2' } } }, worker),
      /worker 不能改卡片的槽位绑定/,
    )

    // 同项目里别的 worker 的卡：不在自己的绑定里（用它有权写的字段试探）
    await assert.rejects(
      () => updateCard.execute(
        { id: other.id, addLinks: [{ label: 'PR', url: 'https://example.test/pr/2' }] },
        worker,
      ),
      /只能改自己挂着的卡/,
    )

    // leader 不受范围限制
    const leader = { agent: { id: 'leader-1' }, signal: undefined }
    const byLeader = await updateCard.execute({ id: other.id, title: 'leader 改的' }, leader)
    assert.equal(byLeader.card.title, 'leader 改的')

    // 状态归 leader：关闭会释放执行者、抽走卡片上下文，协议层要求它验收后再关
    for (const status of ['done', 'archived', 'active']) {
      await assert.rejects(
        () => updateCard.execute({ id: mine.id, status }, worker),
        /worker 不能改卡片状态/,
      )
    }
    // 规格归 leader：spec 是验收锚点，worker 往回报与 links 里写
    await assert.rejects(
      () => updateCard.execute({ id: mine.id, spec: 'worker 自己改的验收标准' }, worker),
      /worker 不能改卡片规格/,
    )
    // leader 能关自己的卡、能改规格
    const done = await updateCard.execute(
      { id: mine.id, status: 'done', spec: 'leader 写的验收标准' },
      leader,
    )
    assert.equal(done.card.status, 'done')
    assert.equal(done.card.spec, 'leader 写的验收标准')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('worker 不能建卡：建卡与派工是 leader 的一条动作链', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-cardtools-'))
  try {
    const store = createCardStore({ home })
    const createCard = createCreateCardTool({
      store,
      canWrite: () => true,
      isWorkerSession: (sessionId) => sessionId === 'worker-1',
    })
    const worker = { agent: { id: 'worker-1' }, signal: undefined }
    await assert.rejects(
      () => createCard.execute({ title: 'worker 攒的待办' }, worker),
      /worker 不建卡/,
    )
    // 被拒时不落盘：卡库里没有无主卡
    assert.deepEqual(await store.list(), [])

    const leader = { agent: { id: 'leader-1' }, signal: undefined }
    const created = await createCard.execute({ title: 'leader 的卡' }, leader)
    assert.equal(created.card.title, 'leader 的卡')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('建卡与改卡支持分类：trim 落盘，空串清除，脏值直接拒收', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-cardkind-'))
  try {
    const store = createCardStore({ home })
    const createCard = createCreateCardTool({ store })
    const updateCard = createUpdateCardTool({ store })
    const leader = { agent: { id: 'leader-1' }, signal: undefined }

    const created = await createCard.execute({ title: '任务', kind: '  研发  ' }, leader)
    assert.equal(created.card.kind, '研发')

    // 分类是卡面头部的短标签：超长会被截断、换行会把头部撑成两行，写入前就拒
    await assert.rejects(
      () => createCard.execute({ title: '任务', kind: 'x'.repeat(25) }, leader),
      /kind 最长 24 个字符/,
    )
    await assert.rejects(
      () => createCard.execute({ title: '任务', kind: '研\n发' }, leader),
      /kind 不能换行/,
    )
    await assert.rejects(
      () => createCard.execute({ title: '任务', kind: 42 }, leader),
      /kind 必须是字符串/,
    )

    // 按码点计数：13 个 emoji 是 13 个字符，不是 26 个（`length` 数的是 UTF-16 码元）
    const emojiKind = '😀'.repeat(13)
    const withEmoji = await createCard.execute({ title: '任务', kind: emojiKind }, leader)
    assert.equal(withEmoji.card.kind, emojiKind)
    await assert.rejects(
      () => createCard.execute({ title: '任务', kind: '😀'.repeat(25) }, leader),
      /kind 最长 24 个字符，收到 25 个/,
    )

    // 单行标签的判据要覆盖所有行分隔符：U+2028 / U+2029 / \v / \f / NEL 落盘后
    // 在卡面上不一定换行，但都违背「单行短标签」这条前提。
    for (const separator of ['\u2028', '\u2029', '\v', '\f', '\u0085']) {
      const codePoint = separator.codePointAt(0).toString(16).toUpperCase()
      await assert.rejects(
        () => createCard.execute({ title: '任务', kind: `研${separator}发` }, leader),
        /kind 不能换行/,
        `kind 含 U+${codePoint} 应被拒`,
      )
    }

    const changed = await updateCard.execute({ id: created.card.id, kind: '文档' }, leader)
    assert.equal(changed.card.kind, '文档')

    // 空串是清除，不是「把分类设成空字符串」
    const cleared = await updateCard.execute({ id: created.card.id, kind: '' }, leader)
    assert.equal('kind' in cleared.card, false)
    assert.equal((await store.get(created.card.id)).kind, undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('worker 不能改卡片分类：那是 leader 对任务流的归类', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-cardkind-'))
  try {
    const store = createCardStore({ home })
    const card = await store.create({ title: '任务', kind: '研发' })
    const updateCard = createUpdateCardTool({
      store,
      isWorkerSession: (sessionId) => sessionId === 'worker-1',
    })
    await assert.rejects(
      () => updateCard.execute({ id: card.id, kind: '文档' }, { agent: { id: 'worker-1' } }),
      /worker 不能改卡片分类/,
    )
    // 先判权限再取值：超长 kind 也要报「不能改分类」，而不是让 worker 以为改短就行
    await assert.rejects(
      () => updateCard.execute({ id: card.id, kind: 'x'.repeat(50) }, { agent: { id: 'worker-1' } }),
      /worker 不能改卡片分类/,
    )
    // 被拒时既不落盘，也不递增 revision
    const after = await store.get(card.id)
    assert.equal(after.kind, '研发')
    assert.equal(after.revision, 0)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

/** worker 的假执行上下文。 */
const workerExec = { agent: { id: 'worker-1' }, signal: undefined }

/**
 * 建一张卡。
 * @param {Record<string, object>} tools - 工具集
 * @param {object} [input] - 建卡入参
 * @returns {Promise<object>} 卡片
 */
async function seedCard(tools, input = {}) {
  const result = await tools.create_card.execute({ title: '实现读卡', spec: '验收：能读', ...input }, exec)
  return result.card
}

test('读卡工具传 cardId 返回单卡事实与一整页规格', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await seedCard(tools)
    const result = await tools.read_card.execute({ cardId: created.id }, exec)
    assert.equal(result.card.id, created.id)
    assert.equal(result.card.title, '实现读卡')
    // card.spec 是本页片段，specPage 说明窗口；短规格一次读完。
    assert.deepEqual(result.specPage, { text: '验收：能读', offset: 0, chars: 5, total: 5, hasMore: false })
    assert.equal(result.card.spec, '验收：能读')
    const rendered = tools.read_card.output.render({}, result)
    assert.match(rendered[0].text, /spec:/)
    assert.match(rendered[0].text, /验收：能读/)
    // 读操作不投影：看板的数据源是宿主项目通道，读不产生新事实。
    assert.equal(tools.read_card.output.presentationMeta, undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('读卡工具传 number 读到同一张卡', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await seedCard(tools)
    const result = await tools.read_card.execute({ number: created.number }, exec)
    assert.equal(result.card.id, created.id)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('读卡工具的 cardId 与 number 只能传一个，非法号码与不存在的卡都报错', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await seedCard(tools)
    await assert.rejects(
      () => tools.read_card.execute({ cardId: created.id, number: created.number }, exec),
      /只能传一个/,
    )
    await assert.rejects(
      () => tools.read_card.execute({ number: 1.5 }, exec),
      /number 必须是正整数/,
    )
    await assert.rejects(
      () => tools.read_card.execute({ number: 99 }, exec),
      /没有 #99 这张卡/,
    )
    await assert.rejects(
      () => tools.read_card.execute({ cardId: 'nope' }, exec),
      /卡片不存在/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('读卡工具不能跨项目读卡', async () => {
  let projectId = 'project-a'
  const { home, tools } = await createTools(async () => ({ id: projectId }))
  try {
    const created = await seedCard(tools)
    // 同一个 model 在另一个项目的语境里拿着 cardId 来读：归属对不上就拒绝。
    projectId = 'project-b'
    await assert.rejects(
      () => tools.read_card.execute({ cardId: created.id }, exec),
      /属于另一个项目/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('读卡工具不传卡片时读唯一绑定的卡', async () => {
  const { home, store, tools } = await createTools(undefined, undefined, {
    isWorkerSession: (sessionId) => sessionId === 'worker-1',
    cardBindingsOf: (sessionId) => store.bindingsOf(sessionId),
  })
  try {
    const created = await seedCard(tools, { slots: { dev: { sessionId: 'worker-1' } } })
    // 压缩或注入失效后 worker 可能没有 cardId，这条默认分支是它找回任务的路。
    const result = await tools.read_card.execute({}, workerExec)
    assert.equal(result.card.id, created.id)
    const rendered = tools.read_card.output.render({}, result)
    assert.match(rendered[0].text, /slots: dev=worker-1/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('读卡工具同一张卡挂多个槽位时仍算唯一绑定', async () => {
  const { home, store, tools } = await createTools(undefined, undefined, {
    isWorkerSession: (sessionId) => sessionId === 'worker-1',
    cardBindingsOf: (sessionId) => store.bindingsOf(sessionId),
  })
  try {
    const created = await seedCard(tools, {
      slots: { dev: { sessionId: 'worker-1' }, review: { sessionId: 'worker-1' } },
    })
    // 两个槽位指向同一张卡：绑定有两条，卡只有一张，不算「同时挂多张」。
    assert.equal((await store.bindingsOf('worker-1')).length, 2)
    const result = await tools.read_card.execute({}, workerExec)
    assert.equal(result.card.id, created.id)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('读卡工具没有绑定时报错并指出下一步', async () => {
  const { home, store, tools } = await createTools(undefined, undefined, {
    isWorkerSession: (sessionId) => sessionId === 'worker-1',
    cardBindingsOf: (sessionId) => store.bindingsOf(sessionId),
  })
  try {
    await assert.rejects(
      () => tools.read_card.execute({}, workerExec),
      /没有绑定任何卡/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('读卡工具同时挂多张卡时列出候选而不是替调用方猜', async () => {
  const { home, store, tools } = await createTools(undefined, undefined, {
    isWorkerSession: (sessionId) => sessionId === 'worker-1',
    cardBindingsOf: (sessionId) => store.bindingsOf(sessionId),
  })
  try {
    const dev = await seedCard(tools, { title: '开发', slots: { dev: { sessionId: 'worker-1' } } })
    const review = await seedCard(tools, { title: '评审', slots: { review: { sessionId: 'worker-1' } } })
    await assert.rejects(
      () => tools.read_card.execute({}, workerExec),
      (error) => {
        assert.match(error.message, /同时挂着 2 张卡/)
        // 候选里要带上 cardId，模型才能直接补参重试。
        assert.ok(error.message.includes(dev.id))
        assert.ok(error.message.includes(review.id))
        return true
      },
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('读卡工具的绑定指向不存在的卡时报错，不静默返回空', async () => {
  const { home, tools } = await createTools(undefined, undefined, {
    isWorkerSession: () => true,
    cardBindingsOf: async () => [{ cardId: 'ghost', number: 9, slot: 'dev', title: '幽灵', status: 'active' }],
  })
  try {
    await assert.rejects(
      () => tools.read_card.execute({}, workerExec),
      /指向的卡已不存在/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('读卡工具缺绑定索引或会话 id 时要求显式传卡片', async () => {
  const { home, store, tools } = await createTools()
  try {
    // 文档门禁路径不传 cardBindingsOf；执行到这里说明调用方漏了装配。
    await assert.rejects(
      () => tools.read_card.execute({}, exec),
      /缺少会话的卡片绑定索引/,
    )
    const read = createReadCardTool({
      store,
      cardBindingsOf: (sessionId) => store.bindingsOf(sessionId),
    })
    await assert.rejects(
      () => read.execute({}, { agent: {} }),
      /会话 id 不可用/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('读卡工具只给 worker：其他角色调用被拒', async () => {
  const { home, tools } = await createTools(undefined, undefined, {
    isWorkerSession: () => false,
  })
  try {
    await assert.rejects(
      () => tools.read_card.execute({ cardId: 'whatever' }, exec),
      /只有 worker 能读卡/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('worker 能读本项目里不属于自己的卡', async () => {
  let projectId = 'project-a'
  const { home, store, tools } = await createTools(async () => ({ id: projectId }), undefined, {
    isWorkerSession: (sessionId) => sessionId === 'worker-1',
    cardBindingsOf: (sessionId) => store.bindingsOf(sessionId),
  })
  try {
    const mine = await seedCard(tools, { title: '我的卡', slots: { dev: { sessionId: 'worker-1' } } })
    const other = await seedCard(tools, { title: '别人的卡' })
    // 两张卡都归属 project-a：正向路径是「同一项目里读别人的卡」，不是无归属放行。
    assert.equal(mine.projectId, 'project-a')
    assert.equal(other.projectId, 'project-a')
    // 读放开、写收窄：看得到依赖卡，但 update_card 仍只能改自己绑定的那张。
    const result = await tools.read_card.execute({ cardId: other.id }, workerExec)
    assert.equal(result.card.id, other.id)
    await assert.rejects(
      () => tools.update_card.execute({ id: other.id, addLinks: [{ label: 'MR' }] }, workerExec),
      /只能改自己挂着的卡/,
    )
    // 切到另一个项目：同一张卡立刻不可读，证明放行来自项目归属相同。
    projectId = 'project-b'
    await assert.rejects(
      () => tools.read_card.execute({ cardId: other.id }, workerExec),
      /属于另一个项目/,
    )
    assert.equal((await store.get(mine.id)).title, '我的卡')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('读卡工具按页给规格，specOffset 能续读到全文', async () => {
  const { home, tools } = await createTools()
  try {
    const spec = '甲'.repeat(SPEC_PAGE_CHARS * 2 + 500)
    const created = await seedCard(tools, { spec })
    const first = await tools.read_card.execute({ cardId: created.id }, exec)
    assert.deepEqual(
      { offset: first.specPage.offset, chars: first.specPage.chars, total: first.specPage.total, hasMore: first.specPage.hasMore, nextOffset: first.specPage.nextOffset },
      { offset: 0, chars: SPEC_PAGE_CHARS, total: SPEC_PAGE_CHARS * 2 + 500, hasMore: true, nextOffset: SPEC_PAGE_CHARS },
    )
    const second = await tools.read_card.execute({ cardId: created.id, specOffset: first.specPage.nextOffset }, exec)
    const third = await tools.read_card.execute({ cardId: created.id, specOffset: second.specPage.nextOffset }, exec)
    assert.equal(third.specPage.hasMore, false)
    // 读完的页不再带 nextOffset：输出要过宿主的无损 JSON 校验，undefined 键会被判非法。
    assert.equal(Object.hasOwn(third.specPage, 'nextOffset'), false)
    assert.equal([first.card.spec, second.card.spec, third.card.spec].join(''), spec)
    const rendered = tools.read_card.output.render({}, second)
    assert.match(rendered[0].text, /用 specOffset=4000 继续读/)
    const done = tools.read_card.output.render({}, third)
    assert.match(done[0].text, /spec 已读完/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('规格分页按码点切，不切坏 emoji，越界直接报错', async () => {
  const { home, tools } = await createTools()
  try {
    const spec = '😀'.repeat(SPEC_PAGE_CHARS + 500)
    const created = await seedCard(tools, { spec })
    const first = await tools.read_card.execute({ cardId: created.id }, exec)
    const second = await tools.read_card.execute({ cardId: created.id, specOffset: first.specPage.nextOffset }, exec)
    // 按码点：每页的 chars 与 [...text].length 一致，代理对不会被切开。
    assert.equal([...first.card.spec].length, SPEC_PAGE_CHARS)
    assert.equal([...second.card.spec].length, 500)
    assert.equal(first.card.spec + second.card.spec, spec)
    await assert.rejects(
      () => tools.read_card.execute({ cardId: created.id, specOffset: SPEC_PAGE_CHARS + 500 }, exec),
      /specOffset 超出范围/,
    )
    await assert.rejects(
      () => tools.read_card.execute({ cardId: created.id, specOffset: -1 }, exec),
      /specOffset 必须是非负整数/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('没有规格的卡返回空页，非零 offset 越界', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await seedCard(tools, { spec: undefined })
    const result = await tools.read_card.execute({ cardId: created.id }, exec)
    assert.deepEqual(result.specPage, { text: '', offset: 0, chars: 0, total: 0, hasMore: false })
    assert.match(tools.read_card.output.render({}, result)[0].text, /spec: 无/)
    await assert.rejects(
      () => tools.read_card.execute({ cardId: created.id, specOffset: 1 }, exec),
      /offset 只能是 0/,
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('读卡视图渲染链接与归档终态', async () => {
  const { home, tools } = await createTools()
  try {
    const created = await seedCard(tools, {
      links: [{ label: 'MR', url: 'https://example.com/mr/1', purpose: '实现' }],
    })
    await tools.update_card.execute({ id: created.id, status: 'archived' }, exec)
    const result = await tools.read_card.execute({ cardId: created.id }, exec)
    const text = tools.read_card.output.render({}, result)[0].text
    assert.match(text, /已归档/)
    assert.match(text, /links:/)
    assert.match(text, /https:\/\/example\.com\/mr\/1/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('worker 不能改卡片排序：排序是 leader 对看板的组织动作', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-cardsort-'))
  try {
    const store = createCardStore({ home })
    const card = await store.create({ title: '任务', slots: { dev: { sessionId: 'worker-1' } } })
    const updateCard = createUpdateCardTool({
      store,
      isWorkerSession: (sessionId) => sessionId === 'worker-1',
      cardBindingsOf: (sessionId) => store.bindingsOf(sessionId),
    })
    await assert.rejects(
      () => updateCard.execute({ id: card.id, sortOrder: 1 }, { agent: { id: 'worker-1' } }),
      /worker 不能改卡片排序/,
    )
    assert.equal((await store.get(card.id)).sortOrder, undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('查卡结果带槽位会话的活性附注，只算本次返回的卡上的会话', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-cardtools-'))
  try {
    const store = createCardStore({ home })
    const card = await store.create({ title: '实现派工', slots: { dev: { sessionId: 's1' } } })
    await store.create({ title: '没有槽位' })
    // 附注按真实当前时刻算相对时长；按固定毫秒基准会读成几十万小时。
    const now = Date.now()
    const tool = createListCardsTool({
      store,
      workerFacts: async () => new Map([
        ['s1', { lastReportAt: now - 3 * 60_000, runningSince: now - 22 * 60_000 }],
        // 不在本次返回的卡上：不能混进输出。
        ['s9', { lastReportAt: now - 1_000 }],
      ]),
    })
    const listed = await tool.execute({}, exec)
    assert.equal(listed.slotNotes.s1, '最后回报 3 分钟前 · 已连续 22 分钟')
    assert.equal(Object.hasOwn(listed.slotNotes, 's9'), false)
    const rendered = tool.output.render({}, listed)[0].text
    assert.match(rendered, new RegExp(`dev=s1（最后回报 3 分钟前 · 已连续 22 分钟）`))

    // 没有活性事实时不加这个键：空对象没有意义，也过不了 lossless 判定的直觉。
    const plain = createListCardsTool({ store, workerFacts: async () => new Map() })
    const noNotes = await plain.execute({}, exec)
    assert.equal(Object.hasOwn(noNotes, 'slotNotes'), false)
    assert.match(plain.output.render({}, noNotes)[0].text, new RegExp(`dev=s1\\b`))

    // 没接活性提供方时与从前一致，没有这个字段。
    const legacy = await createListCardsTool({ store }).execute({}, exec)
    assert.equal(Object.hasOwn(legacy, 'slotNotes'), false)
    assert.equal(card.slots.dev.sessionId, 's1')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
