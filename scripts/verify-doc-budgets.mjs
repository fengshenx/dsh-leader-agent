/**
 * 文档体量门禁：按 `scripts/doc-budgets.json` 的天花板检查 standing docs。
 *
 * 判定逻辑在 doc-budget.mjs，这里只读盘与报数。超出后先搬到对的层，再压缩，
 * 最后才抬天花板——分层与口径见 AGENTS.md 的「编辑本文件与文档分层」。
 *
 * 用法：
 *   node scripts/verify-doc-budgets.mjs          # 检查，超限退出 1
 *   node scripts/verify-doc-budgets.mjs --list   # 只列当前读数
 */

import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBudgets, countDocUnits, formatBudgetRow } from './doc-budget.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifestPath = resolve(root, 'scripts/doc-budgets.json')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const listOnly = process.argv.includes('--list')

const entries = Object.entries(manifest).map(([path, ceiling]) => {
  const abs = resolve(root, path)
  return {
    path: relative(root, abs),
    ceiling,
    units: existsSync(abs) ? countDocUnits(readFileSync(abs, 'utf8')) : null,
  }
})

const results = checkBudgets(entries)
for (const result of results) console.log(formatBudgetRow(result))

if (listOnly) process.exit(0)

const failures = results.filter((result) => result.status !== 'ok')
if (failures.length === 0) {
  console.log(`verify-doc-budgets: ${results.length} 篇 standing docs 都在天花板内`)
  process.exit(0)
}

console.error(`\nverify-doc-budgets: ${failures.length} 项未通过：`)
for (const failure of failures) {
  if (failure.status === 'over') {
    console.error(`  ${failure.path}: ${failure.units} 个单位超过天花板 ${failure.ceiling}——按 AGENTS.md 先搬到对的层，再压缩；抬天花板要在 PR 里写明理由`)
  } else if (failure.status === 'missing') {
    console.error(`  ${failure.path}: 清单里的文件不存在（改名或删除了？同一次改动里更新 scripts/doc-budgets.json）`)
  } else {
    console.error(`  ${failure.path}: 天花板必须是正整数，当前是 ${failure.ceiling}`)
  }
}
process.exit(1)
