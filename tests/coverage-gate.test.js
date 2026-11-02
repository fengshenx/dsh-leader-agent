import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { evaluateCoverage, formatCoverageRow, parseCoverageTable } from '../scripts/coverage-gate.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'scripts', 'coverage-manifest.json'), 'utf8'))

/** 真实报告的形状：目录树缩进 + 无读数的目录行 + 表头与分隔线 + all files 汇总。 */
const SAMPLE = [
  '✔ 某条测试 (0.5ms)',
  'ℹ file            | line % | branch % | funcs % | uncovered lines',
  'ℹ ----------------------------------------------------------------',
  'ℹ scripts         |        |          |         | ',
  'ℹ  doc-budget.mjs | 100.00 |   100.00 |  100.00 | ',
  'ℹ src             |        |          |         | ',
  'ℹ  host           |        |          |         | ',
  'ℹ   dispatch.js   |  97.14 |    83.27 |   94.44 | 153-154 212-213',
  'ℹ  shared         |        |          |         | ',
  'ℹ   projects.js   | 100.00 |   100.00 |  100.00 | ',
  'ℹ ----------------------------------------------------------------',
  'ℹ all files       |  35.61 |    98.73 |   13.91 | ',
  'ℹ end of coverage report',
].join('\n')

/**
 * 构造一次判定输入：默认门槛与豁免都为空。
 *
 * @param {object} overrides - 覆盖项
 * @param {Record<string, number>} [overrides.lines] - 路径 → 行覆盖
 * @param {string[]} [overrides.sources] - 源文件枚举
 * @param {object} [overrides.manifest] - 清单
 * @returns {{ rows: object[], problems: object[], raises: object[] }} 判定结果
 */
function judge({ lines = {}, sources = Object.keys(lines), manifest: custom = {} }) {
  const report = new Map(
    Object.entries(lines).map(([path, value]) => [
      path,
      { path, lines: value, branches: 100, functions: 100, uncovered: '' },
    ]),
  )
  return evaluateCoverage({ report, sources, manifest: custom })
}

test('解析：按目录树缩进还原完整路径，跳过表头、分隔线与 all files', () => {
  const report = parseCoverageTable(SAMPLE)
  assert.deepEqual([...report.keys()], ['scripts/doc-budget.mjs', 'src/host/dispatch.js', 'src/shared/projects.js'])
  assert.equal(report.get('src/host/dispatch.js').lines, 97.14)
  assert.equal(report.get('src/host/dispatch.js').uncovered, '153-154 212-213')
})

test('解析：非表格输出与空行不影响结果', () => {
  assert.equal(parseCoverageTable('✔ 某条测试\nℹ tests 900\nℹ pass 891\n').size, 0)
})

test('判定：报告里没有、清单里也没有的文件直接红', () => {
  const { problems } = judge({ lines: {}, sources: ['src/client/board.js'] })
  assert.equal(problems.length, 1)
  assert.match(problems[0].message, /豁免清单/)
})

test('判定：新文件默认要求 100%，登记门槛后按门槛判', () => {
  assert.equal(judge({ lines: { 'src/a.js': 99 } }).problems.length, 1)
  const allowed = judge({
    lines: { 'src/a.js': 95 },
    manifest: { thresholds: { 'src/a.js': { lines: 95, reason: '存量欠账' } } },
  })
  assert.deepEqual(allowed.problems, [])
})

test('判定：低于登记门槛是红的', () => {
  const { problems } = judge({
    lines: { 'src/a.js': 94 },
    manifest: { thresholds: { 'src/a.js': { lines: 95, reason: '存量欠账' } } },
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0].message, /低于门槛 95%/)
})

test('判定：高出门槛 1 个百分点以上提示抬高，不视为失败', () => {
  const result = judge({
    lines: { 'src/a.js': 97.4 },
    manifest: { thresholds: { 'src/a.js': { lines: 95, reason: '存量欠账' } } },
  })
  assert.deepEqual(result.problems, [])
  assert.equal(result.raises.length, 1)
  assert.match(result.raises[0].message, /抬到 97/)
})

