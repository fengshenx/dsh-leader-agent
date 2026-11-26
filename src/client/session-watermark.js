/**
 * 项目下会话列表的水位折叠。
 *
 * 口径照宿主工作区树（`WorkspaceBrowser.tsx` 的 `watermarkRows` /
 * `requiredWatermark`）：默认露出 5 条，每次展开再加 5 条，剩余不超过 5 条时
 * 一次放完；水位只升不降，收起回落到基线。宿主不导出这些函数（UI 包不为绕过
 * 包面规则开放值），只能照同一套口径自己算。
 *
 * 折叠本身不只会话列表用：看板「已完成」区按同一套「默认一页、展开加一页、
 * 最后一页一次放完、展开完收起」的口径翻页，只是页大小与基线不同。共享实现是
 * {@link foldRows} / {@link nextRowWatermark}，本模块的 `foldSessions` /
 * `nextWatermark` 负责把当前会话水位与 5 条一页接上去。
 *
 * 与宿主的已知差异：宿主还按运行中、「有子代理在跑」「等你输入」抬高水位；
 * 项目树只把**当前会话**抬进可见范围（刚点开的行不会因完成标记清除而消失），
 * 运行中与完成未读都不抬——worker 常驻且频繁跑完，按未读撑开会把「默认一页」
 * 顶成十几条；绿点保留状态语义，折在「展开其余」后面的要展开才看得到。
 *
 * @module dsh-leader-agent/client/session-watermark
 */

/** 无会话抬升水位时，每个项目默认露出的会话条数。 */
export const SESSION_WATERMARK_BASE = 5

/** 当前会话自动抬升的上限；展开操作可以超过它。 */
export const SESSION_WATERMARK_AUTO_MAX = 50

/**
 * 按水位切出可见行。
 *
 * @param {object[]} rows - 会话行
 * @param {number} watermark - 当前水位（可见条数，可以是 Infinity）
 * @returns {{ rows: object[], hiddenCount: number }} 可见行与被藏起来的条数
 */
export function watermarkRows(rows, watermark) {
  const visible = rows.slice(0, Math.max(0, watermark))
  return { rows: visible, hiddenCount: rows.length - visible.length }
}

/**
 * 算出「当前会话」要求的最小水位。
 *
 * 只有当前打开的行参与：它若被折掉，点开它的瞬间完成标记清除、水位回落，
 * 这一行会当场从列表里消失。运行中与完成未读不抬水位——列表固定一页，未读是
 * 状态而不是展开指令，排在后面的要展开才看得到。
 *
 * @param {object[]} rows - 会话行
 * @param {string} [currentSessionId] - 当前打开的会话 id
 * @returns {number} 需要的最小水位；没有当前会话时是 0
 */
export function requiredWatermark(rows, currentSessionId) {
  if (currentSessionId === undefined) return 0
  const limit = Math.min(rows.length, SESSION_WATERMARK_AUTO_MAX)
  for (let index = 0; index < limit; index += 1) {
    if (rows[index]?.id === currentSessionId) return index + 1
  }
  return 0
}

/**
 * 按水位切出可见行，并给出「展开其余 / 收起」视图。
 *
 * 会话列表与看板已完成区共用这一层：默认露到基线（至少一页），点「展开其余」
 * 再加一页，最后一页一次放完；展开到最后一页后按钮变「收起」。基线由调用方
 * 给——会话列表把当前会话抬进基线，已完成卡没有注意力状态，基线就是一页。
 *
 * @param {readonly object[]} rows - 已排序的行
 * @param {number} watermark - 用户展开出来的水位（0 表示没展开过）
 * @param {object} options - 选项
 * @param {number} options.pageSize - 一页的行数
 * @param {number} [options.baseline] - 折叠基线，默认等于 `pageSize`
 * @param {(hiddenCount: number) => string} options.expandLabel - 「展开其余」按钮文案
 * @returns {{ rows: object[], hiddenCount: number, expanded: boolean, expandLabel: string }} 视图
 */
export function foldRows(rows, watermark, { pageSize, baseline = pageSize, expandLabel }) {
  const limit = Math.max(baseline, watermark)
  const visible = watermarkRows(rows, limit)
  return {
    ...visible,
    expanded: visible.hiddenCount === 0 && limit > baseline,
    expandLabel: expandLabel(visible.hiddenCount),
  }
}

/**
 * 点「展开其余」之后的新水位。
 *
 * 剩余不超过一整页时一次放完（Infinity），否则在当前可见数上再加一页——最后
 * 一步不该只多露出几张再点一次。第二参统一收「当前可见数」，两边调用约定一致。
 *
 * @param {number} hiddenCount - 当前被藏起来的张数
 * @param {number} visibleCount - 当前可见张数
 * @param {number} pageSize - 一页的张数
 * @returns {number} 新水位
 */
export function nextRowWatermark(hiddenCount, visibleCount, pageSize) {
  if (hiddenCount <= pageSize) return Infinity
  return visibleCount + pageSize
}

/**
 * 会话列表的下一档水位。
 *
 * @param {number} hiddenCount - 当前被藏起来的条数
 * @param {number} visibleCount - 当前可见条数
 * @param {number} [pageSize] - 一页的条数，默认 {@link SESSION_WATERMARK_BASE}
 * @returns {number} 新水位
 */
export function nextWatermark(hiddenCount, visibleCount, pageSize = SESSION_WATERMARK_BASE) {
  return nextRowWatermark(hiddenCount, visibleCount, pageSize)
}

/**
 * 会话列表的折叠视图。
 *
 * @param {readonly object[]} rows - 会话行
 * @param {number} storedWatermark - 用户展开出来的水位（0 表示没展开过）
 * @param {(key: string, params?: Record<string, unknown>) => string} t - 当前语言的翻译函数
 * @param {number} [pageSize] - 一页的条数，默认 {@link SESSION_WATERMARK_BASE}
 * @returns {{ rows: object[], hiddenCount: number, expanded: boolean, expandLabel: string }} 视图
 */
export function foldSessions(rows, storedWatermark, currentSessionId, t, pageSize = SESSION_WATERMARK_BASE) {
  const baseline = Math.max(pageSize, requiredWatermark(rows, currentSessionId))
  return foldRows(rows, Math.max(baseline, storedWatermark), {
    pageSize,
    baseline,
    expandLabel: (hiddenCount) => t('session.fold.expand', { count: hiddenCount }),
  })
}
