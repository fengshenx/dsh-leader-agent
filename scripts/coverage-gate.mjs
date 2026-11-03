/**
 * 覆盖率报告的解析与判定（纯函数），入口在 `scripts/verify-coverage.mjs`。
 *
 * 为什么不能直接用 `--test-coverage-lines`：那是全局阈值，报不出是哪个文件掉下来。
 * per-file 门禁必须自己解析报告，而 Node 的覆盖率报告只有人读的表格形态——它的
 * 「file」列是目录树缩进，没有完整路径，所以要按缩进还原来路径。
 *
 * 另一个前提：Node 只统计**被加载过**的文件。单测没 import 的文件既不在报告里，
 * 也不会被算成 0%，所以分母必须来自 `src` 目录枚举而不是报告本身（见 AGENTS.md
 * 的「测试」节与 docs/development.md）。
 */

/**
 * 解析 Node `--experimental-test-coverage` 打印的覆盖率表格。
 *
 * @param {string} text - 覆盖率表格全文（可含 spec reporter 的测试输出，非表格行会被跳过）
 * @returns {Map<string, { path: string, lines: number, branches: number, functions: number, uncovered: string }>} 仓内相对路径 → 读数
 */
export function parseCoverageTable(text) {
  const lines = text.split('\n')
  // 只在报告区间里找表格：不收边的话，测试输出里任何形如「ℹ a | 1 | 2 | 3」的行
  // 都会成为一条源文件读数——它不在 src 枚举里，却会污染「豁免出现在报告里」的
  // 判定与 all files 的口径。缺标记时返回空表，由调用方按「没解析到表格」报错。
  const start = lines.findIndex((line) => line.includes('start of coverage report'))
  const end = start === -1
    ? -1
    : lines.findIndex((line, index) => index > start && line.includes('end of coverage report'))
  if (start === -1 || end === -1) return new Map()

  /** 目录栈：表格用缩进表达层级，文件路径要自己拼。 */
  const stack = []
  const report = new Map()

  for (const line of lines.slice(start + 1, end)) {
    if (!line.startsWith('ℹ')) continue
    const parts = line.slice(1).split('|')
    if (parts.length < 4) continue
    const rawPath = parts[0]
    const name = rawPath.trim()
    // 表头、分隔线、「all files」与结尾标记都不是源文件
    if (name === '' || name === 'file' || name === 'all files') continue

    const level = rawPath.length - rawPath.trimStart().length
    const numbers = parts.slice(1, 4).map((part) => part.trim())

    if (numbers.every((value) => value === '')) {
      // 目录行：本层及更深处先丢掉，再压入当前目录
      stack.length = level - 1
      stack.push(name)
      continue
    }
    if (!numbers.every((value) => /^\d+(?:\.\d+)?$/.test(value))) continue

    const [lines, branches, functions] = numbers.map(Number)
    const path = [...stack.slice(0, level - 1), name].join('/')
    report.set(path, { path, lines, branches, functions, uncovered: parts[4]?.trim() ?? '' })
  }

  return report
}

/**
 * 按清单判定覆盖率是否达标。
 *
 * 三个判据都来自「分母由目录枚举决定」这个前提：
 * - 枚举到的文件既没进报告也没登记为不可加载 → 红（新增文件必须登记）；
 * - 登记为不可加载却出现在报告里 → 红（清单过期，别用豁免掩盖已测文件）；
 * - 报告里的行覆盖低于门槛 → 红。未登记门槛的文件默认 100%。
 *
 * @param {object} input - 判定输入
 * @param {Map<string, { path: string, lines: number, branches: number, functions: number, uncovered: string }>} input.report - 解析出的覆盖率报告
 * @param {string[]} input.sources - 需要判定的源文件（仓内相对 POSIX 路径，来自目录枚举）
 * @param {{ unmeasured?: Record<string, string>, thresholds?: Record<string, { lines: number, reason: string }> }} input.manifest - `scripts/coverage-manifest.json` 的内容
 * @returns {{ rows: Array<object>, problems: Array<{ path: string, message: string }>, raises: Array<{ path: string, message: string }> }} 判定结果
 */
export function evaluateCoverage({ report, sources, manifest }) {
  const unmeasured = manifest.unmeasured ?? {}
  const thresholds = manifest.thresholds ?? {}
  const sourceSet = new Set(sources)
  const problems = []
  const raises = []
  const rows = []

  for (const [path, reason] of Object.entries(unmeasured)) {
    if (!sourceSet.has(path)) {
      problems.push({ path, message: '登记为单测不可加载，但 src 下没有这个文件——改名或删除时同步 scripts/coverage-manifest.json' })
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      problems.push({ path, message: '豁免必须写明理由（unmeasured 的值不能为空）' })
    }
    if (report.has(path)) {
      problems.push({ path, message: '登记为单测不可加载，但它出现在覆盖率报告里——删掉这条豁免，按正常门槛判' })
    }
  }

  for (const [path, entry] of Object.entries(thresholds)) {
    if (!sourceSet.has(path)) {
      problems.push({ path, message: '门槛登记的文件在 src 下不存在——改名或删除时同步 scripts/coverage-manifest.json' })
    }
    if (!Number.isInteger(entry.lines) || entry.lines < 0 || entry.lines > 100) {
      problems.push({ path, message: '门槛的 lines 必须是 0-100 的整数' })
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      problems.push({ path, message: '门槛必须写明为什么没到 100%（thresholds 的 reason 不能为空）' })
    }
    if (!report.has(path)) {
      problems.push({ path, message: '登记了门槛但这个文件没被任何单测加载——先让它进报告，或改登记到 unmeasured' })
    }
  }

  for (const path of sources) {
    if (unmeasured[path] !== undefined) {
      rows.push({ path, status: 'unmeasured', lines: null, min: null, uncovered: '' })
      continue
    }
    const measured = report.get(path)
    if (measured === undefined) {
      // 登记了门槛却没加载的，已经由 thresholds 那轮报过，别叠一条同义的错
      if (thresholds[path] === undefined) {
        problems.push({
          path,
          message: '没有被任何单测加载，也不在豁免清单里——补测试，或在 scripts/coverage-manifest.json 的 unmeasured 里写明理由',
        })
      }
      rows.push({ path, status: 'unloaded', lines: null, min: null, uncovered: '' })
      continue
    }
    const min = thresholds[path]?.lines ?? 100
    if (measured.lines < min) {
      problems.push({ path, message: `行覆盖 ${measured.lines}% 低于门槛 ${min}%` })
      rows.push({ path, status: 'below', lines: measured.lines, min, uncovered: measured.uncovered })
      continue
    }
    if (measured.lines >= min + 1) {
      raises.push({ path, message: `行覆盖 ${measured.lines}% 已高出登记门槛 ${min}%，顺手抬到 ${Math.floor(measured.lines)}` })
    }
    rows.push({ path, status: 'ok', lines: measured.lines, min, uncovered: measured.uncovered })
  }

  return { rows, problems, raises }
}

/**
 * 渲染判定结果的一行。
 *
 * @param {object} row - `evaluateCoverage` 返回的单行
 * @returns {string} 对齐后的单行输出
 */
export function formatCoverageRow(row) {
  const label = { ok: 'ok  ', below: 'LOW ', unmeasured: 'SKIP', unloaded: 'NONE' }[row.status]
  const actual = row.lines === null ? '—' : row.lines.toFixed(2)
  const min = row.min === null ? '—' : String(row.min)
  return `${label}  ${actual.padStart(6)}% / ${min.padEnd(3)}% ${row.path}`
}
