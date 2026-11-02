import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentAvatarDataUri, agentAvatarSeed } from '../src/client/worker-report-avatar.js'
import { WORKER_REPORT_NODE_KIND, workerReportDefinition } from '../src/client/worker-report-definition.js'
import { buildNotificationText } from '../src/host/dispatch.js'
import {
  WORKER_REPORT_SOURCE_KIND,
  boundSummary,
  readWorkerReportSource,
  workerReportBody,
  workerReportFormat,
  workerReportSource,
  workerReportText,
} from '../src/shared/worker-report.js'

test('worker 回报的 source 记着身份名与子会话', () => {
  const source = workerReportSource('前端 worker', 'child-1', '任务「前端 worker」已结束。')
  assert.equal(source.kind, WORKER_REPORT_SOURCE_KIND)
  assert.equal(source.worker.name, '前端 worker')
  assert.equal(source.worker.childSessionId, 'child-1')
  assert.equal(source.summary, '任务「前端 worker」已结束。')
  assert.equal(source.form, 'notice')
})

test('source 记着最后一次回报的内容与终态', () => {
  const source = workerReportSource('前端 worker', 'child-1', '任务结束。', '改完了', 'completed')
  assert.equal(source.worker.report, '改完了')
  assert.equal(source.worker.outcome, 'completed')
  const failed = workerReportSource('前端 worker', 'child-1', '任务失败。', '失败：模型不可用', 'failed')
  assert.equal(failed.worker.outcome, 'failed')
  // 缺省时是空回报与成功终态：改造之前的调用点不必改。
  assert.equal(workerReportSource('a', 'b', 'c').worker.report, '')
})

test('界面渲染最后一次回报的内容，没有就退回正文', () => {
  assert.equal(workerReportBody({ report: '改完了', text: '任务「x」已结束。' }), '改完了')
  assert.equal(workerReportBody({ report: '', text: '任务「x」已结束。' }), '任务「x」已结束。')
  assert.equal(workerReportBody({ text: '正文' }), '正文')
  assert.equal(workerReportBody({}), '')
  assert.equal(workerReportBody(null), '')
})

test('旧消息回退的整条正文走纯文本，新消息的 report 走 Markdown', () => {
  // 旧消息没有 report，正文是逐行协议字段；Markdown 的软换行会把它们折成一段。
  assert.equal(workerReportFormat({ report: '', text: '任务「x」已结束。\n子会话：c1\n状态：completed' }), 'text')
  assert.equal(workerReportFormat({ text: '正文' }), 'text')
  // 新消息的 report 是 worker 自己的产物，按 Markdown 渲染。
  assert.equal(workerReportFormat({ report: '## 摘要\n\n- 改完了', text: '协议字段' }), 'markdown')
  assert.equal(workerReportFormat(null), 'text')
  assert.equal(workerReportFormat(undefined), 'text')
})

test('单换行连接的旧回报走纯文本，有块级标记或空行才判 Markdown', () => {
  // #8 起 report 随通知落盘，多块用单个 \n 连接；Markdown 的软换行会把块折成一段。
  assert.equal(workerReportFormat({ report: '第一块\n第二块' }), 'text')
  assert.equal(workerReportFormat({ report: '第一块\n第二块', outcome: 'completed' }), 'text')
  // 块级标记本身会分段，不会被折成一段。
  assert.equal(workerReportFormat({ report: '## 摘要\n\n收尾一句' }), 'markdown')
  assert.equal(workerReportFormat({ report: '- 一\n- 二' }), 'markdown')
  assert.equal(workerReportFormat({ report: '```\nnpm run check\n```' }), 'markdown')
  assert.equal(workerReportFormat({ report: '| a | b |\n| - | - |' }), 'markdown')
  // 单行正文不存在折段，行内语法照常渲染。
  assert.equal(workerReportFormat({ report: '改完了 `src/host/message.js`' }), 'markdown')
})

test('空行分隔的新回报走 Markdown，行内语法不被当成纯文本字面显示', () => {
  // 本 PR 起多块用 \n\n 连接：没有块级标记也要渲染，否则行内语法按字面显示。
  assert.equal(workerReportFormat({ report: '第一段 `a.js`\n\n第二段 `b.js`' }), 'markdown')
  assert.equal(workerReportFormat({ report: '第一段\n\n第二段\n\n第三段' }), 'markdown')
})

