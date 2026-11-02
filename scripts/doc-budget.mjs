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
 * 判定清单里每一项是否落在天花板内。
 *
 * @param {Array<{ path: string, ceiling: number, units: number | null }>} entries - 待判定项，`units` 为 null 表示文件不存在
 * @returns {Array<{ path: string, ceiling: number, units: number | null, status: 'ok' | 'over' | 'missing' | 'bad-ceiling' }>} 判定结果
 */
export function checkBudgets(entries) {
  return entries.map(({ path, ceiling, units }) => {
    if (!Number.isInteger(ceiling) || ceiling <= 0) {
      return { path, ceiling, units, status: 'bad-ceiling' }
    }
    if (units === null) return { path, ceiling, units: null, status: 'missing' }
    return { path, ceiling, units, status: units <= ceiling ? 'ok' : 'over' }
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
 * 渲染判定结果的一行。
 *
 * @param {{ path: string, ceiling: number, units: number | null, status: string }} result - 单项判定结果
 * @returns {string} 对齐后的单行输出
 */
export function formatBudgetRow(result) {
  const label = { ok: 'ok  ', over: 'OVER', missing: 'MISS', 'bad-ceiling': 'BAD ' }[result.status]
  const units = result.units === null ? '—' : String(result.units)
  return `${label}  ${units.padStart(6)} / ${String(result.ceiling).padEnd(6)} ${result.path}`
}
