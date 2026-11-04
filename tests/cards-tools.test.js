import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCardStore } from '../src/host/cards/store.js'
import { createBundleTools } from '../src/host/index.js'
import {
  createCreateCardTool,
  createUpdateCardTool,
  createListCardsTool,
} from '../src/host/tools/cards.js'

/**
 * 建一组卡片工具与它们共用的存储。
 * @param {(sessionId: string | undefined) => Promise<object | undefined>} [resolveProject] -
 *   解析调用方会话所属项目；不传则卡片没有归属
 * @param {(sessionId: string | undefined) => boolean} [canWrite] - 写卡身份判定；不传则放行
 * @returns {Promise<{ home: string, tools: Record<string, object> }>} 工具集与 home 目录
 */
async function createTools(resolveProject, canWrite) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-cardtools-'))
  // 可控时钟：卡片排序按更新时间戳，两次写入落在同一毫秒会退回插入序，
  // 断言「最近更新的排前面」就成了碰运气的 flaky 用例。
  let tick = 0
  const store = createCardStore({ home, clock: () => Date.now() + (tick += 1) })
  return {
    home,
    tools: {
      create_card: createCreateCardTool({ store, resolveProject, canWrite }),
      update_card: createUpdateCardTool({ store, resolveProject, canWrite }),
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
    for (const tool of [tools.create_card, tools.update_card, tools.list_cards]) {
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
