import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  WORKER_STALL_SOURCE_KIND,
  readWorkerStallSource,
  stallNoticeSummary,
  workerStallBody,
  workerStallSource,
} from '../src/shared/worker-stall.js'
import { WORKER_STALL_NODE_KIND, workerStallDefinition } from '../src/client/worker-stall-definition.js'

test('巡查 source 带独立 kind、身份、界面正文与机器事实', () => {
  const source = workerStallSource('实现派工', 'child-1', 'worker「实现派工」已连续 22 分钟 没有回报', {
    detail: '已连续 22 分钟 没有回报。',
    elapsedMs: 22 * 60_000,
    lastReportAt: 1_000,
  })
  assert.equal(source.kind, WORKER_STALL_SOURCE_KIND)
  assert.equal(source.form, 'notice')
  assert.match(source.summary, /已连续 22 分钟 没有回报/)
  assert.equal(source.stall.name, '实现派工')
  assert.equal(source.stall.childSessionId, 'child-1')
  assert.equal(source.stall.detail, '已连续 22 分钟 没有回报。')
  assert.equal(source.stall.elapsedMs, 22 * 60_000)
  assert.equal(source.stall.lastReportAt, 1_000)
})

test('没有最后回报时不带 lastReportAt 键（undefined 过不了 lossless JSON 判定）', () => {
  const source = workerStallSource('a', 'b', 'c')
  assert.equal(Object.hasOwn(source.stall, 'lastReportAt'), false)
  assert.equal(source.stall.detail, '')
  assert.equal(source.stall.elapsedMs, 0)
})

test('摘要长度压到宿主上下文行的上限', () => {
  const summary = stallNoticeSummary('x'.repeat(200), '15 分钟')
  assert.equal(summary.length, 120)
  assert.match(summary, /…$/)
})

test('读 source 时逐层判型，坏形状一律 null', () => {
  const good = { kind: WORKER_STALL_SOURCE_KIND, stall: { name: 'a', childSessionId: 'b' } }
  assert.deepEqual(readWorkerStallSource(good), {
    name: 'a',
    childSessionId: 'b',
    detail: '',
    elapsedMs: 0,
  })
  assert.equal(readWorkerStallSource(null), null)
  assert.equal(readWorkerStallSource('x'), null)
  assert.equal(readWorkerStallSource([]), null)
  assert.equal(readWorkerStallSource({ kind: 'other', stall: { name: 'a', childSessionId: 'b' } }), null)
  assert.equal(readWorkerStallSource({ kind: WORKER_STALL_SOURCE_KIND }), null)
  assert.equal(readWorkerStallSource({ kind: WORKER_STALL_SOURCE_KIND, stall: { name: 1, childSessionId: 'b' } }), null)
  assert.equal(readWorkerStallSource({ kind: WORKER_STALL_SOURCE_KIND, stall: { name: 'a' } }), null)
  assert.equal(readWorkerStallSource({ kind: WORKER_STALL_SOURCE_KIND, stall: { name: 'a', childSessionId: 'b', elapsedMs: 'x' } }).elapsedMs, 0)
  assert.equal(readWorkerStallSource({ kind: WORKER_STALL_SOURCE_KIND, stall: { name: 'a', childSessionId: 'b', lastReportAt: 'x' } }).lastReportAt, undefined)
})

test('界面正文优先 detail，缺了退回消息正文', () => {
  assert.equal(workerStallBody({ detail: '提示', text: '协议正文' }), '提示')
  assert.equal(workerStallBody({ detail: '', text: '协议正文' }), '协议正文')
  assert.equal(workerStallBody({ text: '协议正文' }), '协议正文')
  assert.equal(workerStallBody({}), '')
  assert.equal(workerStallBody(null), '')
})

test('节点定义只认带巡查标记的追加输入', () => {
  const base = {
    type: 'user/message',
    surfaceOp: 'append',
    seq: 3,
    time: 1_000,
    data: {
      id: 'msg-1',
      content: [{ type: 'text', text: '协议正文' }],
      source: workerStallSource('实现派工', 'child-1', '摘要', {
        detail: '界面正文',
        elapsedMs: 22 * 60_000,
        lastReportAt: 500,
      }),
    },
  }
  assert.equal(workerStallDefinition.kind, WORKER_STALL_NODE_KIND)
  const match = workerStallDefinition.match(base)
  assert.notEqual(match, null)
  assert.equal(match.exclusive, true)
  // 替换副本、别人的 source、非 user/message 都不认领。
  assert.equal(workerStallDefinition.match({ ...base, surfaceOp: 'replace' }), null)
  assert.equal(workerStallDefinition.match({ ...base, data: { ...base.data, source: { kind: 'x' } } }), null)
  assert.equal(workerStallDefinition.match({ ...base, type: 'assistant/message' }), null)

  const state = workerStallDefinition.start({}, { event: base })
  assert.equal(state.name, '实现派工')
  assert.equal(state.childSessionId, 'child-1')
  assert.equal(state.detail, '界面正文')
  assert.equal(state.elapsedMs, 22 * 60_000)
  assert.equal(state.lastReportAt, 500)
  assert.equal(state.text, '协议正文')
})

test('节点落在回合首步的 exchange，其余留在 input', () => {
  const state = { seq: 3, time: 1_000 }
  const build = (location) => workerStallDefinition.buildViewNode({
    key: { kind: 'k', id: 'node-1' },
    id: 'node-1',
    state,
    start: { location },
  })
  assert.equal(build({ kind: 'step', step: { step: 1 } }).groupTree, 'exchange')
  assert.equal(build({ kind: 'step', step: { step: 2 } }).groupTree, 'input')
  assert.equal(build({ kind: 'unresolved' }).groupTree, 'input')
  assert.equal(workerStallDefinition.buildViewNode({ state: undefined }), null)
})

test('start 对形状不符的事件大声报错', () => {
  assert.throws(
    () => workerStallDefinition.start({}, { event: { type: 'assistant/message' } }),
    /需要 user\/message 事件/,
  )
  assert.throws(
    () => workerStallDefinition.start({}, { event: { type: 'user/message', data: { source: {} } } }),
    /需要带巡查标记的 source/,
  )
})
