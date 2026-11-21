/**
 * 文档体量计数的纯函数与清单判定。
 *
 * 中文没有空格分词，`wc -w` 那种口径对中文文档失效（整段算一个词），所以这里
 * 用「CJK 字符逐个算 1 + 非 CJK 按空白分词」的混合口径：稳定、机械、可解释。
 * 代码块与表格一并计入——它们同样占读者的注意力与上下文。
 */

/** CJK 统一表意文字（含扩展 A 与兼容区）。 */
const CJK_PATTERN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/gu

/** 天花板超过当前值的这个倍数，说明余量已经大到不再约束体量，报 `loose`。 */
export const LOOSE_RATIO = 1.12

/** 天花板低于当前值的这个倍数，说明余量不足 5%，报 `tight`。 */
export const FLOOR_RATIO = 1.05

/** 9 个单位以下时 5% 与 12% 之间没有整数天花板，下界不参与判定。 */
const FLOOR_MIN_UNITS = 9

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
 * 按当前值与 5% 余量算建议天花板。
 *
 * `units` 很小时「5% 余量」与「12% 上限」之间可能没有整数解（如 1 个单位），
 * 这时取能落地的最小值；返回值为正整数。
 *
 * @param {number} units - 当前体量单位数（调用方保证 > 0）
 * @returns {number} 建议天花板（正整数）
 */
function recommendedCeiling(units) {
  const target = Math.ceil(units * FLOOR_RATIO)
  const upper = Math.floor(units * LOOSE_RATIO)
  return Math.min(target, upper)
}

/**
 * 当前天花板下还能保留多少单位，才不算贴线；无解时返回 null。
 *
 * 压缩目标要同时满足 5% 下界与 12% 上限；9 个单位附近会只剩抬天花板一条路。
 *
 * @param {number} ceiling - 当前天花板
 * @returns {number | null} 可压缩到的最大单位数；无整数解时为 null
 */
function compactionTarget(ceiling) {
  const maxUnits = Math.floor(ceiling / FLOOR_RATIO)
  return maxUnits > 0 && ceiling / maxUnits <= LOOSE_RATIO ? maxUnits : null
}

/**
 * 判定清单里每一项是否落在天花板内，并检查余量是否过大或过小。
 *
 * 状态优先级：`bad-ceiling` / `missing` 是结构性错误，先报；`over` 是超限；
 * `loose` 是余量超过 12%；`units < 9` 的非 loose 文档判 `small`（下界豁免）；
 * `tight` 是余量低于 5%。`loose` / `tight` / `small` 互斥。
 *
 * @param {Array<{ path: string, ceiling: number, units: number | null }>} entries - 待判定项，`units` 为 null 表示文件不存在
 * @returns {Array<{ path: string, ceiling: number, units: number | null, status: 'ok' | 'over' | 'missing' | 'bad-ceiling' | 'loose' | 'tight' | 'small', suggestedCeiling?: number, maxUnits?: number }>} 判定结果
 */
export function checkBudgets(entries) {
  return entries.map(({ path, ceiling, units }) => {
    if (!Number.isInteger(ceiling) || ceiling <= 0) {
      return { path, ceiling, units, status: 'bad-ceiling' }
    }
    if (units === null) return { path, ceiling, units: null, status: 'missing' }
    if (units > ceiling) return { path, ceiling, units, status: 'over' }
    // 空文档与 9 单位以下的小文档没有可判的下界，标 small 让豁免可见。
    if (units === 0) return { path, ceiling, units, status: 'small' }
    if (ceiling / units > LOOSE_RATIO) {
      return { path, ceiling, units, status: 'loose', suggestedCeiling: recommendedCeiling(units) }
    }
    if (units < FLOOR_MIN_UNITS) return { path, ceiling, units, status: 'small' }
    if (ceiling / units < FLOOR_RATIO) {
      const maxUnits = compactionTarget(ceiling)
      return {
        path,
        ceiling,
        units,
        status: 'tight',
        suggestedCeiling: recommendedCeiling(units),
        ...(maxUnits === null ? {} : { maxUnits }),
      }
    }
    return { path, ceiling, units, status: 'ok' }
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
 * 余量百分比，保留两位小数。
 *
 * 4.999% 四舍五入会显示成 5.00%，与 `tight` 自相矛盾；命中 5 时改为向下取整。
 *
 * @param {number} units - 当前体量单位数
 * @param {number} ceiling - 当前天花板
 * @returns {string} 例如 `4.00`
 */
export function headroomPercent(units, ceiling) {
  const percent = (ceiling / units - 1) * 100
  const rounded = Math.round(percent * 100) / 100
  return (rounded >= 5 ? Math.floor(percent * 100) / 100 : rounded).toFixed(2)
}

/**
 * 渲染判定结果的一行。
 *
 * @param {{ path: string, ceiling: number, units: number | null, status: string, suggestedCeiling?: number, maxUnits?: number }} result - 单项判定结果
 * @returns {string} 对齐后的单行输出
 */
export function formatBudgetRow(result) {
  const label = { ok: 'ok  ', over: 'OVER', missing: 'MISS', 'bad-ceiling': 'BAD ', loose: 'LOOSE', tight: 'TIGHT', small: 'SMALL' }[result.status]
  const units = result.units === null ? '—' : String(result.units)
  let suggestion = ''
  if (result.status === 'loose') {
    suggestion = `  → 建议 ${result.suggestedCeiling}`
  } else if (result.status === 'tight') {
    const compress = result.maxUnits === undefined ? '' : `压到 ${result.maxUnits} 或`
    suggestion = `  → 余量 ${headroomPercent(result.units, result.ceiling)}%，${compress}抬到 ${result.suggestedCeiling}`
  } else if (result.status === 'small') {
    const percent = result.units === 0 ? '' : `余量 ${headroomPercent(result.units, result.ceiling)}%，`
    suggestion = `  → ${percent}<9 单位，下界豁免`
  }
  return `${label}  ${units.padStart(6)} / ${String(result.ceiling).padEnd(6)} ${result.path}${suggestion}`
}
