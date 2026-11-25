/**
 * 线路图的绘制签名（纯函数）。
 *
 * `drawRail` 的全部几何都来自渲染后实测：stage 尺寸、每行的纵向位置与高度、
 * 卡片矩形的中心。签名必须覆盖这些输入——只比宽度时，标题从 1 行变 2 行、
 * locale 或字体换掉都会移动行中心，而宽度与内容签名不变，覆盖层就停在旧几何上。
 *
 * 行几何单独进签名还有两个理由：`clientHeight` 是取整后的值，亚像素变化可能
 * 看不出来；同一轮里「一行增高、一行变矮」也可能让总高不变。行坐标已减掉
 * stage 原点，滚动不会改变签名。
 *
 * @module dsh-leader-agent/client/board-rail-signature
 */

/**
 * 算这一层 SVG 的绘制签名。
 *
 * @param {object} input - 签名输入
 * @param {string} input.railKey - 行身份、卡面信号与槽位状态
 * @param {boolean} input.orthogonal - 是否直角走线
 * @param {string} input.theme - 宿主主题（`light` / `dark`）
 * @param {boolean} input.reduced - 是否要求减少动态效果
 * @param {number} input.width - stage 的布局宽度（CSS 像素，可含小数）
 * @param {number} input.height - stage 的布局高度
 * @param {Array<{ top: number, height: number }>} input.rows - 每行相对 stage 的纵向几何
 * @returns {string} 绘制签名
 */
export function railSignature({ railKey, orthogonal, theme, reduced, width, height, rows }) {
  const geometry = rows.map((row) => `${row.top}:${row.height}`).join(',')
  return `${railKey}|${orthogonal}|${theme}|${reduced}|${width}x${height}#${geometry}`
}
