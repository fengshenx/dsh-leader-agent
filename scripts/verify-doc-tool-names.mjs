/**
 * 注入给会话的文档里，工具名必须真实注册。判定逻辑在 doc-tool-names.mjs，这里
 * 只读盘、取真实工具名与报数。
 *
 * 扫描面只覆盖会进会话提示词的三处：SLOTS.md、COORDINATOR.md、skills/**\/*.md。
 * README 与 docs/ 是给人读的，`.agents/notes/` 里还记着已删工具的历史，都不扫。
 *
 * 规则与理由见 AGENTS.md 的「提交与 PR」一节。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBundleTools } from '../src/host/index.js'
import { COORDINATOR_UNUSABLE_TOOLS } from '../src/host/tools/gate.js'
import { PROMPT_DOCS, PROMPT_SKILLS_DIR, unknownToolNames } from './doc-tool-names.mjs'

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
  ...markdownFiles(join(root, PROMPT_SKILLS_DIR)).sort(),
]

// 工具名两处取，都是登记处、不是副本：本 bundle 注册的（装配列表）与宿主提供、
// 本仓文档会引用的三件（`COORDINATOR_UNUSABLE_TOOLS` 就是这份登记）。宿主三件
// 不在本 bundle 的注册面上，门禁只能验到「文档与本仓登记一致」。
const known = new Set([
  ...createBundleTools().map((tool) => tool.name),
  ...COORDINATOR_UNUSABLE_TOOLS,
])

const violations = docs.flatMap((file) =>
  unknownToolNames(readFileSync(file, 'utf8'), known)
    .map(({ line, name }) => `${relative(root, file)}:${line}: \`${name}\` 不是已注册的工具名`),
)

if (violations.length === 0) {
  console.log(`verify-doc-tool-names: ${docs.length} 篇文档的工具名全部存在`)
  process.exit(0)
}

console.error('verify-doc-tool-names: 文档引用了不存在的工具：')
for (const violation of violations) console.error(`  ${violation}`)
process.exit(1)
