import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CARD_CONTEXT_NAME,
  CARD_CONTEXT_ORDER,
  applyCardContext,
  renderCardContext,
} from '../src/host/cards/card-context.js'
import { ROLE_CONTEXT_ORDER } from '../src/host/slots/index.js'

/**
 * 建一个假的服务上下文，捕获注册进来的运行时上下文。
 * @returns {{ ctx: object, holder: { registered: object | undefined } }} 上下文与注册项持有者
 */
function createFakeCtx() {
  const holder = { registered: undefined }
  const ctx = {
    systemPrompt: {
      context(definition) {
        holder.registered = definition
        return () => {}
      },
    },
    effect(fn) {
      fn()
      return () => {}
    },
  }
  return { ctx, holder }
}

/**
 * 造一条挂卡事实（索引里的条目形状）。
 * @param {object} [overrides] - 覆盖字段
 * @returns {object} 绑定
 */
function binding(overrides = {}) {
  return {
    cardId: 'card-1',
    number: 12,
    title: '实现登录态续期',
    status: 'active',
    slot: 'dev',
    revision: 3,
    spec: '目标：会话过期后自动续期。\n验收：401 时不丢草稿。',
    links: [{ label: 'Issue', url: 'https://example.test/issues/1', purpose: '需求来源' }],
    ...overrides,
  }
}

test('注册为运行时上下文，排在角色槽位之后', () => {
  const { ctx, holder } = createFakeCtx()
  applyCardContext({ ctx, cardIndex: new Map() })
  assert.equal(holder.registered.name, CARD_CONTEXT_NAME)
  assert.equal(holder.registered.order, CARD_CONTEXT_ORDER)
  assert.ok(CARD_CONTEXT_ORDER > ROLE_CONTEXT_ORDER)
  assert.equal(holder.registered.required, true)
  assert.equal(holder.registered.interpolate, false)
})

test('没有会话或没有挂卡时返回空串', () => {
  const cardIndex = new Map([['session-a', [binding()]]])
  assert.equal(renderCardContext({ sessionId: undefined, cardIndex }), '')
  assert.equal(renderCardContext({ sessionId: '', cardIndex }), '')
  assert.equal(renderCardContext({ sessionId: 'session-other', cardIndex }), '')
})

test('渲染编号、标题、卡 id、revision、槽位、状态、规格与链接', () => {
  const text = renderCardContext({
    sessionId: 'session-a',
    cardIndex: new Map([['session-a', [binding()]]]),
  })
  assert.match(text, /## 当前任务卡/)
  assert.match(text, /#12 实现登录态续期/)
  assert.match(text, /cardId: card-1/)
  assert.match(text, /revision: 3/)
  assert.match(text, /槽位 dev/)
  assert.match(text, /状态 active/)
  assert.match(text, /### 规格/)
  assert.match(text, /验收：401 时不丢草稿。/)
  assert.match(text, /Issue：https:\/\/example\.test\/issues\/1（需求来源）/)
  assert.match(text, /addLinks/)
})

test('规格为空时省略规格节', () => {
  const text = renderCardContext({
    sessionId: 'session-a',
    cardIndex: new Map([['session-a', [binding({ spec: '' })]]]),
  })
  assert.doesNotMatch(text, /### 规格/)
})

test('链接没有 url 时只渲染标签', () => {
  const text = renderCardContext({
    sessionId: 'session-a',
    cardIndex: new Map([['session-a', [binding({ links: [{ label: '设计稿' }] })]]]),
  })
  assert.match(text, /- 设计稿\n/)
})

test('一个会话挂多张卡时全部渲染，并提示先确认服务哪一张', () => {
  const text = renderCardContext({
    sessionId: 'session-a',
    cardIndex: new Map([['session-a', [binding(), binding({ cardId: 'card-2', number: 13, title: '另一件事' })]]]),
  })
  assert.match(text, /同时挂了 2 张卡/)
  assert.match(text, /#12 实现登录态续期/)
  assert.match(text, /#13 另一件事/)
})

test('归档卡照实标注，并说明没有新活', () => {
  const text = renderCardContext({
    sessionId: 'session-a',
    cardIndex: new Map([['session-a', [binding({ status: 'archived' })]]]),
  })
  assert.match(text, /状态 archived/)
  assert.match(text, /已归档/)
})

test('渲染异常时记日志并返回空串，不打断 turn', () => {
  const lines = []
  const cardIndex = {
    get() {
      throw new Error('索引坏了')
    },
  }
  const { ctx, holder } = createFakeCtx()
  applyCardContext({ ctx, cardIndex, logger: (line) => lines.push(line) })
  assert.equal(holder.registered.text({ agent: { id: 'session-a' } }), '')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /索引坏了/)
})
