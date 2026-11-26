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

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBudgets, countDocUnits, findUnregisteredDocs, formatBudgetRow, headroomPercent } from './doc-budget.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifestPath = resolve(root, 'scripts/doc-budgets.json')

/** 长期文档的枚举范围：根目录与 docs/ 只看一层。 */
const STANDING_DOC_DIRS = [root, join(root, 'docs')]

/**
 * 需要递归枚举的文档树：growing/ 的案例文档在 `<date-slug>/` 子目录里。
 * 不枚举就会留下一条旁路——在这些目录里写长文档可以绕过整套预算。
 */
const STANDING_DOC_TREES = [join(root, 'growing')]

/**
 * 列出目录下一层的 Markdown 文件。
 * @param {string} dir - 绝对目录
 * @returns {string[]} 仓内相对路径
 */
function markdownAt(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => relative(root, join(dir, entry.name)))
}

/**
 * 递归列出目录树下的 Markdown 文件。
 * @param {string} dir - 绝对目录
 * @returns {string[]} 仓内相对路径
 */
function markdownTree(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) return markdownTree(abs)
    return entry.isFile() && entry.name.endsWith('.md') ? [relative(root, abs)] : []
  })
}

/**
 * 列出枚举范围内的 Markdown 文件。
 * @returns {string[]} 仓内相对路径
 */
function standingDocs() {
  return [...STANDING_DOC_DIRS.flatMap(markdownAt), ...STANDING_DOC_TREES.flatMap(markdownTree)]
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const listOnly = process.argv.includes('--list')

/**
 * 清单项既支持纯数字天花板，也支持 `{ ceiling, minHeadroom }` 的专项下限。
 *
 * @param {number | { ceiling?: number, minHeadroom?: number }} config - 清单值
 * @returns {{ ceiling: number | undefined, minHeadroom: number | undefined }} 归一化后的配置
 */
function readConfig(config) {
  if (typeof config === 'number') return { ceiling: config, minHeadroom: undefined }
  if (config !== null && typeof config === 'object') {
    return { ceiling: config.ceiling, minHeadroom: config.minHeadroom }
  }
  return { ceiling: config, minHeadroom: undefined }
}

const entries = Object.entries(manifest).map(([path, config]) => {
  const abs = resolve(root, path)
  const { ceiling, minHeadroom } = readConfig(config)
  return {
    path: relative(root, abs),
    ceiling,
    minHeadroom,
    units: existsSync(abs) ? countDocUnits(readFileSync(abs, 'utf8')) : null,
  }
})

const results = checkBudgets(entries)
for (const result of results) console.log(formatBudgetRow(result))

const unregistered = findUnregisteredDocs(Object.keys(manifest), standingDocs())
for (const path of unregistered) console.log(`UNREG  ${'—'.padStart(6)} / ${'—'.padEnd(6)} ${path}`)

if (listOnly) process.exit(0)

const small = results.filter((result) => result.status === 'small')
const special = results.filter((result) => result.status !== 'small' && result.minHeadroom > 5)
const failures = results.filter((result) => result.status !== 'ok' && result.status !== 'small')
if (failures.length === 0 && unregistered.length === 0) {
  if (small.length === 0 && special.length === 0) {
    console.log(`verify-doc-budgets: ${results.length} 篇 standing docs 都在 5–12% 余量内`)
  } else {
    const notes = []
    if (small.length > 0) notes.push(`${small.length} 篇 <9 单位豁免下界`)
    if (special.length > 0) {
      const percents = [...new Set(special.map((result) => result.minHeadroom))].sort((a, b) => a - b)
      notes.push(`${special.length} 篇另需 ≥${percents.join('/')}% 余量`)
    }
    console.log(`verify-doc-budgets: ${results.length} 篇 standing docs 通过；${notes.join('；')}，其余在 5–12% 余量内`)
  }
  process.exit(0)
}

console.error(`\nverify-doc-budgets: ${failures.length + unregistered.length} 项未通过：`)
for (const path of unregistered) {
  console.error(`  ${path}: 没有登记在 scripts/doc-budgets.json——新增长期文档要连同天花板一起登记（按当前值留余量，见 AGENTS.md 的分层节）`)
}
for (const failure of failures) {
  if (failure.status === 'over') {
    console.error(`  ${failure.path}: ${failure.units} 个单位超过天花板 ${failure.ceiling}——按 AGENTS.md 先搬到对的层，再压缩；抬天花板要在 PR 里写明理由`)
  } else if (failure.status === 'loose') {
    console.error(`  ${failure.path}: 天花板 ${failure.ceiling} 高于当前值 ${failure.units} 的 12%——按当前值重设（建议 ${failure.suggestedCeiling}），不要留没有约束力的余量`)
  } else if (failure.status === 'tight-special') {
    const action = failure.maxUnits === undefined
      ? `抬天花板到 ${failure.suggestedCeiling}`
      : `压缩到 ${failure.maxUnits} 个单位，或抬天花板到 ${failure.suggestedCeiling}（二选一）`
    console.error(`  ${failure.path}: 余量 ${headroomPercent(failure.units, failure.ceiling, failure.minHeadroom)}% 低于该文档要求的 ${failure.minHeadroom}%——${action}；抬天花板要在 PR 里写明为什么`)
  } else if (failure.status === 'tight') {
    const action = failure.maxUnits === undefined
      ? `抬天花板到 ${failure.suggestedCeiling}`
      : `压缩到 ${failure.maxUnits} 个单位，或抬天花板到 ${failure.suggestedCeiling}（二选一）`
    console.error(`  ${failure.path}: 余量 ${headroomPercent(failure.units, failure.ceiling, failure.minHeadroom)}% 低于 5%——${action}；抬天花板要在 PR 里写明为什么`)
  } else if (failure.status === 'missing') {
    console.error(`  ${failure.path}: 清单里的文件不存在（改名或删除了？同一次改动里更新 scripts/doc-budgets.json）`)
  } else {
    console.error(`  ${failure.path}: 天花板必须是正整数，当前是 ${failure.ceiling}`)
  }
}
if (small.length > 0) {
  console.error(`  另有 ${small.length} 篇 <9 单位小文档豁免下界：${small.map((result) => result.path).join('、')}`)
}
process.exit(1)
