/**
 * 语法检查门禁：`index.js` 与 `src` / `scripts` / `build` 下的 `.js` / `.mjs` 逐个过
 * `node --check`。
 *
 * 原先是 `package.json` 里的一段 POSIX shell 循环（`for f in … $(find …)`），Windows 的
 * cmd 下直接报 `f was unexpected at this time`，本地跑不了 `npm run check`。
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const ENTRIES = ['index.js', 'src', 'scripts', 'build']
const EXTENSIONS = ['.js', '.mjs']

/**
 * 递归列出目录下的脚本文件。
 * @param {string} dir - 目录绝对路径
 * @returns {string[]} 文件绝对路径
 */
function scriptFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return scriptFiles(path)
    return EXTENSIONS.some((ext) => entry.name.endsWith(ext)) ? [path] : []
  })
}

const files = ENTRIES.flatMap((entry) => {
  const path = join(root, entry)
  return statSync(path).isDirectory() ? scriptFiles(path) : [path]
}).sort()

const failures = files.flatMap((file) => {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status === 0) return []
  return [{ file: relative(root, file), output: (result.stderr || result.stdout || '').trim() }]
})

if (failures.length === 0) {
  console.log(`check-syntax: ${files.length} 个文件通过 node --check`)
  process.exit(0)
}

console.error('check-syntax: 语法检查未通过：')
for (const { file, output } of failures) {
  console.error(`  ${file}`)
  for (const line of output.split('\n').filter((text) => text.trim() !== '')) console.error(`    ${line}`)
}
process.exit(1)