test('失败原因的回报保持纯文本，多行错误不被 Markdown 折行', () => {
  assert.equal(workerReportFormat({ report: '失败：第一行\n第二行', outcome: 'failed' }), 'text')
  // 成功终态不受影响，仍按 report 是否存在判断。
  assert.equal(workerReportFormat({ report: '## 摘要', outcome: 'completed' }), 'markdown')
})

test('节点状态带着回报内容与终态', () => {
  const event = {
    type: 'user/message',
    seq: 7,
    time: 1700000000000,
    surfaceOp: 'append',
    data: {
      id: 'm-1',
      content: [{ type: 'text', text: '任务「前端 worker」已结束。' }],
      source: workerReportSource('前端 worker', 'child-1', '任务结束。', '改完了', 'completed'),
    },
  }
  const match = workerReportDefinition.match(event)
  assert.notEqual(match, null)
  const state = workerReportDefinition.start({}, { event, location: { kind: 'turn' } })
  assert.equal(state.report, '改完了')
  assert.equal(state.outcome, 'completed')
  assert.equal(state.childSessionId, 'child-1')
  assert.equal(state.text, '任务「前端 worker」已结束。')
})

test('读 worker 回报的 source 时逐层判型', () => {
  assert.deepEqual(
    readWorkerReportSource({ kind: WORKER_REPORT_SOURCE_KIND, worker: { name: 'a', childSessionId: 'b' } }),
    { name: 'a', childSessionId: 'b', report: '', outcome: 'completed' },
  )
  // 改名（label → name）之前落盘的消息只有 label，读旧消息时退回它。
  assert.deepEqual(
    readWorkerReportSource({ kind: WORKER_REPORT_SOURCE_KIND, worker: { label: 'a', childSessionId: 'b' } }),
    { name: 'a', childSessionId: 'b', report: '', outcome: 'completed' },
  )
  assert.equal(readWorkerReportSource({ kind: 'user', worker: { name: 'a', childSessionId: 'b' } }), null)
  assert.equal(readWorkerReportSource({ kind: WORKER_REPORT_SOURCE_KIND }), null)
  assert.equal(readWorkerReportSource({ kind: WORKER_REPORT_SOURCE_KIND, worker: null }), null)
  assert.equal(readWorkerReportSource({ kind: WORKER_REPORT_SOURCE_KIND, worker: { name: 1, childSessionId: 'b' } }), null)
  assert.equal(readWorkerReportSource({ kind: WORKER_REPORT_SOURCE_KIND, worker: { name: 'a' } }), null)
  assert.equal(readWorkerReportSource(null), null)
  assert.equal(readWorkerReportSource([{ kind: WORKER_REPORT_SOURCE_KIND }]), null)
  assert.equal(readWorkerReportSource('worker-report'), null)
  assert.equal(readWorkerReportSource(undefined), null)
})

test('从内容块里取纯文本', () => {
  assert.equal(workerReportText([{ type: 'text', text: '一' }, { type: 'text', text: '二' }]), '一\n二')
  assert.equal(workerReportText([{ type: 'image', url: 'x' }]), '')
  assert.equal(workerReportText([{ type: 'text' }]), '')
  assert.equal(workerReportText('不是数组'), '')
})

test('通知正文不带说话人前缀', () => {
  const text = buildNotificationText(
    { name: '前端 worker', childId: 'child-1' },
    { ok: true, result: { stopReason: 'completed', output: [{ type: 'text', text: '干完了' }] } },
  )
  assert.equal(text.includes('【worker 回报】'), false)
  assert.equal(text.startsWith('任务「前端 worker」已结束。'), true)
  assert.equal(text.includes('产物摘要：\n干完了'), true)
})