test('判定：登记为不可加载却出现在报告里是红的（清单过期）', () => {
  const { problems } = judge({
    lines: { 'src/a.js': 100 },
    manifest: { unmeasured: { 'src/a.js': '组件' } },
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0].message, /删掉这条豁免/)
})

test('判定：清单里的路径在 src 下不存在是红的（改名或删除后漏改清单）', () => {
  const { problems } = judge({
    sources: [],
    manifest: {
      unmeasured: { 'src/gone.js': '组件' },
      thresholds: { 'src/also-gone.js': { lines: 90, reason: '存量欠账' } },
    },
  })
  const paths = new Set(problems.map((problem) => problem.path))
  assert.deepEqual([...paths].sort(), ['src/also-gone.js', 'src/gone.js'])
})

test('判定：豁免与门槛都必须写理由，门槛是 0-100 的整数', () => {
  const { problems } = judge({
    lines: { 'src/a.js': 100, 'src/b.js': 90 },
    sources: ['src/a.js', 'src/b.js'],
    manifest: {
      unmeasured: { 'src/a.js': '  ' },
      thresholds: { 'src/b.js': { lines: 90.5, reason: '存量欠账' } },
    },
  })
  assert.ok(problems.some((problem) => /豁免必须写明理由/.test(problem.message)))
  assert.ok(problems.some((problem) => /0-100 的整数/.test(problem.message)))
  // a.js 出现在报告里，豁免同时被判过期
  assert.ok(problems.some((problem) => /删掉这条豁免/.test(problem.message)))
})

test('判定：登记了门槛但文件没被加载，提示改登记到 unmeasured', () => {
  const { problems } = judge({
    sources: ['src/a.js'],
    manifest: { thresholds: { 'src/a.js': { lines: 90, reason: '存量欠账' } } },
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0].message, /没被任何单测加载/)
})

test('输出行：状态、读数、门槛与路径', () => {
  const low = formatCoverageRow({ path: 'src/a.js', status: 'below', lines: 94.2, min: 95 })
  assert.match(low, /^LOW\s+94\.20% \/ 95\s*% src\/a\.js$/)
  const skipped = formatCoverageRow({ path: 'src/a.js', status: 'unmeasured', lines: null, min: null })
  assert.match(skipped, /^SKIP\s+—% \/ —\s*% src\/a\.js$/)
})

test('真实清单：路径都在 src 下且存在，豁免与门槛都写了理由', () => {
  for (const path of Object.keys(manifest.unmeasured)) {
    assert.ok(path.startsWith('src/'), `${path} 不在 src 下，覆盖率门禁只判 src`)
    assert.ok(existsSync(join(root, path)), `${path} 不存在，改名或删除时同步 scripts/coverage-manifest.json`)
    assert.ok(manifest.unmeasured[path].trim() !== '', `${path} 的豁免理由不能为空`)
  }
  for (const [path, entry] of Object.entries(manifest.thresholds)) {
    assert.ok(path.startsWith('src/'), `${path} 不在 src 下，覆盖率门禁只判 src`)
    assert.ok(existsSync(join(root, path)), `${path} 不存在，改名或删除时同步 scripts/coverage-manifest.json`)
    assert.ok(Number.isInteger(entry.lines) && entry.lines >= 0 && entry.lines <= 100, `${path} 的门槛必须是 0-100 的整数`)
    assert.ok(entry.reason.trim() !== '', `${path} 的门槛理由不能为空`)
  }
})

test('真实清单：同一文件不会既登记豁免又登记门槛', () => {
  const both = Object.keys(manifest.unmeasured).filter((path) => manifest.thresholds[path] !== undefined)
  assert.deepEqual(both, [])
})
