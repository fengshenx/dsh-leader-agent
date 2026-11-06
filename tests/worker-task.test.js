import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { WORKER_TASK_NODE_KIND, workerTaskDefinition } from '../src/client/worker-task-definition.js'
import { bubbleFormat, messageText } from '../src/shared/message-text.js'
import { WORKER_TASK_SOURCE_KIND, readWorkerTaskSource } from '../src/shared/worker-task.js'

test('读 leader 任务的 source 时逐层判型', () => {
  assert.deepEqual(
    readWorkerTaskSource({ kind: WORKER_TASK_SOURCE_KIND, name: 'w', parentSessionId: 'leader-1' }),
    { parentSessionId: 'leader-1' },
  )
  // 没有发起会话就认不出身份按钮指向哪里：退回官方上下文行，不硬造气泡。
  assert.equal(readWorkerTaskSource({ kind: WORKER_TASK_SOURCE_KIND, name: 'w' }), null)
  assert.equal(readWorkerTaskSource({ kind: WORKER_TASK_SOURCE_KIND, parentSessionId: '' }), null)
  assert.equal(readWorkerTaskSource({ kind: WORKER_TASK_SOURCE_KIND, parentSessionId: 1 }), null)
  assert.equal(readWorkerTaskSource({ kind: 'user', parentSessionId: 'leader-1' }), null)
  assert.equal(readWorkerTaskSource({ kind: 'dsh-leader-agent/worker-report', parentSessionId: 'leader-1' }), null)
  assert.equal(readWorkerTaskSource(null), null)
  assert.equal(readWorkerTaskSource([{ kind: WORKER_TASK_SOURCE_KIND }]), null)
  assert.equal(readWorkerTaskSource('worker-task'), null)
  assert.equal(readWorkerTaskSource(undefined), null)
})

test('节点定义只认领追加的 leader 任务消息', () => {
  const task = {
    type: 'user/message',
    surfaceOp: 'append',
    data: { id: 'm1', source: { kind: WORKER_TASK_SOURCE_KIND, name: 'w', parentSessionId: 'leader-1' }, content: [] },
  }
  assert.deepEqual(workerTaskDefinition.match(task), { id: 'm1', role: 'start', exclusive: true })
  // 替换副本只应留在模型侧，不该出现在人类转录里。
  assert.equal(workerTaskDefinition.match({ ...task, surfaceOp: 'replace' }), null)
  assert.equal(workerTaskDefinition.match({ ...task, surfaceOp: undefined }), null)
  // 别的来源（真人输入、worker 回报、宿主上下文）不归这条定义。
  assert.equal(workerTaskDefinition.match({
    type: 'user/message',
    surfaceOp: 'append',
    data: { id: 'm2', source: { kind: 'user' }, content: [] },
  }), null)
  assert.equal(workerTaskDefinition.match({ type: 'assistant/message', data: {} }), null)
})

test('节点定义把任务正文与发起会话装进视图节点', () => {
  const event = {
    type: 'user/message',
    seq: 12,
    time: 1700,
    data: {
      id: 'm1',
      source: { kind: WORKER_TASK_SOURCE_KIND, name: 'w', parentSessionId: 'leader-1' },
      content: [{ type: 'text', text: '修一下登录' }, { type: 'text', text: '跑测试' }],
    },
  }
  const state = workerTaskDefinition.start({}, { event, location: { kind: 'turn' } })
  assert.equal(state.text, '修一下登录\n跑测试')
  assert.equal(state.parentSessionId, 'leader-1')
  assert.equal(state.seq, 12)
  assert.equal(state.time, 1700)
  assert.equal(state.messageId, 'm1')

  const node = workerTaskDefinition.buildViewNode({
    key: '7:dsh-leader-agent-worker-taskm1',
    id: 'm1',
    start: { location: { kind: 'turn' } },
    state,
  })
  assert.equal(node.kind, WORKER_TASK_NODE_KIND)
  assert.equal(node.target, 'chat')
  assert.equal(node.key, '7:dsh-leader-agent-worker-taskm1')
  assert.equal(node.anchorSeq, 12)
  assert.equal(node.visibility, 'visible')
  assert.equal(node.groupTree, 'input')
  assert.equal(node.data.parentSessionId, 'leader-1')
})

test('节点定义按官方口径给分组位置：回合首步开启新 exchange', () => {
  const state = { seq: 1, time: 1, messageId: 'm1', text: 'x', parentSessionId: 'leader-1' }
  const first = workerTaskDefinition.buildViewNode({
    key: 'k',
    id: 'm1',
    start: { location: { kind: 'step', turn: { turn: 1 }, step: { step: 1 } } },
    state,
  })
  assert.equal(first.groupTree, 'exchange')
  const later = workerTaskDefinition.buildViewNode({
    key: 'k',
    id: 'm1',
    start: { location: { kind: 'step', turn: { turn: 1 }, step: { step: 2 } } },
    state,
  })
  assert.equal(later.groupTree, 'input')
  assert.equal(workerTaskDefinition.buildViewNode({ key: 'k', id: 'm1', state: undefined }), null)
})

test('任务正文的渲染格式：单行、空行与块级标记走 Markdown，逐行协议字段走纯文本', () => {
  assert.equal(bubbleFormat(''), 'text')
  assert.equal(bubbleFormat(null), 'text')
  assert.equal(bubbleFormat('改一下 `src/host/message.js`'), 'markdown')
  assert.equal(bubbleFormat('第一行\n第二行'), 'text')
  assert.equal(bubbleFormat('第一段\n\n第二段'), 'markdown')
  assert.equal(bubbleFormat('## 目标\n修登录'), 'markdown')
  assert.equal(bubbleFormat('- 修登录\n- 跑测试'), 'markdown')
})

test('从内容块里取纯文本时判型，块间分隔符可换', () => {
  assert.equal(messageText([{ type: 'text', text: '一' }, { type: 'image', url: 'x' }, { type: 'text', text: '二' }]), '一\n二')
  assert.equal(messageText([{ type: 'text', text: '一' }, { type: 'text', text: '二' }], '\n\n'), '一\n\n二')
  assert.equal(messageText([{ type: 'text' }]), '')
  assert.equal(messageText([null, 3, 'x']), '')
  assert.equal(messageText('不是数组'), '')
  assert.equal(messageText(undefined), '')
})

test('客户端入口把任务节点定义与渲染器都挂上', () => {
  const source = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  assert.match(source, /import \{ WORKER_TASK_NODE_KIND, workerTaskDefinition \} from '\.\/worker-task-definition\.js'/)
  assert.match(source, /import \{ WorkerTaskView \} from '\.\/worker-task-view\.js'/)
  // 宿主按注册键分发渲染器：键必须等于节点 kind。
  assert.match(source, /key: bubble\.kind/)
  assert.equal(workerTaskDefinition.kind, WORKER_TASK_NODE_KIND)
  assert.match(source, /kind: WORKER_TASK_NODE_KIND/)
})
