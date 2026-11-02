/**
 * 语法检查门禁：`index.js` 与 `src` / `scripts` / `build` 下的 `.js` / `.mjs` 逐个过
 * `node --check`。
 *
 * 原先是 `package.json` 里的一段 POSIX shell 循环（`for f in … $(find …)`），Windows 的
 * cmd 下直接报 `f was unexpected at this time`，本地跑不了 `npm run check`。
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const ENTRIES = ['index.js', 'src', 'scripts', 'build']
const EXTENSIONS = ['.js', '.mjs']

/**
 * 是否是目录，跟随符号链接。
 *
 * @param {string} path - 路径
 * @returns {boolean} 是否是目录
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    // 断裂的符号链接不指向任何目录，交给扩展名判断处理。
    return false
  }
}

/** 已展开过的真实目录，防止成环的符号链接把递归带下去。 */
const visited = new Set()

/**
 * 递归列出目录下的脚本文件。
 *
 * 顶层与子层都跟随符号链接：`Dirent.isDirectory()` 不跟随，用它会让链接进来的目录
 * 被静默漏检。真实路径已展开过的目录不再进入。
 *
 * @param {string} dir - 目录绝对路径
 * @returns {string[]} 文件绝对路径
 */
function scriptFiles(dir) {
  const real = realpathSync(dir)
  if (visited.has(real)) return []
  visited.add(real)
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (isDirectory(path)) return scriptFiles(path)
    return EXTENSIONS.some((ext) => entry.name.endsWith(ext)) ? [path] : []
  })
}

const files = ENTRIES.flatMap((entry) => {
  const path = join(root, entry)
  return isDirectory(path) ? scriptFiles(path) : [path]
}).sort()

const failures = []
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  // spawn 自己就起不来（node 路径坏了、执行被拒）：每个文件都会撞同一条错，逐条重复
  // 没有信息量，直接报原因退出。
  if (result.error !== undefined) {
    console.error(`check-syntax: 起不了 ${process.execPath} --check：${result.error.message}`)
    process.exit(1)
  }
  if (result.status === 0) continue
  const output = (result.stderr || result.stdout || '').trim()
  failures.push({ file: relative(root, file), output: output === '' ? `node --check 退出码 ${result.status}，无输出` : output })
}

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
