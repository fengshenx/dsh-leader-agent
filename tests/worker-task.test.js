import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { WORKER_TASK_NODE_KIND, workerTaskDefinition } from '../src/client/worker-task-definition.js'
import { hardBreakMarkdown, messageText } from '../src/shared/message-text.js'
import { WORKER_TASK_SOURCE_KIND, readWorkerTaskSource } from '../src/shared/worker-task.js'

test('读 leader 任务的 source 时逐层判型', () => {
  assert.deepEqual(
    readWorkerTaskSource({ kind: WORKER_TASK_SOURCE_KIND, name: 'w', parentSessionId: 'leader-1' }),
    { parentSessionId: 'leader-1' },
  )
  // 没有来源凭证的 kind 标记不足以证明是 leader 派发的任务：退回官方上下文行。
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

test('节点定义把任务正文装进视图节点', () => {
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
  assert.deepEqual(node.data, state)
})

test('节点定义按官方口径给分组位置：回合首步开启新 exchange', () => {
  const state = { seq: 1, time: 1, messageId: 'm1', text: 'x' }
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

test('任务正文始终按 Markdown 渲染，逐行结构补成硬换行', () => {
  assert.equal(hardBreakMarkdown(''), '')
  assert.equal(hardBreakMarkdown(null), '')
  assert.equal(hardBreakMarkdown('改一下 `src/host/message.js`'), '改一下 `src/host/message.js`')
  // 逐行的「做什么 / 边界 / 验收」补两个尾随空格，GFM 渲染成 <br>。
  assert.equal(hardBreakMarkdown('第一行\n第二行'), '第一行  \n第二行')
  // 空行已经是段落边界，不再补空格。
  assert.equal(hardBreakMarkdown('第一段\n\n第二段'), '第一段\n\n第二段')
  // 标题、列表、表格行补空格不影响块级解析。
  assert.equal(hardBreakMarkdown('## 目标\n修登录'), '## 目标  \n修登录')
  assert.equal(hardBreakMarkdown('- 一\n- 二'), '- 一  \n- 二')
  assert.equal(hardBreakMarkdown('| 列 | 值 |\n| - | - |'), '| 列 | 值 |  \n| - | - |')
  // 围栏代码块内的换行是代码内容，不能改；围栏按字符与长度配对。
  // 关闭行后至少跟两行正文：尾行本来就不补空格，只留尾行证明不了状态已恢复。
  assert.equal(
    hardBreakMarkdown('```js\nconst a = 1\nconst b = 2\n```\n后一行\n再一行'),
    '```js\nconst a = 1\nconst b = 2\n```\n后一行  \n再一行',
  )
  assert.equal(hardBreakMarkdown('~~~\ncode\n~~~~\n后一行\n再一行'), '~~~\ncode\n~~~~\n后一行  \n再一行')
  assert.equal(hardBreakMarkdown('```\na\n~~~\nb\n```\n后一行\n再一行'), '```\na\n~~~\nb\n```\n后一行  \n再一行')
  // 围栏套在块引用或列表里：先剥容器前缀，代码内容仍不能被补空格。
  assert.equal(
    hardBreakMarkdown('> ```\n> code\n> ```\n> 第一行\n> 第二行'),
    '> ```\n> code\n> ```\n> 第一行  \n> 第二行',
  )
  assert.equal(
    hardBreakMarkdown('- ```\n  code\n  ```\n  第一行\n  第二行'),
    '- ```\n  code\n  ```\n  第一行  \n  第二行',
  )
  // tab 缩进的关闭围栏按列识别：`- ``` ` 内容起始第 2 列，行首 tab 展开到第 4 列。
  assert.equal(
    hardBreakMarkdown('- ```\n  code\n\t```\n后一行\n再一行'),
    '- ```\n  code\n\t```\n后一行  \n再一行',
  )
  // 块引用没带 `>` 的行说明容器已经结束，围栏随之结束，后面的正文照常补硬换行。
  assert.equal(
    hardBreakMarkdown('> ```\n> code\n普通行\n再一行'),
    '> ```\n> code\n普通行  \n再一行',
  )
  // 嵌套列表：关闭围栏缩进到容器内容起始列，不能因为多出缩进就永远关不掉。
  assert.equal(
    hardBreakMarkdown('- 外层：\n  - ```js\n    const x = 1\n    ```\n后一行\n再一行'),
    '- 外层：  \n  - ```js\n    const x = 1\n    ```\n后一行  \n再一行',
  )
  // 围栏里以 `> ``` ` / `- ``` ` 开头的行是代码内容，不能当成关闭行，否则后续代码被补空格。
  assert.equal(
    hardBreakMarkdown('```\n> ```\ncode\n```\n后一行\n再一行'),
    '```\n> ```\ncode\n```\n后一行  \n再一行',
  )
  assert.equal(
    hardBreakMarkdown('- ```\n  - ```\n  code\n  ```\n后一行\n再一行'),
    '- ```\n  - ```\n  code\n  ```\n后一行  \n再一行',
  )
  // 块引用里的逐行正文仍要保留换行。
  assert.equal(hardBreakMarkdown('> 第一行\n> 第二行'), '> 第一行  \n> 第二行')
  // 空的块引用行是段落边界，不补空格。
  assert.equal(hardBreakMarkdown('第一行\n>\n第二行'), '第一行\n>\n第二行')
  // 已经是硬换行的行不重复补；反斜杠后补空格会改掉换行语义。
  assert.equal(hardBreakMarkdown('第一行  \n第二行'), '第一行  \n第二行')
  assert.equal(hardBreakMarkdown('第一行\\\n第二行'), '第一行\\\n第二行')
  // 缩进代码块同理。
  assert.equal(hardBreakMarkdown('    缩进代码\n正文'), '    缩进代码\n正文')
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
