/**
 * 文档体量计数的纯函数与清单判定。
 *
 * 中文没有空格分词，`wc -w` 那种口径对中文文档失效（整段算一个词），所以这里
 * 用「CJK 字符逐个算 1 + 非 CJK 按空白分词」的混合口径：稳定、机械、可解释。
 * 代码块与表格一并计入——它们同样占读者的注意力与上下文。
 */

/** CJK 统一表意文字（含扩展 A 与兼容区）。 */
const CJK_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu

/**
 * 数一份文档的体量。
 *
 * @param {string} text - 文档全文
 * @returns {number} 体量单位数（CJK 字符数 + 非 CJK 空白分词数）
 */
export function countDocUnits(text) {
  const cjkCount = text.match(CJK_PATTERN)?.length ?? 0
  const rest = text.replace(CJK_PATTERN, ' ')
  const wordCount = rest.split(/\s+/).filter(Boolean).length
  return cjkCount + wordCount
}

/**
 * 最小余量：普通文档 5%，每个任务都要改的两份抬到 10%。
 *
 * 口径是 `ceiling / units - 1`（相对实际值），不是利用率：前者回答「还能再写多少」，
 * 后者在天花板刚抬完时永远接近 100%，看不出还剩多少空间。
 */
export const DEFAULT_HEADROOM = 0.05
export const STRICT_HEADROOM = 0.1
export const STRICT_HEADROOM_PATHS = Object.freeze(['AGENTS.md', 'docs/capability-gaps.md'])

/**
 * 某份文档要求的最小余量。
 *
 * @param {string} path - 仓内相对路径
 * @returns {number} 余量比例
 */
export function minHeadroom(path) {
  return STRICT_HEADROOM_PATHS.includes(path) ? STRICT_HEADROOM : DEFAULT_HEADROOM
}

/**
 * 按当前读数应抬到的天花板：余量正好够的下一个整数。
 *
 * @param {number} units - 当前体量
 * @param {number} headroom - 最小余量比例
 * @returns {number} 建议天花板
 */
export function recommendedCeiling(units, headroom) {
  return Math.ceil((units * (100 + Math.round(headroom * 100))) / 100)
}

/**
 * 当前余量占实际值的比例。
 *
 * @param {{ units: number | null, ceiling: number }} result - 带读数与天花板的判定结果
 * @returns {number} 余量比例；文件缺失时为 NaN，读数为 0 时为正无穷
 */
export function headroomOf({ units, ceiling }) {
  if (units === null) return Number.NaN
  if (units === 0) return Number.POSITIVE_INFINITY
  return ceiling / units - 1
}

/**
 * 判定清单里每一项：超限、余量不足、缺失、天花板非法。
 *
 * @param {Array<{ path: string, ceiling: number, units: number | null }>} entries - 待判定项，`units` 为 null 表示文件不存在
 * @returns {Array<{ path: string, ceiling: number, units: number | null, status: 'ok' | 'over' | 'tight' | 'missing' | 'bad-ceiling', headroom?: number, recommended?: number }>} 判定结果
 */
export function checkBudgets(entries) {
  return entries.map(({ path, ceiling, units }) => {
    if (!Number.isInteger(ceiling) || ceiling <= 0) {
      return { path, ceiling, units, status: 'bad-ceiling' }
    }
    if (units === null) return { path, ceiling, units: null, status: 'missing' }
    const headroom = minHeadroom(path)
    const recommended = recommendedCeiling(units, headroom)
    if (units > ceiling) return { path, ceiling, units, headroom, recommended, status: 'over' }
    // 整数比较：浮点下 2000 × 1.05 会算成 2100.0000000000002，正好 5% 的会被判成贴线。
    return { path, ceiling, units, headroom, recommended, status: ceiling >= recommended ? 'ok' : 'tight' }
  })
}

/**
 * 找出长期文档目录里没登记的文档。
 *
 * 只校验清单内文件会留一条旁路：新增长期文档忘了登记就绕过整套预算。所以按目录
 * 枚举与清单比对，漏登记同样是红的。
 *
 * @param {string[]} registered - 清单里的路径（仓内相对 POSIX 路径）
 * @param {string[]} discovered - 枚举到的候选文档路径
 * @returns {string[]} 未登记的路径，按字典序
 */
export function findUnregisteredDocs(registered, discovered) {
  // Windows 的 relative() 返回反斜杠；清单统一用 `/`，不归一化会把所有文档误报为未登记。
  const normalize = (path) => path.replaceAll('\\', '/')
  const known = new Set(registered.map(normalize))
  return discovered.filter((path) => !known.has(normalize(path))).sort()
}

/**
 * 在天花板不变的前提下允许的最大体量。
 *
 * @param {number} ceiling - 天花板
 * @param {number} headroom - 最小余量比例
 * @returns {number} 最大体量
 */
export function maxUnitsFor(ceiling, headroom) {
  return Math.floor((ceiling * 100) / (100 + Math.round(headroom * 100)))
}

/**
 * 渲染判定结果的一行。
 *
 * @param {{ path: string, ceiling: number, units: number | null, status: string }} result - 单项判定结果
 * @returns {string} 对齐后的单行输出
 */
export function formatBudgetRow(result) {
  const label = { ok: 'ok', over: 'OVER', tight: 'TIGHT', missing: 'MISS', 'bad-ceiling': 'BAD' }[result.status]
  const units = result.units === null ? '—' : String(result.units)
  return `${label.padEnd(5)} ${units.padStart(6)} / ${String(result.ceiling).padEnd(6)} ${result.path}`
}
