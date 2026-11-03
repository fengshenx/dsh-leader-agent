/**
 * `.agents/notes/` 的格式门禁。判定逻辑在 agent-note-format.mjs，读盘在 agent-note-audit.mjs，
 * 这里只报数与退出码。规则与理由见 AGENTS.md 的「提交与 PR」一节。
 */

import { fileURLToPath } from 'node:url'
import { auditNotes } from './agent-note-audit.mjs'
import { LIFECYCLES } from './agent-note-format.mjs'

const noteDir = fileURLToPath(new URL('../.agents/notes/', import.meta.url))

const { notes, violations } = auditNotes(noteDir)

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
