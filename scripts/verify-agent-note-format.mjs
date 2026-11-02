/**
 * `.agents/notes/` 的格式门禁。判定逻辑在 agent-note-format.mjs，这里只读盘与报数。
 * 规则与理由见 AGENTS.md 的「提交与 PR」一节。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkNote } from './agent-note-format.mjs'

const noteDir = fileURLToPath(new URL('../.agents/notes/', import.meta.url))

const names = readdirSync(noteDir)
  .filter(name => name.endsWith('.md'))
  .sort()

const violations = names.flatMap(name =>
  checkNote(name, readFileSync(join(noteDir, name), 'utf8')).map(violation => `${name} — ${violation}`),
)

if (violations.length === 0) {
  console.log(`verify-agent-note-format: ${names.length} 篇笔记格式合规`)
  process.exit(0)
}

console.error('verify-agent-note-format: 格式违规：')
for (const violation of violations) console.error(`  ${violation}`)
process.exit(1)
