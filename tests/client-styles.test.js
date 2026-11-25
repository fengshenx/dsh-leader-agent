import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ensureBoardStyles } from '../src/client/board-styles.js'
import { ensureAgentBubbleStyles } from '../src/client/agent-bubble-styles.js'
import { ensureWorkerTaskStyles } from '../src/client/worker-task-styles.js'

/**
 * 造一个够用的 document 桩。
 *
 * 幂等判重靠 `getElementById`，所以桩要像真实 DOM 一样记住已插入的节点——
 * 只记 append 次数会让「重复注入」这条断言永远成立。
 *
 * @param {{ id: string, textContent: string }[]} [seeded] - 预置在 head 里的节点（模拟上一次插件实例留下的样式表）
 * @returns {object[]} 已追加到 head 的节点
 */
function installDocument(seeded = []) {
  const head = [...seeded]
  const byId = new Map(head.map((node) => [node.id, node]))
  globalThis.document = {
    head: {
      append(node) {
        head.push(node)
        if (node.id !== '') byId.set(node.id, node)
      },
    },
    createElement(tag) {
      return { tag, id: '', textContent: '' }
    },
    getElementById(id) {
      return byId.get(id) ?? null
    },
  }
  return head
}

afterEach(() => {
  delete globalThis.document
})

test('看板样式表注入一次，重复调用不重复追加', () => {
  const head = installDocument()
  ensureBoardStyles()
  ensureBoardStyles()
  assert.equal(head.length, 1)
  assert.equal(head[0].id, 'dsh-leader-agent-board')
  assert.match(head[0].textContent, /\.dsh-leader-agent-board/)
})

test('agent 气泡样式表注入一次，重复调用不重复追加', () => {
  const head = installDocument()
  ensureAgentBubbleStyles()
  ensureAgentBubbleStyles()
  assert.equal(head.length, 1)
  assert.equal(head[0].id, 'dsh-leader-agent-agent-bubble')
  assert.match(head[0].textContent, /\.dsh-leader-agent-agent-bubble/)
})

test('leader 任务气泡样式表注入一次，重复调用不重复追加', () => {
  const head = installDocument()
  ensureWorkerTaskStyles()
  ensureWorkerTaskStyles()
  assert.equal(head.length, 1)
  assert.equal(head[0].id, 'dsh-leader-agent-worker-task')
  assert.match(head[0].textContent, /\.dsh-leader-agent-worker-task/)
})

test('已有旧版本样式表时就地刷新内容，不追加第二张（HMR 换插件后 CSS 跟上新版本）', () => {
  const head = installDocument([
    { id: 'dsh-leader-agent-board', textContent: '.dsh-leader-agent-board-old { color: red; }' },
  ])
  ensureBoardStyles()
  assert.equal(head.length, 1)
  assert.match(head[0].textContent, /\.dsh-leader-agent-board \{/)
  assert.doesNotMatch(head[0].textContent, /board-old/)
})

test('没有 document 时直接返回，不抛错', () => {
  delete globalThis.document
  ensureBoardStyles()
  ensureAgentBubbleStyles()
  ensureWorkerTaskStyles()
})
