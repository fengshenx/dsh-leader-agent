import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkBudgets, countDocUnits, findUnregisteredDocs, formatBudgetRow } from '../scripts/doc-budget.mjs'

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

test('判定：未超限为 ok，超限为 over', () => {
  const results = checkBudgets([
    { path: 'a.md', ceiling: 10, units: 10 },
    { path: 'b.md', ceiling: 10, units: 11 },
  ])
  assert.deepEqual(results.map((result) => result.status), ['ok', 'over'])
})

test('判定：文件缺失与非法天花板各自单独报出，不混成超限', () => {
  const results = checkBudgets([
    { path: 'a.md', ceiling: 10, units: null },
    { path: 'b.md', ceiling: 0, units: 3 },
    { path: 'c.md', ceiling: 1.5, units: 1 },
  ])
  assert.deepEqual(results.map((result) => result.status), ['missing', 'bad-ceiling', 'bad-ceiling'])
})

test('判定：余量上限——正好 12% 仍是 ok，略超报 loose 并给出建议值', () => {
  const results = checkBudgets([
    { path: 'edge.md', ceiling: 112, units: 100 },
    { path: 'loose.md', ceiling: 113, units: 100 },
  ])
  assert.deepEqual(results.map((result) => result.status), ['ok', 'loose'])
  assert.equal(results[1].suggestedCeiling, 105)
})

test('判定：loose 的建议值按当前值留 5% 余量', () => {
  const [result] = checkBudgets([{ path: 'README.md', ceiling: 4000, units: 3018 }])
  assert.equal(result.status, 'loose')
  assert.equal(result.suggestedCeiling, 3169)
})

test('判定：空文档判 ok；units 极小时建议值仍可落地', () => {
  const results = checkBudgets([
    { path: 'empty.md', ceiling: 5, units: 0 },
    { path: 'tiny.md', ceiling: 2, units: 1 },
  ])
  assert.deepEqual(results.map((result) => result.status), ['ok', 'loose'])
  assert.equal(results[1].suggestedCeiling, 1)
  // 按建议值改完不能再触发 loose
  const [fixed] = checkBudgets([{ path: 'tiny.md', ceiling: 1, units: 1 }])
  assert.equal(fixed.status, 'ok')
})

test('判定：bad-ceiling / missing / over 优先于 loose', () => {
  const results = checkBudgets([
    { path: 'bad.md', ceiling: 0, units: 1 },
    { path: 'missing.md', ceiling: 9999, units: null },
    { path: 'over.md', ceiling: 100, units: 120 },
    { path: 'loose.md', ceiling: 4000, units: 3018 },
  ])
  assert.deepEqual(results.map((result) => result.status), ['bad-ceiling', 'missing', 'over', 'loose'])
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

test('输出行：loose 带状态与建议值', () => {
  const row = formatBudgetRow({ path: 'docs/a.md', ceiling: 4000, units: 3018, status: 'loose', suggestedCeiling: 3169 })
  assert.match(row, /^LOOSE/)
  assert.match(row, /3018/)
  assert.match(row, /4000/)
  assert.match(row, /建议 3169/)
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

test('真实清单：当前读数都不超限，余量也不超过 12%', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'scripts/doc-budgets.json'), 'utf8'))
  const entries = Object.entries(manifest).map(([path, ceiling]) => {
    const abs = join(root, path)
    return { path, ceiling, units: existsSync(abs) ? countDocUnits(readFileSync(abs, 'utf8')) : null }
  })
  assert.deepEqual(
    checkBudgets(entries).filter((result) => result.status !== 'ok'),
    [],
  )
})

test('真实清单：根目录与 docs/ 下的 Markdown 全部登记', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'scripts/doc-budgets.json'), 'utf8'))
  const discovered = [...markdownIn('.'), ...markdownIn('docs')]
  assert.deepEqual(findUnregisteredDocs(Object.keys(manifest), discovered), [])
})
