import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_CHARS,
  LIST_MAX_LIMIT,
  parseListQuery,
  renderCardList,
  selectCards,
} from '../src/host/cards/card-list-view.js'

/**
 * 造一张卡片。
 * @param {object} [overrides] - 覆盖字段
 * @returns {object} 卡片
 */
function card(overrides = {}) {
  return {
    id: 'card-1',
    number: 1,
    revision: 0,
    title: '任务',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

/**
 * 默认查询条件。
 * @param {object} [overrides] - 覆盖字段
 * @returns {object} 查询条件
 */
function query(overrides = {}) {
  return { cardId: undefined, status: 'active', scope: 'project', limit: LIST_DEFAULT_LIMIT, offset: 0, ...overrides }
}

test('解析参数：缺省取默认值，非法值直接报错', () => {
  // 不带 cardId 时不留这个键：工具返回值要过宿主的 lossless JSON 校验
  assert.deepEqual(parseListQuery({}), {
    status: 'active',
    scope: 'project',
    limit: LIST_DEFAULT_LIMIT,
    offset: 0,
  })
  assert.deepEqual(parseListQuery({ cardId: 'card-1' }), {
    cardId: 'card-1',
    status: 'active',
    scope: 'project',
    limit: LIST_DEFAULT_LIMIT,
    offset: 0,
  })
  assert.equal(parseListQuery({ status: 'all' }).status, 'all')
  assert.equal(parseListQuery({ scope: 'all' }).scope, 'all')
  assert.throws(() => parseListQuery({ scope: 'projectt' }), /scope 非法/)
  assert.equal(parseListQuery({ limit: 5 }).limit, 5)
  assert.throws(() => parseListQuery({ status: 'archivedd' }), /status 非法/)
  assert.throws(() => parseListQuery({ limit: 0 }), /limit 必须是正整数/)
  assert.throws(() => parseListQuery({ limit: 1.5 }), /limit 必须是正整数/)
  assert.throws(() => parseListQuery({ offset: -1 }), /offset 必须是非负整数/)
  assert.throws(() => parseListQuery({ cardId: '' }), /cardId 必须是非空字符串/)
})

test('解析参数：单页张数按上限收敛', () => {
  assert.equal(parseListQuery({ limit: 1000 }).limit, LIST_MAX_LIMIT)
})

test('选择卡片：默认只列 active，计数是全量口径', () => {
  const cards = [
    card({ id: 'a', status: 'active' }),
    card({ id: 'b', status: 'done' }),
    card({ id: 'c', status: 'archived' }),
  ]
  const result = selectCards(cards, query())
  assert.deepEqual(result.page.map((item) => item.id), ['a'])
  assert.equal(result.total, 1)
  assert.deepEqual(result.counts, { active: 1, done: 1, archived: 1 })
})

test('选择卡片：按最近更新倒序，翻页从 offset 起', () => {
  const cards = [
    card({ id: 'a', updatedAt: 10 }),
    card({ id: 'b', updatedAt: 30 }),
    card({ id: 'c', updatedAt: 20 }),
  ]
  const result = selectCards(cards, query({ status: 'all', limit: 2, offset: 1 }))
  assert.deepEqual(result.page.map((item) => item.id), ['c', 'a'])
  assert.equal(result.total, 3)
})

test('选择卡片：单卡查询忽略分页', () => {
  const cards = [card({ id: 'a' }), card({ id: 'b' })]
  const result = selectCards(cards, query({ cardId: 'b', limit: 1, offset: 5 }))
  assert.deepEqual(result.page.map((item) => item.id), ['b'])
})

test('列表视图：规格与链接无论有无都显式成行', () => {
  const rendered = renderCardList([card()], query())
  assert.match(rendered, /spec: 无/)
  assert.match(rendered, /links: 无/)
})

test('列表视图：链接只给标签，地址留给单卡查询', () => {
  const cards = [card({ links: [{ id: 'l1', label: 'PR #4', url: 'https://example.com/4' }] })]
  const listed = renderCardList(cards, query())
  assert.match(listed, /links: PR #4/)
  assert.doesNotMatch(listed, /https:\/\/example\.com/)
  const detail = renderCardList(cards, query({ cardId: 'card-1' }))
  assert.match(detail, /- PR #4: https:\/\/example\.com\/4/)
})

test('列表视图：规格全文只在单卡查询出现', () => {
  const cards = [card({ spec: '验收：能派工并回报' })]
  const listed = renderCardList(cards, query())
  assert.match(listed, /spec: 有/)
  assert.doesNotMatch(listed, /验收：能派工并回报/)
  const detail = renderCardList(cards, query({ cardId: 'card-1' }))
  assert.match(detail, /验收：能派工并回报/)
})

test('列表视图：空页与翻过头是两句话', () => {
  const empty = renderCardList([], query())
  assert.match(empty, /项目当前没有 active 卡（active 0 · done 0 · archived 0）/)
  const beyond = renderCardList([card()], query({ offset: 5 }))
  assert.match(beyond, /offset 超出范围：status=active 共 1 张，请从 offset=0 重新翻页。/)
})

test('列表视图：状态尾注报全项目计数', () => {
  const cards = [card(), card({ id: 'b', status: 'done' })]
  const rendered = renderCardList(cards, query())
  assert.match(rendered, /本项目：active 1 · done 1 · archived 0，用 status 参数切换。/)
})

test('列表视图：还有未显示的卡时给续页位置', () => {
  const cards = Array.from({ length: 3 }, (_, index) => card({ id: `c${index}`, number: index + 1 }))
  const rendered = renderCardList(cards, query({ status: 'all', limit: 2 }))
  assert.match(rendered, /还有 1 张未显示（offset=2 继续）。/)
})

test('列表视图：首行不报本页张数，显示数只由尾注说', () => {
  const cards = Array.from({ length: 3 }, (_, index) => card({ id: `c${index}`, number: index + 1 }))
  const rendered = renderCardList(cards, query({ status: 'all', limit: 2 }))
  // 首行按 limit 写「本页 2 张」会与实际渲染张数矛盾：本页张数会被字符预算截断
  assert.match(rendered, /^卡片快照（scope=project，status=all，共 3 张）：/)
  assert.doesNotMatch(rendered, /共 3 张，本页/)
  assert.match(rendered, /本页显示 2 张，还有 1 张未显示/)
})

test('列表视图：超预算按卡截断并给续页位置', () => {
  const cards = Array.from({ length: 20 }, (_, index) => card({
    id: `c${index}`,
    number: index + 1,
    title: '长'.repeat(500),
  }))
  const rendered = renderCardList(cards, query({ status: 'all' }))
  assert.match(rendered, new RegExp(`输出超过 ${LIST_MAX_CHARS} 字符上限`))
  assert.match(rendered, /用 offset=\d+ 继续/)
  // 截断后的显示数只出现在尾注，首行不再与它矛盾
  assert.match(rendered, /^卡片快照（scope=project，status=all，共 20 张）：/)
  assert.match(rendered, /本页显示 \d+\/20 张/)
})

test('列表视图：单卡查询给出完整事实', () => {
  const cards = [card({ slots: { dev: { sessionId: 'session-1' } } })]
  const detail = renderCardList(cards, query({ cardId: 'card-1' }))
  assert.match(detail, /cardId: card-1/)
  assert.match(detail, /slots: dev=session-1/)
  assert.match(renderCardList(cards, query({ cardId: 'nope' })), /卡片不存在/)
})

test('列表视图：单卡查询忽略 status 与分页', () => {
  // 单卡查询要给事实：status 与 offset 同传也不改变结果（否则模型会以为那张卡不存在）
  const cards = [card({ status: 'done' })]
  const rendered = renderCardList(cards, query({ cardId: 'card-1', status: 'active', offset: 5, limit: 1 }))
  assert.match(rendered, /cardId: card-1/)
  assert.match(rendered, /\[done\]/)
})

test('列表视图：分类显式成行，未分类写「无」', () => {
  // 省略这一行会让模型把「没有分类」读成「工具不给分类」，而补分类正是它的下一步动作
  const cards = [card({ kind: '研发' }), card({ id: 'card-2', number: 2 })]
  const rendered = renderCardList(cards, query({ status: 'all' }))
  assert.match(rendered, /kind: 研发/)
  assert.match(rendered, /kind: 无/)
})

test('列表视图：单卡查询同样给出分类', () => {
  const cards = [card({ kind: '文档' })]
  assert.match(renderCardList(cards, query({ cardId: 'card-1' })), /kind: 文档/)
})
