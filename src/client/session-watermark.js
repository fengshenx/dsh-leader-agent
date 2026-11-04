/**
 * 项目下会话列表的水位折叠。
 *
 * 口径照宿主工作区树（`WorkspaceBrowser.tsx` 的 `watermarkRows` /
 * `requiredWatermark`）：默认露出 5 条，每次展开再加 5 条，剩余不足 5 条时
 * 一次放完；运行中的会话把水位抬到它所在的位置，但只在前 50 条内生效；水位
 * 只升不降，收起回落到基线。宿主不导出这些函数（UI 包不为绕过包面规则开放
 * 值），只能照同一套口径自己算。
 *
 * 与宿主的已知差异：宿主还会为「有子代理在跑」「等你输入」「未读完成」「当前
 * 会话」抬高水位，我们手里只有会话行的运行态，所以只认 running。
 *
 * @module dsh-leader-agent/client/session-watermark
 */

/** 无会话抬升水位时，每个项目默认露出的会话条数。 */
export const SESSION_WATERMARK_BASE = 5

/** 注意力会话自动抬升的上限；展开操作可以超过它。 */
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
 * 算出「注意力会话」要求的最小水位。
 *
 * 运行中的会话不该被折起来——用户正等着它，藏起来只会让人以为它没了。
 *
 * @param {object[]} rows - 会话行
 * @returns {number} 需要的最小水位；没有注意力会话时是 0
 */
export function requiredWatermark(rows) {
  let required = 0
  for (let index = 0; index < rows.length; index += 1) {
    const position = index + 1
    if (position > SESSION_WATERMARK_AUTO_MAX) break
    if (rows[index]?.running === true) required = position
  }
  return required
}

/**
 * 点「展开其余」之后的新水位。
 *
 * 剩余不足一整页时一次放完（Infinity），否则再放一页——与宿主一致，
 * 最后一步不该只多露出两三条再点一次。
 *
 * @param {number} hiddenCount - 当前被藏起来的条数
 * @param {number} watermark - 当前水位
 * @returns {number} 新水位
 */
export function nextWatermark(hiddenCount, watermark) {
  if (hiddenCount <= SESSION_WATERMARK_BASE) return Infinity
  return watermark + SESSION_WATERMARK_BASE
}

/**
 * 可见条数与按钮文案。
 *
 * @param {object[]} rows - 会话行
 * @param {number} storedWatermark - 用户展开出来的水位（0 表示没展开过）
 * @returns {{ rows: object[], hiddenCount: number, expanded: boolean, expandLabel: string }} 视图
 */
export function foldSessions(rows, storedWatermark) {
  const baseline = Math.max(SESSION_WATERMARK_BASE, requiredWatermark(rows))
  const watermark = Math.max(baseline, storedWatermark)
  const visible = watermarkRows(rows, watermark)
  return {
    ...visible,
    expanded: visible.hiddenCount === 0 && watermark > baseline,
    expandLabel: `展开其余 ${visible.hiddenCount} 个会话`,
  }
}
