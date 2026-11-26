import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SlotRetention, isUnknownSessionError, retainTargetOf } from '../src/client/slot-retain.js'

/**
 * 造一个假的会话引用。
 *
 * @param {object} record - 调用记录
 * @param {string} sessionId - 会话 id
 * @returns {object} 假引用与 ready 的兑现函数
 */
function fakeReference(record, sessionId) {
  const existing = record.references.get(sessionId)
  if (existing !== undefined) return { reference: existing, settle: existing.settle }
  let settle
  const ready = new Promise((resolve) => { settle = resolve })
  const reference = {
    ready,
    settle,
    release: () => { record.released.push(sessionId) },
  }
  record.references.set(sessionId, reference)
  return { reference, settle }
}

/**
 * 造一个记录保留与释放的假保留器。
 *
 * @returns {object} 保留器与记录
 */
function makeRetention() {
  const record = { retained: [], released: [], states: [], dropped: [], references: new Map() }
  const retention = new SlotRetention({
    retain: (sessionId) => {
      record.retained.push(sessionId)
      return fakeReference(record, sessionId).reference
    },
    onState: (sessionId, state) => { record.states.push([sessionId, state]) },
    onDrop: (sessionId) => { record.dropped.push(sessionId) },
  })
  return { retention, record }
}

/**
 * 让微任务队列跑完，等 `reference.ready` 的回调落地。
 * @returns {Promise<void>} 兑现
 */
function flush() {
  return new Promise((resolve) => { setImmediate(resolve) })
}

test('需要的会话集合增加时保留一次，重复同步不重复保留', () => {
  const { retention, record } = makeRetention()
  retention.sync(new Set(['s1']))
  assert.deepEqual(record.retained, ['s1'])
  retention.sync(new Set(['s1']))
  assert.deepEqual(record.retained, ['s1'])
  assert.deepEqual(record.released, [])
})

test('需要的会话集合减少时释放一次，释放与保留严格配对', () => {
  const { retention, record } = makeRetention()
  retention.sync(new Set(['s1', 's2']))
  assert.deepEqual(record.retained, ['s1', 's2'])
  retention.sync(new Set(['s2']))
  assert.deepEqual(record.released, ['s1'])
  assert.deepEqual(record.dropped, ['s1'])
  retention.sync(new Set(['s2']))
  assert.deepEqual(record.released, ['s1'])
})

test('宿主不认识会话 id 时不保留，状态保持未知', () => {
  const record = { retained: [], released: [], states: [], dropped: [], references: new Map() }
  const retention = new SlotRetention({
    retain: () => { throw new Error('sessions.retain: unknown session nope') },
    onState: () => {},
    onDrop: () => {},
  })
  retention.sync(new Set(['nope']))
  assert.deepEqual(record.retained, [])
  assert.equal(retention.entries.size, 0)
})

test('保留成功后读到快照并继续订阅', async () => {
  const { retention, record } = makeRetention()
  retention.sync(new Set(['s1']))
  const { settle } = fakeReference(record, 's1')
  settle({ session: { getSnapshot: () => ({ running: true, lastAgentError: null }), subscribe: () => () => {} } })
  await flush()
  assert.deepEqual(record.states, [['s1', { running: true, failed: false }]])
})

test('保留期间撤掉槽位：会话已释放就不再订阅它的快照', async () => {
  const { retention, record } = makeRetention()
  retention.sync(new Set(['s1']))
  const { settle } = fakeReference(record, 's1')
  retention.sync(new Set([]))
  assert.deepEqual(record.released, ['s1'])
  let subscribed = false
  settle({ session: { getSnapshot: () => ({ running: false, lastAgentError: null }), subscribe: () => { subscribed = true; return () => {} } } })
  await flush()
  assert.equal(subscribed, false)
  assert.deepEqual(record.states, [])
})

test('保留失败要报告，同一个会话只报一次', () => {
  const errors = []
  const retention = new SlotRetention({
    retain: () => { throw new Error('sessions.retain: unknown session nope') },
    onState: () => {},
    onDrop: () => {},
    onError: (message) => { errors.push(message) },
  })
  retention.sync(new Set(['nope']))
  retention.sync(new Set(['nope']))
  retention.sync(new Set(['nope']))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /nope/)
  assert.match(errors[0], /sessions\.retain: unknown session nope/)
})

test('保留就绪失败也要报告，且撤掉再加回不重复报', async () => {
  const errors = []
  const retention = new SlotRetention({
    retain: () => ({ ready: Promise.reject(new Error('打开失败')), release: () => {} }),
    onState: () => {},
    onDrop: () => {},
    onError: (message) => { errors.push(message) },
  })
  retention.sync(new Set(['s1']))
  await flush()
  retention.sync(new Set([]))
  retention.sync(new Set(['s1']))
  await flush()
  assert.equal(errors.length, 1)
  assert.match(errors[0], /打开失败/)
})

test('宿主给了子代理地址就用它', () => {
  const address = { parentSessionId: 'p1', childSessionId: 'c1', mode: 'continuable' }
  const sessions = { subagentAddress: () => address }
  assert.deepEqual(retainTargetOf(sessions, 'c1', 'fallback'), address)
})

test('宿主没给地址时用建卡会话兜一个未知模式的地址', () => {
  const sessions = { subagentAddress: () => undefined }
  assert.deepEqual(retainTargetOf(sessions, 'c1', 'p1'), {
    parentSessionId: 'p1',
    childSessionId: 'c1',
    mode: 'unknown',
  })
})

test('既没有地址也没有建卡会话时不编造目标', () => {
  assert.equal(retainTargetOf({}, 'c1', ''), undefined)
  assert.equal(retainTargetOf({}, 'c1', undefined), undefined)
})

test('只吞宿主未知会话错误，其它错误照抛', () => {
  const retention = new SlotRetention({
    retain: () => { throw new Error('宿主网络错误') },
    onState: () => {},
    onDrop: () => {},
  })
  assert.throws(() => retention.sync(new Set(['s1'])), /宿主网络错误/)
  assert.equal(isUnknownSessionError(new Error('sessions.retain: unknown session x')), true)
  assert.equal(isUnknownSessionError(new Error('宿主网络错误')), false)
})

test('dispose 后迟到的同步不再保留', () => {
  const { retention, record } = makeRetention()
  retention.dispose()
  retention.sync(new Set(['s1']))
  assert.deepEqual(record.retained, [])
})

test('dispose 释放全部保留的会话，且不再回调状态更新', async () => {
  const { retention, record } = makeRetention()
  retention.sync(new Set(['s1', 's2']))
  retention.dispose()
  assert.deepEqual(record.released, ['s1', 's2'])
  assert.equal(retention.entries.size, 0)
  assert.deepEqual(record.dropped, [])
})
