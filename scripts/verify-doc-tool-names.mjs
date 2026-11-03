/**
 * 注入给会话的文档里，工具名必须真实注册。判定逻辑在 doc-tool-names.mjs，这里
 * 只读盘、取真实工具名与报数。
 *
 * 扫描面只覆盖会进会话提示词的三处：SLOTS.md、LEADER.md、以及两个 skill 目录
 * （`.agents/skills/**`、`.telov/skills/**`）下的 Markdown。README 与 docs/ 是给人
 * 读的，`.agents/notes/` 里还记着已删工具的历史，都不扫。
 *
 * 规则与理由见 AGENTS.md 的「提交与 PR」一节。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { documentedToolNames } from '../src/host/index.js'
import { PROMPT_DOCS, PROMPT_SKILLS_DIRS, scanToolNames } from './doc-tool-names.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

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

const docs = [
  ...PROMPT_DOCS.map((name) => join(root, name)),
  ...PROMPT_SKILLS_DIRS.flatMap((dir) => markdownFiles(join(root, dir))).sort(),
]

const known = new Set(documentedToolNames())

const problems = docs.flatMap((file) => {
  const { violations, unclosedFence } = scanToolNames(readFileSync(file, 'utf8'), known)
  const path = relative(root, file)
  const found = violations.map(({ line, name }) => `${path}:${line}: \`${name}\` 不是已注册的工具名`)
  if (unclosedFence !== undefined) {
    found.push(`${path}:${unclosedFence}: 代码围栏没有闭合，后面的内容没被校验`)
  }
  return found
})

if (problems.length === 0) {
  console.log(`verify-doc-tool-names: ${docs.length} 篇文档的工具名全部存在`)
  process.exit(0)
}

console.error('verify-doc-tool-names: 文档门禁未通过：')
for (const problem of problems) console.error(`  ${problem}`)
process.exit(1)
