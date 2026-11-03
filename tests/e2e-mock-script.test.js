import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyRequest, createScriptCursor, findMarkers, resolveMarker, sseEvents } from './e2e/mock-script.mjs'

/** 造一个最小的 Messages 请求体。 */
function request(messages) {
  return { model: 'mock-model', messages }
}

test('标记从文本 block 里取出，历史里的也算', () => {
  const body = request([
    { role: 'user', content: [{ type: 'text', text: 'MOCK-BOARD 看一下看板' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
    { role: 'user', content: [{ type: 'tool_result', content: 'MOCK-BOARD 的结果' }] },
  ])
  assert.deepEqual(findMarkers(body), ['MOCK-BOARD'])
})

test('一个请求里两个标记直接报错：一次只改一个变量', () => {
  const body = request([{ role: 'user', content: 'MOCK-A 和 MOCK-B' }])
  assert.throws(() => resolveMarker(body), /多个场景标记/)
})

test('没有标记时返回 null，交由游标决定是不是续轮', () => {
  assert.equal(resolveMarker(request([{ role: 'user', content: '普通消息' }])), null)
})

test('工具调用之后的一轮没有标记，沿用同一份脚本的下一步', () => {
  const cursor = createScriptCursor({
    'MOCK-DISPATCH': [{ tool: { name: 'board_list', input: {} } }, { text: '收工' }],
  })
  assert.deepEqual(cursor.take(resolveMarker(request([{ role: 'user', content: 'MOCK-DISPATCH 派工' }]))), {
    tool: { name: 'board_list', input: {} },
  })
  assert.deepEqual(cursor.take(resolveMarker(request([{ role: 'user', content: '工具结果' }]))), { text: '收工' })
  assert.deepEqual(cursor.remaining(), { 'MOCK-DISPATCH': 0 })
})

test('脚本多跑一轮时报错，不静默复用最后一步', () => {
  const cursor = createScriptCursor({ 'MOCK-ONE': [{ text: '一次' }] })
  cursor.take('MOCK-ONE')
  assert.throws(() => cursor.take(null), /只有 1 步/)
})

test('未知标记报错并列出已注册的脚本', () => {
  const cursor = createScriptCursor({ 'MOCK-A': [{ text: 'a' }] })
  assert.throws(() => cursor.take('MOCK-B'), /已注册：MOCK-A/)
})

test('完全没有标记且没有活动标记时报错：mock 不允许猜', () => {
  const cursor = createScriptCursor({ 'MOCK-A': [{ text: 'a' }] })
  assert.throws(() => cursor.take(null), /没有 MOCK- 场景标记/)
})

test('文本脚本的 SSE 事件顺序与字段', () => {
  const events = sseEvents({ text: '收工' }, { chunkSize: 1 })
  assert.deepEqual(events.map((event) => event.type), [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop',
  ])
  assert.deepEqual(events[2].delta, { type: 'text_delta', text: '收' })
  assert.equal(events[5].delta.stop_reason, 'end_turn')
})

test('工具脚本以 tool_use 开头，stop_reason 为 tool_use，JSON 分块拼回原值', () => {
  const events = sseEvents({ tool: { name: 'board_list', input: { limit: 5 } } }, { chunkSize: 4 })
  assert.equal(events[1].content_block.type, 'tool_use')
  assert.equal(events[1].content_block.name, 'board_list')
  const partial = events
    .filter((event) => event.delta?.type === 'input_json_delta')
    .map((event) => event.delta.partial_json)
    .join('')
  assert.deepEqual(JSON.parse(partial), { limit: 5 })
  assert.equal(events.at(-2).delta.stop_reason, 'tool_use')
})

test('一步脚本同时给文本与工具时报错：两轮场景的轮次会错位', () => {
  assert.throws(() => sseEvents({ text: 'x', tool: { name: 'y', input: {} } }), /文本或工具调用之一/)
})

test('工具调用缺 name 时报错', () => {
  assert.throws(() => sseEvents({ tool: { input: {} } }), /缺少 name/)
})

test('标题生成请求单独归类：它带着用户原文，会误命中场景标记', () => {
  const title = {
    model: 'mock-model',
    system: 'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    messages: [{ role: 'user', content: 'Generate the session title from this JSON array of human messages:\n[{"seq":8,"text":"MOCK-E2E-REPLY 收工即可"}]' }],
  }
  assert.equal(classifyRequest(title), 'title')
  assert.equal(classifyRequest({ system: 'You are an AI agent powered by DeepSeek Harness.', messages: [] }), 'scenario')
  assert.equal(classifyRequest({ system: [{ type: 'text', text: 'Create a concise title' }] }), 'title')
})
