/**
 * `.agents/notes/` 的格式门禁。判定逻辑在 agent-note-format.mjs，这里只读盘与报数。
 * 规则与理由见 AGENTS.md 的「提交与 PR」一节。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkLinks, checkNote, LIFECYCLES } from './agent-note-format.mjs'

const noteDir = fileURLToPath(new URL('../.agents/notes/', import.meta.url))

/** 根层这两份是目录说明，不是笔记。 */
const NON_NOTE = new Set(['README.md', 'AGENTS.md'])

/** @returns {string[]} 相对 `noteDir` 的 POSIX 路径 */
function collectNotes(dir, prefix = '') {
  const paths = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) paths.push(...collectNotes(join(dir, entry.name), relPath))
    else if (entry.name.endsWith('.md') && !(prefix === '' && NON_NOTE.has(entry.name))) paths.push(relPath)
  }
  return paths.sort()
}

const notes = collectNotes(noteDir)

const violations = notes.flatMap(relPath => {
  const file = join(noteDir, relPath)
  const text = readFileSync(file, 'utf8')
  const isReachable = url => existsSync(resolve(dirname(file), url.split('#')[0]))
  return [...checkNote(relPath, text), ...checkLinks(text, isReachable)].map(violation => `${relPath} — ${violation}`)
})

if (violations.length > 0) {
  console.error('verify-agent-note-format: 格式违规：')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}

const counts = LIFECYCLES.filter(lifecycle => notes.some(relPath => relPath.startsWith(`${lifecycle}/`)))
  .map(lifecycle => `${lifecycle} ${notes.filter(relPath => relPath.startsWith(`${lifecycle}/`)).length}`)
  .join(' / ')

console.log(`verify-agent-note-format: ${notes.length} 篇笔记格式合规（${counts}）`)
process.exit(0)
