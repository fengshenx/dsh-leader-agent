/**
 * 覆盖率门禁：跑全部单测，按 `scripts/coverage-manifest.json` 判 per-file 行覆盖。
 *
 * 分母来自 `src` 目录枚举而不是覆盖率报告：Node 只统计被加载过的文件，漏掉的文件
 * 不会算 0%，也就不会变红——这正是「覆盖率好看但三成代码没测」的来路。新增 `src`
 * 下任何一个 `.js` 都必须出现在报告里，或在清单的 `unmeasured` 里写明为什么测不到。
 *
 * 未登记门槛的文件默认要求 100%（宿主 CI 的同一口径：它 gate 的每个 package 的
 * src 都要求 per-file 100%）。存量欠账按整数登记在 `thresholds`，覆盖率掉到门槛
 * 以下即红，涨出门槛就提示抬高。
 *
 * 用法：
 *   node scripts/verify-coverage.mjs          # 跑测试并判定，未通过退出 1
 *   node scripts/verify-coverage.mjs --list   # 跑测试，只列读数与提示
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateCoverage, formatCoverageRow, parseCoverageTable } from './coverage-gate.mjs'
import { spawnCommand } from './spawn-command.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const SOURCE_DIR = 'src'
const manifestPath = join(root, 'scripts', 'coverage-manifest.json')
const listOnly = process.argv.includes('--list')

/**
 * 列出目录下所有 `.js` 文件（仓内相对 POSIX 路径）。
 *
 * @param {string} dir - 绝对目录路径
 * @returns {string[]} 仓内相对路径，按字典序
 */
function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return jsFiles(path)
      return entry.name.endsWith('.js') ? [relative(root, path).split(sep).join('/')] : []
    })
    .sort()
}

/**
 * 跑全部单测并收集输出。
 *
 * 不开 `--test-reporter`：指定自定义 reporter 时 Node 不打印覆盖率表格（实测
 * `--test-reporter=dot` 只有测试输出），门禁必须用默认的 spec reporter。
 *
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>} 退出码与输出
 */
function runTests() {
  const testFiles = readdirSync(join(root, 'tests'))
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => join(root, 'tests', name))
  return new Promise((resolve, reject) => {
    // 起 node 自身（绝对路径），不需要 spawn-command 的 Windows shim 解析，但走同一入口
    // 是 scripts/ 的选择：直接引 node:child_process 会被 tests/spawn-command-usage.test.js 拦下。
    const child = spawnCommand({
      command: process.execPath,
      args: ['--test', '--experimental-test-coverage', ...testFiles],
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/**
 * 从 spec 输出里取测试计数。
 *
 * spec reporter 的输出被收集而没透传（900+ 行会淹掉门禁结论），失败时才打印尾部；
 * 成功时至少把用例数留在摘要里，否则 `npm run check` 看不出测试跑了多少。
 *
 * @param {string} text - 子进程 stdout
 * @returns {{ pass: number | null, skipped: number | null }} 通过与被跳过的用例数
 */
function testCounts(text) {
  const read = (label) => {
    const match = new RegExp(`^ℹ ${label} (\\d+)$`, 'm').exec(text)
    return match === null ? null : Number(match[1])
  }
  return { pass: read('pass'), skipped: read('skipped') }
}

/**
 * 打印输出末尾若干行——测试失败详情在末尾，全量打印会淹掉门禁自己的结论。
 *
 * @param {string} text - 待打印文本
 * @param {number} limit - 保留的行数
 * @returns {void} 无返回
 */
function printTail(text, limit = 120) {
  const lines = text.trimEnd().split('\n')
  const tail = lines.slice(-limit)
  console.error(tail.join('\n'))
  if (lines.length > limit) console.error(`（前面还有 ${lines.length - limit} 行输出未显示）`)
}

const run = await runTests()
if (run.code !== 0) {
  console.error(`verify-coverage: 单测未通过（退出码 ${run.code}），覆盖率门禁未执行。`)
  printTail(`${run.stdout}\n${run.stderr}`)
  process.exit(1)
}

const report = parseCoverageTable(run.stdout)
if (report.size === 0) {
  console.error('verify-coverage: 测试通过但没解析到覆盖率表格。')
  console.error('  解析窗口按 `start of coverage report` 与 `end of coverage report` 两个标记收边：两个都在却解不出表格才说明是覆盖率真的没了。')
  console.error('  缺标记时先怀疑 Node 改了报告文案（标记漂移），再怀疑 --test-reporter 抑制了表格。')
  printTail(run.stderr)
  process.exit(1)
}

const counts = testCounts(run.stdout)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const sources = jsFiles(join(root, SOURCE_DIR))
const { rows, problems, raises } = evaluateCoverage({ report, sources, manifest })

const measured = rows.filter((row) => row.status !== 'unmeasured' && row.status !== 'unloaded')
const perfect = measured.filter((row) => row.lines === 100).length
for (const row of rows.filter((item) => item.status !== 'ok' && item.status !== 'unmeasured')) {
  console.log(`${formatCoverageRow(row)}${row.uncovered === '' ? '' : `  未覆盖 ${row.uncovered}`}`)
}
for (const raise of raises) console.log(`RAISE ${raise.path}: ${raise.message}`)
console.log(
  `verify-coverage: ${counts.pass ?? '?'} 个用例通过（${counts.skipped ?? '?'} 跳过），` +
    `${sources.length} 个源文件，${measured.length} 个被单测加载（${perfect} 个行覆盖 100%），` +
    `${rows.filter((row) => row.status === 'unmeasured').length} 个登记为单测不可加载`,
)

if (listOnly) process.exit(0)

if (problems.length > 0) {
  console.error(`\nverify-coverage: ${problems.length} 项未通过：`)
  for (const problem of problems) console.error(`  ${problem.path}: ${problem.message}`)
  process.exit(1)
}
