/**
 * e2e 运行器：单场景、全量 fail-fast 与全量报告三种模式。
 *
 * `e2e` 是 CI 语义：第一个失败立刻停，后面的场景不再占机器时间；`e2e:report`
 * 是本地诊断语义：逐个跑到最后，打印 PASS/FAIL 与失败文件，但不重试、不并行。
 * `e2e:one` 只跑一个文件，截图目录保留在 `.dev/e2e-artifacts/`。
 *
 * 每个场景仍单独起一个 `node --test` 进程：既保持现有夹具的进程隔离，也让
 * fail-fast 的退出码能准确落到当前文件。
 *
 * @module dsh-leader-agent/scripts/e2e-run
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnCommandSync } from './spawn-command.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const E2E_DIR = join(ROOT, 'tests', 'e2e')
const ARTIFACTS_DIR = join(ROOT, '.dev', 'e2e-artifacts')
const MODES = new Set(['one', 'fail-fast', 'report'])

/** 打印用法并退出 2。 */
function usage() {
  console.error('用法：node scripts/e2e-run.mjs <one|fail-fast|report> [--files <场景...>]')
  console.error('  one <场景>       只跑一个场景；场景名可省略 tests/e2e/ 前缀与 .e2e.js 后缀')
  console.error('  fail-fast        按文件顺序跑全部，第一个失败立刻退出（CI）')
  console.error('  report           按文件顺序跑全部，不中断，最后汇总；有失败退出 1')
  console.error('  --files <场景...> 只对 fail-fast/report 有效：只跑列出的场景，用于拆并发或小集合验证')
  process.exit(2)
}

/** 失败即退出；运行器自己的参数/环境错误不伪装成场景失败。 */
function fail(message) {
  console.error(`[e2e] ${message}`)
  process.exit(2)
}

/** 按文件名排序的 e2e 场景；一个文件就是一个独立进程。 */
function scenarios() {
  return readdirSync(E2E_DIR)
    .filter((name) => name.endsWith('.e2e.js'))
    .sort()
    .map((name) => join(E2E_DIR, name))
}

/** 单场景参数可以是路径，也可以是 `board-card-delete` 这种场景名。 */
function resolveScenario(arg) {
  const direct = resolve(ROOT, arg)
  if (existsSync(direct)) return direct
  const name = arg.endsWith('.e2e.js') ? arg : `${arg}.e2e.js`
  const named = join(E2E_DIR, name)
  if (existsSync(named)) return named
  fail(`找不到场景：${arg}；给 tests/e2e/*.e2e.js 路径或场景名`)
}

/** 场景必须直接位于 tests/e2e/，避免把任意文件交给 `node --test`。 */
function assertScenario(file) {
  if (dirname(file) !== E2E_DIR || !file.endsWith('.e2e.js') || !statSync(file).isFile()) {
    fail(`不是 tests/e2e 下的 .e2e.js 场景：${file}`)
  }
}

/** 单跑入口先构建；直接调用 runner 时把缺产物说清楚，不让它退化成全线等待超时。 */
function assertBuilt() {
  if (!existsSync(join(ROOT, 'lib', 'client.js'))) {
    fail('lib/client.js 不存在：先用 `npm run e2e:one`/`npm run e2e`（两者都会构建）或 `npm run build:client`')
  }
}

/** 当前截图目录，用来在单场景结束后只报告本次新建的目录。 */
function artifactDirs() {
  if (!existsSync(ARTIFACTS_DIR)) return []
  return readdirSync(ARTIFACTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(ARTIFACTS_DIR, entry.name))
}

