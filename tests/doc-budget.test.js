import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { checkBudgets, countDocUnits, formatBudgetRow } from '../scripts/doc-budget.mjs'

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

test('输出行带状态、读数与天花板', () => {
  const row = formatBudgetRow({ path: 'docs/a.md', ceiling: 100, units: 120, status: 'over' })
  assert.match(row, /^OVER/)
  assert.match(row, /120/)
  assert.match(row, /100/)
  assert.match(row, /docs\/a\.md$/)
})

test('真实清单：声明的文件都在，且读数都是正整数', () => {
  const root = new URL('../', import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL('scripts/doc-budgets.json', root), 'utf8'))
  assert.ok(Object.keys(manifest).length > 0)
  for (const [path, ceiling] of Object.entries(manifest)) {
    assert.ok(existsSync(new URL(path, root)), `清单里的 ${path} 不存在，改名或删除时同步 scripts/doc-budgets.json`)
    assert.ok(Number.isInteger(ceiling) && ceiling > 0, `${path} 的天花板必须是正整数`)
  }
})