test('头像按名字定种子，同名恒同图', () => {
  assert.equal(agentAvatarSeed('前端 worker'), agentAvatarSeed('前端 worker'))
  // 池子只有 63 个 seed，不同名字撞图是正常的；这里只保证分配铺得开。
  const seeds = new Set(Array.from({ length: 100 }, (_, index) => agentAvatarSeed(`worker-${index}`)))
  assert.equal(seeds.size > 10, true)
  const uri = agentAvatarDataUri('前端 worker')
  assert.equal(uri.startsWith('data:image/svg+xml,'), true)
  assert.equal(uri.includes(encodeURIComponent('<rect x="-1.5"')), true)
  assert.equal(uri, agentAvatarDataUri('前端 worker'))
})

test('节点定义只认带 worker 标记的用户消息', () => {
  const marked = {
    type: 'user/message',
    surfaceOp: 'append',
    data: { id: 'm1', source: workerReportSource('worker a', 'child-1', '摘要'), content: [] },
  }
  assert.deepEqual(workerReportDefinition.match(marked), { id: 'm1', role: 'start', exclusive: true })
  assert.equal(workerReportDefinition.match({ type: 'user/message', surfaceOp: 'append', data: { id: 'm2', source: { kind: 'user' } } }), null)
  assert.equal(workerReportDefinition.match({ type: 'assistant/message', data: {} }), null)
})

test('节点定义不认领替换副本', () => {
  // 替换副本只应留在模型侧，不该出现在人类转录里（宿主的 isAppendSurfaceEvent
  // 判的就是 surfaceOp === 'append'，官方两个同类定义都带这一条）
  const replace = {
    type: 'user/message',
    surfaceOp: 'replace',
    data: { id: 'm1', source: workerReportSource('worker a', 'child-1', '摘要'), content: [] },
  }
  assert.equal(workerReportDefinition.match(replace), null)
  assert.equal(workerReportDefinition.match({
    type: 'user/message',
    data: { id: 'm1', source: workerReportSource('worker a', 'child-1', '摘要'), content: [] },
  }), null)
})

test('节点定义把回报事实装进视图节点', () => {
  const event = {
    type: 'user/message',
    seq: 12,
    time: 1700,
    data: {
      id: 'm1',
      source: workerReportSource('worker a', 'child-1', '摘要'),
      content: [{ type: 'text', text: '任务「a」已结束。' }],
    },
  }
  const state = workerReportDefinition.start({}, { event, location: { kind: 'turn' } })
  assert.equal(state.name, 'worker a')
  assert.equal(state.childSessionId, 'child-1')
  assert.equal(state.text, '任务「a」已结束。')
  assert.equal(state.seq, 12)

  const node = workerReportDefinition.buildViewNode({
    key: '7:dsh-leader-kit-worker-reportm1',
    id: 'm1',
    start: { location: { kind: 'turn' } },
    state,
  })
  assert.equal(node.kind, WORKER_REPORT_NODE_KIND)
  assert.equal(node.target, 'chat')
  assert.equal(node.key, '7:dsh-leader-kit-worker-reportm1')
  assert.equal(node.anchorSeq, 12)
  assert.equal(node.visibility, 'visible')
  assert.equal(node.groupTree, 'input')
  assert.equal(node.data.name, 'worker a')
})

test('节点定义按官方口径给分组位置：回合首步开启新 exchange', () => {
  const state = { seq: 1, time: 1, messageId: 'm1', text: 'x', name: 'a', childSessionId: 'c' }
  const first = workerReportDefinition.buildViewNode({
    key: 'k',
    id: 'm1',
    start: { location: { kind: 'step', turn: { turn: 1 }, step: { step: 1 } } },
    state,
  })
  assert.equal(first.groupTree, 'exchange')
  const later = workerReportDefinition.buildViewNode({
    key: 'k',
    id: 'm1',
    start: { location: { kind: 'step', turn: { turn: 1 }, step: { step: 2 } } },
    state,
  })
  assert.equal(later.groupTree, 'input')
})

test('notice 摘要压到 120 字符', () => {
  // 宿主把长度约束写在生产者身上：摘要的输入是调用方文本（任务标签等），没有长度上限
  const long = '长'.repeat(200)
  const source = workerReportSource('worker a', 'child-1', long)
  assert.equal(source.summary.length, 120)
  assert.equal(source.summary.endsWith('…'), true)
  assert.equal(boundSummary('短'), '短')
})