/** 跑一个文件并保留它的完整输出；返回状态供汇总。 */
function runScenario(file) {
  const label = relative(ROOT, file)
  console.log(`\n[e2e] ▶ ${label}`)
  const started = Date.now()
  let result
  try {
    result = spawnCommandSync({
      command: process.execPath,
      args: ['--test', file],
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    })
  } catch (error) {
    const ms = Date.now() - started
    const seconds = (ms / 1000).toFixed(1)
    console.error(`[e2e] ✖ ${label}：起不了 node --test（${error.message}）`)
    return { label, ok: false, seconds, detail: error.message }
  }
  const ms = Date.now() - started
  const seconds = (ms / 1000).toFixed(1)
  if (result.error !== undefined) {
    console.error(`[e2e] ✖ ${label}：起不了 node --test（${result.error.message}）`)
    return { label, ok: false, seconds, detail: result.error.message }
  }
  if (result.signal !== null) {
    console.error(`[e2e] ✖ ${label}：被信号 ${result.signal} 终止`)
    return { label, ok: false, seconds, detail: `signal ${result.signal}` }
  }
  if (result.status === 0) {
    console.log(`[e2e] ✔ ${label}（${seconds}s）`)
    return { label, ok: true, seconds }
  }
  console.error(`[e2e] ✖ ${label}（${seconds}s，exit ${result.status}）`)
  return { label, ok: false, seconds, detail: `exit ${result.status}` }
}

/** 单场景：只跑一个文件；成功后打印本次新增的截图目录。 */
function runOne(file) {
  const before = new Set(artifactDirs())
  const result = runScenario(file)
  const created = artifactDirs().filter((dir) => !before.has(dir))
  if (created.length > 0) {
    for (const dir of created) console.log(`[e2e:one] 取证目录 ${relative(ROOT, dir)}`)
  } else {
    console.log('[e2e:one] 没有发现新取证目录（可能失败在截图前，先看上面的断言/读数）')
  }
  process.exit(result.ok ? 0 : 1)
}

/** fail-fast：CI 语义；第一个失败立刻停，不跑后续场景。 */
function runFailFast(files) {
  console.log(`[e2e] ${files.length} 个场景，fail-fast（CI 语义）`)
  for (const file of files) {
    const result = runScenario(file)
    if (!result.ok) {
      console.error('[e2e] 已按 fail-fast 停止；后续场景未运行')
      process.exit(1)
    }
  }
  console.log(`[e2e] PASS ${files.length}/${files.length}（fail-fast）`)
}

/** report：逐个跑到最后，汇总失败文件；有失败退出 1，不重试、不并行。 */
function runReport(files) {
  console.log(`[e2e:report] ${files.length} 个场景，逐个跑、不中断（不重试、不并行）`)
  const results = files.map((file) => runScenario(file))
  const failed = results.filter((result) => !result.ok)
  const passed = results.length - failed.length
  console.log(`\n[e2e:report] 汇总：PASS ${passed} / ${results.length}，FAIL ${failed.length} / ${results.length}`)
  if (failed.length > 0) {
    console.error('[e2e:report] 失败文件：')
    for (const result of failed) console.error(`  - ${result.label}（${result.seconds}s，${result.detail}）`)
    console.error('[e2e:report] 先看场景 stdout 的截图行与 .dev/e2e-artifacts/ 下的 final.png；单跑用 e2e:one，登记 flake 后再追根因')
    process.exit(1)
  }
  console.log('[e2e:report] 全部通过；取证目录见各场景 stdout 的截图行')
}

/** 全量/报告允许 `--files` 缩小到调用方列出的小集合；one 直接用位置参数。 */
function selectedScenarios(args) {
  if (args.length === 0) return scenarios()
  if (args[0] !== '--files' || args.length < 2) usage()
  const files = args.slice(1).map((arg) => {
    const file = resolveScenario(arg)
    assertScenario(file)
    return file
  })
  return [...new Set(files)]
}

const mode = process.argv[2]
const args = process.argv.slice(3).filter((arg) => arg !== '--')
if (!MODES.has(mode)) usage()
if (mode === 'one' && args[0] === '--files') usage()
assertBuilt()
if (mode === 'one') {
  if (args.length !== 1) usage()
  const file = resolveScenario(args[0])
  assertScenario(file)
  runOne(file)
} else {
  const files = selectedScenarios(args)
  if (files.length === 0) fail('tests/e2e 下没有 .e2e.js 场景')
  if (mode === 'fail-fast') runFailFast(files)
  else runReport(files)
}
