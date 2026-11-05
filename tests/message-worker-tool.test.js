import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMessageWorkerTool } from '../src/host/tools/message-worker.js'

/** 造一个记录调用的派工器假身。 */
function createFakeDispatcher() {
  const calls = []
  return {
    calls,
    async message(input) {
      calls.push(input)
      if (input.sessionId === 'child-在飞') {
        return { code: 'merged', name: input.name ?? '在飞的工' }
      }
      return { code: 'sent', name: input.name ?? '已结算的工' }
    },
  }
}

/** 跑一次工具 execute 的快捷方式。 */
function run(tool, args, agent = { id: 'parent-1' }) {
  return tool.execute(args, { agent, signal: new AbortController().signal })
}

test('sessionId 缺失或非字符串时报错', async () => {
  const tool = createMessageWorkerTool({ dispatcher: createFakeDispatcher() })
  await assert.rejects(() => run(tool, { message: 'hi' }), /sessionId/)
  await assert.rejects(() => run(tool, { sessionId: '  ', message: 'hi' }), /sessionId/)
  await assert.rejects(() => run(tool, { sessionId: 42, message: 'hi' }), /sessionId/)
})

test('message 缺失或空白时报错', async () => {
  const tool = createMessageWorkerTool({ dispatcher: createFakeDispatcher() })
  await assert.rejects(() => run(tool, { sessionId: 'child-1' }), /message/)
  await assert.rejects(() => run(tool, { sessionId: 'child-1', message: '' }), /message/)
})

test('rename 非字符串时报错', async () => {
  const tool = createMessageWorkerTool({ dispatcher: createFakeDispatcher() })
  await assert.rejects(() => run(tool, { sessionId: 'child-1', message: 'hi', rename: 7 }), /rename/)
})

test('cardId 非字符串时报错', async () => {
  const tool = createMessageWorkerTool({ dispatcher: createFakeDispatcher() })
  await assert.rejects(() => run(tool, { sessionId: 'child-1', message: 'hi', cardId: 7 }), /cardId/)
})

test('cardId 与 rename 一起透传给派工器', async () => {
  const dispatcher = createFakeDispatcher()
  const tool = createMessageWorkerTool({ dispatcher })
  await run(tool, { sessionId: 'child-1', message: '同卡续跑', cardId: ' card-1 ', rename: 'dev-2' })
  assert.equal(dispatcher.calls[0].cardId, 'card-1')
  assert.equal(dispatcher.calls[0].name, 'dev-2')
})

test('没有调用方 agent 时报错', async () => {
  const tool = createMessageWorkerTool({ dispatcher: createFakeDispatcher() })
  await assert.rejects(() => tool.execute({ sessionId: 'child-1', message: 'hi' }, { signal: new AbortController().signal }), /agent/)
})

test('透传给派工器并返回 merged 状态', async () => {
  const dispatcher = createFakeDispatcher()
  const tool = createMessageWorkerTool({ dispatcher })
  const result = await run(tool, { sessionId: 'child-在飞', message: '补个用例' })
  assert.equal(result.status, 'merged')
  assert.equal(result.name, '在飞的工')
  assert.equal(dispatcher.calls.length, 1)
  assert.equal(dispatcher.calls[0].sessionId, 'child-在飞')
  assert.equal(dispatcher.calls[0].message, '补个用例')
  assert.equal(dispatcher.calls[0].name, undefined)
})

test('rename 与投递同次交给派工器', async () => {
  const dispatcher = createFakeDispatcher()
  const tool = createMessageWorkerTool({ dispatcher })
  const result = await run(tool, { sessionId: 'child-1', message: '换个角色', rename: ' write-summary ' })
  assert.equal(result.status, 'sent')
  assert.equal(result.name, 'write-summary')
  assert.equal(dispatcher.calls[0].name, 'write-summary')
})

test('返回 sent 状态', async () => {
  const tool = createMessageWorkerTool({ dispatcher: createFakeDispatcher() })
  const result = await run(tool, { sessionId: 'child-1', message: '再核对' })
  assert.equal(result.status, 'sent')
  assert.equal(result.sessionId, 'child-1')
})

test('渲染文案区分两种状态', () => {
  const tool = createMessageWorkerTool({ dispatcher: createFakeDispatcher() })
  const merged = tool.output.render({}, { sessionId: 'c1', name: '工A', status: 'merged' })
  assert.ok(merged[0].text.includes('当前轮次'))
  assert.ok(merged[0].text.includes('下一步'))
  const sent = tool.output.render({}, { sessionId: 'c1', name: '工B', status: 'sent' })
  assert.ok(sent[0].text.includes('自动回报'))
})
