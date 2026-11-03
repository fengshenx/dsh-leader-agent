import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROMPT_DOCS, PROMPT_SKILLS_DIR, scanToolNames } from '../scripts/doc-tool-names.mjs'
import { documentedToolNames } from '../src/host/index.js'

const root = fileURLToPath(new URL('../', import.meta.url))

const registered = new Set(['spawn_worker', 'message_worker'])

/**
 * 递归列出目录下的 Markdown 文件。
 * @param {string} dir - 目录绝对路径
 * @returns {string[]} 文件绝对路径
 */
function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.name.endsWith('.md') ? [path] : []
  })
}

/**
 * 只取违规引用，围栏配对的用例单独断言。
 * @param {string} text - 文档全文
 * @returns {{line: number, name: string}[]} 违规引用
 */
function violationsOf(text) {
  return scanToolNames(text, registered).violations
}

test('已注册的工具名不报', () => {
  assert.deepEqual(violationsOf('用 `spawn_worker` 派工'), [])
})

test('不存在的工具名报出所在行', () => {
  const text = '# 标题\n\n当轮结束调用 `worker_done` 交作业。\n'
  assert.deepEqual(violationsOf(text), [{ line: 3, name: 'worker_done' }])
})

test('一行里的多个未知工具名逐个报', () => {
  const text = '用 `worker_done` 与 `done_worker` 两个工具。\n'
  assert.deepEqual(violationsOf(text), [
    { line: 1, name: 'worker_done' },
    { line: 1, name: 'done_worker' },
  ])
})

test('工具清单那种没有「调/用」字样的行也校验', () => {
  const text = '| 动作 | 工具 |\n|---|---|\n| 派工 | `spawn_worker` |\n| 交作业 | `worker_done` |\n'
  assert.deepEqual(violationsOf(text), [{ line: 4, name: 'worker_done' }])
})

test('文件名、命令与 camelCase 字段不参与比对', () => {
  const text = '改完跑 `npm run check`，再看 `src/host/index.js` 与 `cardId` 的映射，用 `dev-plan.mjs` 校对。\n'
  assert.deepEqual(violationsOf(text), [])
})

test('围栏代码块里的内容不扫', () => {
  const text = '示例：\n\n```js\n用 `worker_done` 交作业\n```\n\n围栏结束后照旧：用 `worker_done`。\n'
  assert.deepEqual(violationsOf(text), [{ line: 7, name: 'worker_done' }])
})

test('围栏没闭合时报出错位置，不静默跳过后半篇', () => {
  const text = '# 标题\n\n```js\n用 `worker_done` 交作业\n'
  assert.deepEqual(scanToolNames(text, registered), { violations: [], unclosedFence: 3 })
})

test('门禁的已知集合只来自 documentedToolNames，不碰 gate.js', () => {
  const names = documentedToolNames()
  for (const name of ['spawn_worker', 'message_worker', 'create_card', 'update_card', 'list_cards']) {
    assert.ok(names.includes(name), `${name} 应在文档可引用的工具名里`)
  }

  // 正向断言来源，而不是「不含某个名字」：只查一个符号名的话，改成 import
  // `HOST_SUBAGENT_TOOLS`、甚至把数组字面量抄进门禁，都能照样全绿。
  const source = readFileSync(join(root, 'scripts/verify-doc-tool-names.mjs'), 'utf8')
  const imports = [...source.matchAll(/^import\s+(.+?)\s+from\s+'([^']+)'/gm)].map(([, , path]) => path)
  assert.ok(imports.includes('../src/host/index.js'), '门禁要从宿主装配处取工具名')
  assert.ok(source.includes('documentedToolNames'), '门禁要用 documentedToolNames()，不要自己拼集合')
  assert.ok(
    !imports.some((path) => path.endsWith('/gate.js')),
    '门禁不该 import gate.js 的任何符号：那份名单的变化理由是「leader 能不能用」',
  )
  for (const name of ['HOST_SUBAGENT_TOOLS', 'list_agents', 'send_message', 'interrupt_agent']) {
    assert.ok(!source.includes(name), `门禁里不该出现 ${name}：那是 gate.js 的符号或宿主工具名的副本`)
  }
})

test('仓库里注入会话的文档零误报', () => {
  const known = new Set(documentedToolNames())
  const docs = [
    ...PROMPT_DOCS.map((name) => join(root, name)),
    ...markdownFiles(join(root, PROMPT_SKILLS_DIR)),
  ]
  for (const file of docs) {
    const { violations, unclosedFence } = scanToolNames(readFileSync(file, 'utf8'), known)
    assert.deepEqual(violations, [], `${file} 引用了不存在的工具名`)
    assert.equal(unclosedFence, undefined, `${file} 的代码围栏没闭合`)
  }
})
