import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkBudgets, countDocUnits, findUnregisteredDocs, formatBudgetRow, headroomPercent } from '../scripts/doc-budget.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const SCRIPTS = join(root, 'scripts')

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

/**
 * 递归列出某个目录树下的 Markdown 文件。
 * @param {string} dir - 仓内相对目录
 * @returns {string[]} 仓内相对路径
 */
function markdownTree(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) return markdownTree(rel)
    return entry.isFile() && entry.name.endsWith('.md') ? [rel] : []
  })
}

/**
 * 在临时目录里搭一个最小仓，跑真实门禁脚本。
 *
 * 门禁的枚举范围写在脚本里、由脚本自己读盘，所以在仓里断言「已登记」不能证明
 * 新目录会被要求登记；这里复制脚本 + 夹具文档跑一遍，验证漏登记确实退出 1。
 *
 * @param {Record<string, string>} files - 仓内相对路径到文件内容的映射
 * @param {string[]} args - 传给门禁脚本的额外参数（如 `--list`）
 * @returns {{ status: number, stdout: string, stderr: string }} 子进程结果
 */
function runBudgetGate(files, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'doc-budgets-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    for (const name of ['verify-doc-budgets.mjs', 'doc-budget.mjs']) {
      copyFileSync(join(SCRIPTS, name), join(dir, 'scripts', name))
    }
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), content)
    }
    const result = spawnSync(process.execPath, [join(dir, 'scripts/verify-doc-budgets.mjs'), ...args], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
    { path: 'a.md', ceiling: 11, units: 10 },
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

test('判定：余量低于 5% 报 tight，5.0% 边界不报', () => {
  const results = checkBudgets([
    { path: 'tight.md', ceiling: 104, units: 100 },
    { path: 'edge.md', ceiling: 105, units: 100 },
    { path: 'loose-edge.md', ceiling: 112, units: 100 },
    { path: 'loose.md', ceiling: 113, units: 100 },
  ])
  assert.deepEqual(results.map((result) => result.status), ['tight', 'ok', 'ok', 'loose'])
  assert.equal(results[0].suggestedCeiling, 105)
  assert.equal(results[0].maxUnits, 99)
  assert.equal(headroomPercent(100, 104), '4.00')
  assert.equal(headroomPercent(100, 105), '5.00')
})

test('判定：units < 9 标 small，不判 tight', () => {
  const results = checkBudgets([
    { path: 'two.md', ceiling: 2, units: 2 },
    { path: 'eight.md', ceiling: 8, units: 8 },
    { path: 'nine.md', ceiling: 9, units: 9 },
  ])
  assert.deepEqual(results.map((result) => result.status), ['small', 'small', 'tight'])
  assert.equal(results[2].suggestedCeiling, 10)
  // 9/8 会超过 12%，只能抬天花板，不给无效的压缩建议
  assert.equal(results[2].maxUnits, undefined)
})

test('判定：空文档与 <9 单位判 small；units 极小时建议值仍可落地', () => {
  const results = checkBudgets([
    { path: 'empty.md', ceiling: 5, units: 0 },
    { path: 'tiny.md', ceiling: 2, units: 1 },
  ])
  assert.deepEqual(results.map((result) => result.status), ['small', 'loose'])
  assert.equal(results[1].suggestedCeiling, 1)
  // 按建议值改完不能再触发 loose
  const [fixed] = checkBudgets([{ path: 'tiny.md', ceiling: 1, units: 1 }])
  assert.equal(fixed.status, 'small')
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

test('输出行：tight 带余量、压缩与抬天花板建议', () => {
  const [result] = checkBudgets([{ path: 'docs/a.md', ceiling: 104, units: 100 }])
  const row = formatBudgetRow(result)
  assert.match(row, /^TIGHT/)
  assert.match(row, /104/)
  assert.match(row, /余量 4\.00%/)
  assert.match(row, /压到 99/)
  assert.match(row, /抬到 105/)
})

test('输出行：tight 无压缩解时只给抬天花板', () => {
  const [result] = checkBudgets([{ path: 'docs/a.md', ceiling: 9, units: 9 }])
  const row = formatBudgetRow(result)
  assert.match(row, /^TIGHT/)
  assert.match(row, /抬到 10/)
  assert.doesNotMatch(row, /压到/)
})

test('输出行：small 标出 <9 单位下界豁免', () => {
  const [result] = checkBudgets([{ path: 'docs/a.md', ceiling: 8, units: 8 }])
  const row = formatBudgetRow(result)
  assert.match(row, /^SMALL/)
  assert.match(row, /余量 0\.00%/)
  assert.match(row, /<9 单位，下界豁免/)
})

test('输出行：small 空文档不打印百分比', () => {
  const [result] = checkBudgets([{ path: 'docs/empty.md', ceiling: 5, units: 0 }])
  assert.equal(result.status, 'small')
  const row = formatBudgetRow(result)
  assert.match(row, /^SMALL\s+0 \/ 5/)
  assert.match(row, /<9 单位，下界豁免/)
  assert.doesNotMatch(row, /余量/)
})

test('输出行：4.999% 不显示成 5.00%', () => {
  const [result] = checkBudgets([{ path: 'docs/a.md', ceiling: 104999, units: 100000 }])
  assert.equal(result.status, 'tight')
  const row = formatBudgetRow(result)
  assert.match(row, /余量 4\.99%/)
  assert.doesNotMatch(row, /5\.00%/)
  assert.equal(headroomPercent(100000, 104999), '4.99')
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

test('真实清单：除 small 外都在 5–12% 余量内', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'scripts/doc-budgets.json'), 'utf8'))
  const entries = Object.entries(manifest).map(([path, ceiling]) => {
    const abs = join(root, path)
    return { path, ceiling, units: existsSync(abs) ? countDocUnits(readFileSync(abs, 'utf8')) : null }
  })
  // 8 单位临时文档：过滤必须放行 small，否则未来登记小文档会让这条真实清单测试假红。
  entries.push({ path: 'docs/__small-fixture.md', ceiling: 8, units: countDocUnits('one two three four five six seven eight') })
  const results = checkBudgets(entries)
  assert.equal(results.find((result) => result.path === 'docs/__small-fixture.md')?.status, 'small')
  assert.deepEqual(
    results.filter((result) => result.status !== 'ok' && result.status !== 'small'),
    [],
  )
})

test('真实清单：根目录、docs/ 与 growing/ 下的 Markdown 全部登记', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'scripts/doc-budgets.json'), 'utf8'))
  const discovered = [...markdownIn('.'), ...markdownIn('docs'), ...markdownTree('growing')]
  assert.ok(discovered.includes('growing/2026-11-16-leader-agent-promo/README.md'), 'growing 的案例文档要递归枚举到')
  assert.deepEqual(findUnregisteredDocs(Object.keys(manifest), discovered), [])
})

