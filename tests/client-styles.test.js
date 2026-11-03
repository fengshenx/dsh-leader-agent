import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ensureBoardStyles } from '../src/client/board-styles.js'
import { ensureWorkerReportStyles } from '../src/client/worker-report-styles.js'

/**
 * 造一个够用的 document 桩。
 *
 * 幂等判重靠 `getElementById`，所以桩要像真实 DOM 一样记住已插入的节点——
 * 只记 append 次数会让「重复注入」这条断言永远成立。
 *
 * @returns {object[]} 已追加到 head 的节点
 */
function installDocument() {
  const head = []
  const byId = new Map()
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
  assert.equal(head[0].id, 'dsh-leader-kit-board')
  assert.match(head[0].textContent, /\.dsh-leader-kit-board/)
})

test('worker 回报样式表注入一次，重复调用不重复追加', () => {
  const head = installDocument()
  ensureWorkerReportStyles()
  ensureWorkerReportStyles()
  assert.equal(head.length, 1)
  assert.equal(head[0].id, 'dsh-leader-kit-worker-report')
  assert.match(head[0].textContent, /\.dsh-leader-kit-worker-report/)
})

test('没有 document 时直接返回，不抛错', () => {
  delete globalThis.document
  ensureBoardStyles()
  ensureWorkerReportStyles()
})
