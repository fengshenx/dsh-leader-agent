import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  WORKER_STALL_SOURCE_KIND,
  stallNoticeSummary,
  workerStallSource,
} from '../src/shared/worker-stall.js'

test('巡查 source 带独立 kind、身份与队列要用的机器事实', () => {
  const source = workerStallSource('实现派工', 'child-1', '【后台巡查】摘要', {
    runStartedAt: 1_000,
    lastReportAt: 500,
  })
  assert.equal(source.kind, WORKER_STALL_SOURCE_KIND)
  assert.equal(source.form, 'notice')
  assert.equal(source.summary, '【后台巡查】摘要')
  // 四个字段一个都不能少：队列去重、在飞核对与换 leader 改投都靠它们。
  assert.deepEqual(source.stall, {
    name: '实现派工',
    childSessionId: 'child-1',
    runStartedAt: 1_000,
    lastReportAt: 500,
  })
})

test('缺 runStartedAt / lastReportAt 时干脆不带键（undefined 过不了 lossless 判定）', () => {
  const source = workerStallSource('a', 'b', 'c')
  assert.deepEqual(source.stall, { name: 'a', childSessionId: 'b' })
  assert.equal(Object.hasOwn(source.stall, 'runStartedAt'), false)
  assert.equal(Object.hasOwn(source.stall, 'lastReportAt'), false)
})

test('摘要是带前缀的完整句子，并压到宿主上下文行的上限', () => {
  assert.equal(
    stallNoticeSummary('实现派工', '15 分钟'),
    '例行巡查：worker「实现派工」已连续 15 分钟没有回报',
  )
  const summary = stallNoticeSummary('x'.repeat(200), '15 分钟')
  assert.equal(summary.length, 120)
  assert.match(summary, /^例行巡查：/)
  assert.match(summary, /…$/)
})
