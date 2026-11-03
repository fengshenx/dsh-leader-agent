import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkBudgets,
  countDocUnits,
  findUnregisteredDocs,
  formatBudgetRow,
  headroomOf,
  maxUnitsFor,
  recommendedCeiling,
} from '../scripts/doc-budget.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

/**
 * 列出某个目录下一层的 Markdown 文件。
 * @param {string} dir - 仓内相对目录，`.` 表示根
 * @returns {string[]} 仓内相对路径
 */
function markdownIn(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => (dir === '.' ? entry.name : `${dir}/${entry.name}`))
}

test('计数口径：CJK 逐字算 1，非 CJK 按空白分词', () => {
  assert.equal(countDocUnits(''), 0)
  assert.equal(countDocUnits('中文文档'), 4)
  assert.equal(countDocUnits('hello world'), 2)
  assert.equal(countDocUnits('中文 hello world'), 4)
  assert.equal(countDocUnits('中文\n\n另外一段'), 6)
})

test('计数口径：代码块、表格与标点一并计入', () => {
  // 围栏标记本身也是空白分词，代码块不会被白算
  assert.equal(countDocUnits('```sh\nnpm run check\n```'), 5)
  // CJK 先逐字计数再从分词输入里剔除：三个汉字 + 三个竖线
  assert.equal(countDocUnits('| 层 | 位置 |'), 6)
})

test('计数口径：大表格与长代码块按实际字符计', () => {
  const table = [
    '| 层 | 位置 | 职责 |',
    '|---|---|---|',
    ...Array.from({ length: 100 }, () => '| 宿主侧 | `src/host/` | 工具 |'),
  ].join('\n')
  assert.equal(countDocUnits(table), 1010)

  const code = ['```js', ...Array.from({ length: 50 }, () => 'const value = compute(input)'), '```'].join('\n')
  assert.equal(countDocUnits(code), 202)
})

test('判定：超限为 over，余量不足为 tight，两者都够为 ok', () => {
  const results = checkBudgets([
    { path: 'a.md', ceiling: 11, units: 10 },
    { path: 'b.md', ceiling: 10, units: 11 },
    { path: 'c.md', ceiling: 10, units: 10 },
  ])
  assert.deepEqual(
    results.map((result) => result.status),
    ['ok', 'over', 'tight'],
  )
})

test('余量：正好 5% 绿，4.99% 红', () => {
  const [ok] = checkBudgets([{ path: 'docs/a.md', ceiling: 10_500, units: 10_000 }])
  assert.equal(ok.status, 'ok')
  const [tight] = checkBudgets([{ path: 'docs/a.md', ceiling: 10_499, units: 10_000 }])
  assert.equal(tight.status, 'tight')
  assert.equal(tight.recommended, 10_500)
})

test('余量：AGENTS.md 与 capability-gaps 要求 10%，9.99% 红', () => {
  const ok = checkBudgets([
    { path: 'AGENTS.md', ceiling: 11_000, units: 10_000 },
    { path: 'docs/capability-gaps.md', ceiling: 11_000, units: 10_000 },
  ])
  assert.deepEqual(
    ok.map((result) => result.status),
    ['ok', 'ok'],
  )
  const [tight] = checkBudgets([{ path: 'AGENTS.md', ceiling: 10_999, units: 10_000 }])
  assert.equal(tight.status, 'tight')
  assert.equal(tight.recommended, 11_000)
})

test('余量：空文件任何正天花板都够，不除零', () => {
  const [result] = checkBudgets([{ path: 'docs/a.md', ceiling: 1, units: 0 }])
  assert.equal(result.status, 'ok')
  assert.equal(headroomOf({ units: 0, ceiling: 1 }), Number.POSITIVE_INFINITY)
})

test('余量：天花板非法时只报 bad-ceiling，不叠报 tight', () => {
  const results = checkBudgets([
    { path: 'AGENTS.md', ceiling: 0, units: 10 },
    { path: 'docs/a.md', ceiling: -5, units: 10 },
  ])
  assert.deepEqual(
    results.map((result) => result.status),
    ['bad-ceiling', 'bad-ceiling'],
  )
})