test('门禁：growing/ 子目录里漏登记的文档让 check 变红', () => {
  const manifest = JSON.stringify({ 'growing/AGENTS.md': 2 })
  const registered = runBudgetGate({
    'scripts/doc-budgets.json': manifest,
    'growing/AGENTS.md': '规则\n',
    'growing/2026-01-01-case/README.md': '案例\n',
  })
  assert.equal(registered.status, 1, registered.stderr)
  assert.match(registered.stderr, /UNREG|没有登记/)
  assert.match(registered.stderr, /growing\/2026-01-01-case\/README\.md/)

  const complete = runBudgetGate({
    'scripts/doc-budgets.json': JSON.stringify({ 'growing/AGENTS.md': 2, 'growing/2026-01-01-case/README.md': 2 }),
    'growing/AGENTS.md': '规则\n',
    'growing/2026-01-01-case/README.md': '案例\n',
  })
  assert.equal(complete.status, 0, complete.stderr)
})

test('门禁：4.x% 夹具报余量低于 5%，5.0% 边界放行', () => {
  const content = Array.from({ length: 100 }, (_, index) => `w${index % 10}`).join(' ')
  const tight = runBudgetGate({
    'scripts/doc-budgets.json': JSON.stringify({ 'docs/a.md': 104 }),
    'docs/a.md': content,
  })
  assert.equal(tight.status, 1, tight.stderr)
  assert.match(tight.stderr, /余量 4\.00% 低于 5%/)
  assert.match(tight.stderr, /压缩到 99 个单位/)
  assert.match(tight.stderr, /抬天花板到 105/)

  const edge = runBudgetGate({
    'scripts/doc-budgets.json': JSON.stringify({ 'docs/a.md': 105 }),
    'docs/a.md': content,
  })
  assert.equal(edge.status, 0, edge.stderr)
  assert.match(edge.stdout, /5–12% 余量内/)
})

test('门禁：12.0% 边界放行，>12% 仍报 loose', () => {
  const content = Array.from({ length: 100 }, (_, index) => `w${index % 10}`).join(' ')
  const edge = runBudgetGate({
    'scripts/doc-budgets.json': JSON.stringify({ 'docs/a.md': 112 }),
    'docs/a.md': content,
  })
  assert.equal(edge.status, 0, edge.stderr)

  const loose = runBudgetGate({
    'scripts/doc-budgets.json': JSON.stringify({ 'docs/a.md': 113 }),
    'docs/a.md': content,
  })
  assert.equal(loose.status, 1, loose.stderr)
  assert.match(loose.stderr, /高于当前值 100 的 12%/)
})

test('门禁：8/8 标 small，成功文案不再声称全部在 5–12%', () => {
  const files = {
    'scripts/doc-budgets.json': JSON.stringify({ 'docs/a.md': 8 }),
    'docs/a.md': 'one two three four five six seven eight',
  }
  const result = runBudgetGate(files)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^SMALL/m)
  assert.match(result.stdout, /余量 0\.00%/)
  assert.match(result.stdout, /<9 单位，下界豁免/)
  assert.match(result.stdout, /1 篇 <9 单位豁免下界/)
  assert.doesNotMatch(result.stdout, /都在 5–12% 余量内/)

  const list = runBudgetGate(files, ['--list'])
  assert.equal(list.status, 0, list.stderr)
  assert.match(list.stdout, /^SMALL/m)
  assert.match(list.stdout, /<9 单位，下界豁免/)
})

test('门禁：失败时也列出 small 豁免项', () => {
  const tightContent = Array.from({ length: 100 }, (_, index) => `w${index % 10}`).join(' ')
  const result = runBudgetGate({
    'scripts/doc-budgets.json': JSON.stringify({ 'docs/a.md': 104, 'docs/b.md': 8 }),
    'docs/a.md': tightContent,
    'docs/b.md': 'one two three four five six seven eight',
  })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /^SMALL/m)
  assert.match(result.stderr, /另有 1 篇 <9 单位小文档豁免下界：docs\/b\.md/)
})

test('门禁：4.999% 的 CLI 输出不出现 5.00%', () => {
  const content = Array.from({ length: 100000 }, (_, index) => `w${index % 10}`).join(' ')
  const result = runBudgetGate({
    'scripts/doc-budgets.json': JSON.stringify({ 'docs/a.md': 104999 }),
    'docs/a.md': content,
  })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /余量 4\.99%/)
  assert.doesNotMatch(result.stdout, /5\.00%/)
  assert.match(result.stderr, /余量 4\.99% 低于 5%/)
})
