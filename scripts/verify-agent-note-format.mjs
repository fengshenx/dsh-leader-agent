/**
 * `.agents/notes/` 的格式门禁。判定逻辑在 agent-note-format.mjs，读盘与输出在 agent-note-audit.mjs，
 * 这里只把结果写到终端并给退出码。规则与理由见 AGENTS.md 的「提交与 PR」一节。
 */

import { fileURLToPath } from 'node:url'
import { auditNotes, auditReport } from './agent-note-audit.mjs'

const noteDir = fileURLToPath(new URL('../.agents/notes/', import.meta.url))

const report = auditReport(auditNotes(noteDir))

for (const line of report.lines) {
  if (report.stream === 'error') console.error(line)
  else console.log(line)
}
process.exit(report.exitCode)