test('建议天花板与最大体量：抬到建议值恰好绿，少一个单位就红', () => {
  assert.equal(recommendedCeiling(10_000, 0.05), 10_500)
  assert.equal(recommendedCeiling(2_000, 0.1), 2_200)
  assert.equal(recommendedCeiling(0, 0.05), 0)
  assert.equal(maxUnitsFor(1_000, 0.05), 952)
  assert.equal(maxUnitsFor(2_200, 0.1), 2_000)

  for (const [units, headroom, path] of [
    [2_000, 0.05, 'docs/a.md'],
    [10_000, 0.1, 'AGENTS.md'],
    [1, 0.05, 'docs/a.md'],
    [7, 0.1, 'AGENTS.md'],
  ]) {
    const ceiling = recommendedCeiling(units, headroom)
    const [atCeiling] = checkBudgets([{ path, ceiling, units }])
    const [below] = checkBudgets([{ path, ceiling: ceiling - 1, units }])
    assert.equal(atCeiling.status, 'ok', `${units}/${ceiling} 应该够`)
    assert.equal(below.status, 'tight', `${units}/${ceiling - 1} 应该贴线`)
  }
})

test('余量读数按实际值算，不是利用率', () => {
  assert.ok(Math.abs(headroomOf({ units: 1_000, ceiling: 1_050 }) - 0.05) < 1e-9)
  // 利用率口径会给出 4.76%：两回事，别混用
  assert.ok(Math.abs(headroomOf({ units: 1_000, ceiling: 1_050 }) - (1 - 1_000 / 1_050)) > 1e-3)
  assert.ok(Number.isNaN(headroomOf({ units: null, ceiling: 10 })))
})

test('判定：文件缺失与非法天花板各自单独报出，不混成超限', () => {
  const results = checkBudgets([
    { path: 'a.md', ceiling: 10, units: null },
    { path: 'b.md', ceiling: 0, units: 3 },
    { path: 'c.md', ceiling: 1.5, units: 1 },
  ])
  assert.deepEqual(results.map((result) => result.status), ['missing', 'bad-ceiling', 'bad-ceiling'])
})

test('输出行带状态、读数与天花板', () => {
  const row = formatBudgetRow({ path: 'docs/a.md', ceiling: 100, units: 120, status: 'over' })
  assert.match(row, /^OVER/)
  assert.match(row, /120/)
  assert.match(row, /100/)
  assert.match(row, /docs\/a\.md$/)
})

test('输出行：缺失文件的读数显示为破折号', () => {
  const row = formatBudgetRow({ path: 'docs/a.md', ceiling: 100, units: null, status: 'missing' })
  assert.match(row, /^MISS/)
  assert.match(row, /—/)
})

test('输出行：余量不足的标签是 TIGHT', () => {
  const row = formatBudgetRow({ path: 'docs/a.md', ceiling: 100, units: 99, status: 'tight' })
  assert.match(row, /^TIGHT/)
  assert.match(row, /docs\/a\.md$/)
})

test('未登记的长期文档被报出，已登记的不报', () => {
  assert.deepEqual(
    findUnregisteredDocs(['docs/a.md', 'README.md'], ['README.md', 'docs/a.md', 'docs/orphan.md', 'AGENTS.md']),
    ['AGENTS.md', 'docs/orphan.md'],
  )
  assert.deepEqual(findUnregisteredDocs(['docs/a.md'], ['docs/a.md']), [])
  // Windows 的 relative() 产出反斜杠；归一化后不能再误报
  assert.deepEqual(findUnregisteredDocs(['docs/a.md'], ['docs\\a.md']), [])
})

test('真实清单：声明的文件都在，且读数都是正整数', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'scripts/doc-budgets.json'), 'utf8'))
  assert.ok(Object.keys(manifest).length > 0)
  for (const [path, ceiling] of Object.entries(manifest)) {
    assert.ok(existsSync(join(root, path)), `清单里的 ${path} 不存在，改名或删除时同步 scripts/doc-budgets.json`)
    assert.ok(Number.isInteger(ceiling) && ceiling > 0, `${path} 的天花板必须是正整数`)
  }
})

test('真实清单：根目录与 docs/ 下的 Markdown 全部登记', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'scripts/doc-budgets.json'), 'utf8'))
  const discovered = [...markdownIn('.'), ...markdownIn('docs')]
  assert.deepEqual(findUnregisteredDocs(Object.keys(manifest), discovered), [])
})

test('真实清单：每篇 standing doc 的余量都达标', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'scripts/doc-budgets.json'), 'utf8'))
  const entries = Object.entries(manifest).map(([path, ceiling]) => ({
    path,
    ceiling,
    units: countDocUnits(readFileSync(join(root, path), 'utf8')),
  }))
  const failures = checkBudgets(entries).filter((result) => result.status !== 'ok')
  const detail = failures
    .map((result) => `${result.path}: ${result.units}/${result.ceiling}，抬到 ${result.recommended} 或压到更低`)
    .join('\n')
  assert.deepEqual(failures, [], `余量不足的文档要一起处理：\n${detail}`)
})
