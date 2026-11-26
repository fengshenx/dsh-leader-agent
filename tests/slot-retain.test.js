import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SlotRetention, isUnknownSessionError } from '../src/client/slot-retain.js'

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

/**
 * 等重试定时器真正跑完：0ms 的 setTimeout 会被夹到 1ms，setImmediate 熬不过它。
 * @param {number} [ms] - 等待毫秒数
 * @returns {Promise<void>} 兑现
 */
function waitTimers(ms = 25) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
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
    retain: (sessionId) => { record.retained.push(sessionId); throw new Error('sessions.retain: unknown session nope') },
    onState: () => {},
    onDrop: () => {},
    retryAttempts: 0,
  })
  retention.sync(new Set(['nope']))
  assert.deepEqual(record.retained, ['nope'])
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
    retryAttempts: 0,
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

test('宿主其它错误只报告、不抛：一个槽位失败不能炸掉整块看板', () => {
  const errors = []
  const retention = new SlotRetention({
    retain: () => { throw new Error('subagent does not belong to the supplied parent') },
    onState: () => {},
    onDrop: () => {},
    onError: (message) => { errors.push(message) },
  })
  assert.doesNotThrow(() => retention.sync(new Set(['s1'])))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /subagent does not belong to the supplied parent/)
  assert.equal(retention.entries.size, 0)
  assert.equal(isUnknownSessionError(new Error('sessions.retain: unknown session x')), true)
  assert.equal(isUnknownSessionError(new Error('宿主网络错误')), false)
})

test('宿主会话目录晚就绪：未知会话按次数重试，成功后不再报告', async () => {
  const attempts = []
  const errors = []
  const { retention, record } = makeRetention()
  const realRetain = retention.retain
  retention.retain = (sessionId) => {
    attempts.push(sessionId)
    // 前两次宿主还没认出这条会话，第三次才成功
    if (attempts.length < 3) throw new Error('sessions.retain: unknown session early')
    return realRetain(sessionId)
  }
  retention.onError = (message) => { errors.push(message) }
  retention.retryAttempts = 5
  retention.retryDelayMs = 1
  retention.sync(new Set(['s1']))
  await waitTimers()
  assert.deepEqual(attempts, ['s1', 's1', 's1'])
  assert.equal(retention.entries.size, 1)
  assert.deepEqual(errors, [])
  assert.deepEqual(record.retained, ['s1'])
})

test('未知会话重试用尽后报告一次，不无限重试', async () => {
  const attempts = []
  const errors = []
  const retention = new SlotRetention({
    retain: (sessionId) => { attempts.push(sessionId); throw new Error('sessions.retain: unknown session gone') },
    onState: () => {},
    onDrop: () => {},
    onError: (message) => { errors.push(message) },
    retryAttempts: 2,
    retryDelayMs: 1,
  })
  retention.sync(new Set(['s1']))
  await waitTimers()
  assert.deepEqual(attempts, ['s1', 's1', 's1'])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /sessions\.retain: unknown session gone/)
  assert.equal(retention.entries.size, 0)
})

test('槽位撤掉时取消待跑的未知会话重试', async () => {
  const attempts = []
  const retention = new SlotRetention({
    retain: (sessionId) => { attempts.push(sessionId); throw new Error('sessions.retain: unknown session gone') },
    onState: () => {},
    onDrop: () => {},
    retryAttempts: 3,
    retryDelayMs: 1,
  })
  retention.sync(new Set(['s1']))
  retention.sync(new Set([]))
  await waitTimers()
  assert.deepEqual(attempts, ['s1'])
  assert.equal(retention.timers.size, 0)
  assert.equal(retention.retries.size, 0)
})

test('dispose 后待跑的未知会话重试不再执行', async () => {
  const attempts = []
  const retention = new SlotRetention({
    retain: (sessionId) => { attempts.push(sessionId); throw new Error('sessions.retain: unknown session gone') },
    onState: () => {},
    onDrop: () => {},
    retryAttempts: 3,
    retryDelayMs: 1,
  })
  retention.sync(new Set(['s1']))
  retention.dispose()
  await waitTimers()
  assert.deepEqual(attempts, ['s1'])
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
