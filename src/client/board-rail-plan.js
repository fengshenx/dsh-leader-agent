/**
 * 线路图的几何规划（纯函数）。
 *
 * 只做「量好之后的坐标 → 路径字符串」这一段，不碰 DOM：卡面位置由
 * `board-rail.js` 量出来后传进来，这里负责把一张卡片拆成「主干上的 tick + 通往
 * 每个执行者的支线」。拆出来是为了能直接断言形状——SVG 画错比逻辑错更难看出来。
 *
 * 坐标一律是相对看板内容区（`.dsh-leader-agent-board-stage`）的 CSS 像素。
 *
 * @module dsh-leader-agent/client/board-rail-plan
 */

/** 主线在跑：金色。 */
export const RAIL_LANE_HOT = 'hot'

/** 需要人介入：红色，不流动。 */
export const RAIL_LANE_WARN = 'warn'

/** 静态绑定：灰色。 */
export const RAIL_LANE_MUTED = 'muted'

/**
 * 卡片信号 → 线的语义。
 *
 * 只有「执行中」和「需注意」值得用颜色区分；空闲、未读、未派工都只是静态绑定，
 * 用同一种灰线——线太多颜色时，金色就不再表示「有数据在流动」。
 *
 * @param {string} status - 卡面信号（`cardSignal` 的结果）
 * @returns {string} `hot` / `warn` / `muted`
 */
export function railLaneKind(status) {
  if (status === 'running') return RAIL_LANE_HOT
  if (status === 'attention') return RAIL_LANE_WARN
  return RAIL_LANE_MUTED
}

/**
 * 卡片信号 → 主干节点的状态类。
 *
 * @param {string} status - 卡面信号
 * @returns {string} `running` / `attention` / `idle`
 */
export function railNodeState(status) {
  if (status === 'running') return 'running'
  if (status === 'attention') return 'attention'
  return 'idle'
}

/**
 * 坐标取一位小数：够准，且路径字符串稳定，不会被浮点尾巴搅得每次重建。
 *
 * @param {number} value - 原始坐标
 * @returns {number} 取整后的坐标
 */
function px(value) {
  return Math.round(value * 10) / 10
}

/**
 * 主干到卡片的一段：先沿主干下行，再横着拐进卡面左缘。
 *
 * @param {object} input - 几何
 * @param {number} input.trunkX - 主干 x
 * @param {number} input.fromY - 上一段终点 y（首段是 leader 节点）
 * @param {number} input.cy - 这张卡的中心 y
 * @param {number} input.cardX - 卡面左缘 x
 * @returns {string} SVG path
 */
export function railTickPath({ trunkX, fromY, cy, cardX }) {
  return `M${px(trunkX)},${px(fromY)} L${px(trunkX)},${px(cy)} L${px(cardX)},${px(cy)}`
}

/**
 * 卡面右缘到执行者圆点的一段曲线。
 *
 * 控制点分别从两端出发，形成一条两端水平的 S 弯；间距小于 20px 时也保留一点
 * 弯度，否则短支线会退化成直线，和 tick 分不开。
 *
 * @param {object} input - 几何
 * @param {number} input.cardRight - 卡面右缘 x
 * @param {number} input.cy - 卡面中心 y
 * @param {number} input.slotX - 执行者圆点中心 x
 * @param {number} input.slotY - 执行者圆点中心 y
 * @returns {string} SVG path
 */
export function railBranchPath({ cardRight, cy, slotX, slotY }) {
  const bend = Math.max(10, (slotX - cardRight) / 2)
  return `M${px(cardRight)},${px(cy)} C${px(cardRight + bend)},${px(cy)} ${px(slotX - bend)},${px(slotY)} ${px(slotX)},${px(slotY)}`
}

/**
 * 正交走线：先向右出线，再竖直，再向右进圆点；拐角用 5px 圆角。
 *
 * 直角比 S 弯更像电路图，也让「出线点 → 竖槽」的距离一眼可读。竖槽很窄时
 * 退化成一条直线，避免拐点跑到圆点右边去。
 *
 * @param {object} input - 几何
 * @param {number} input.cardRight - 卡面右缘 x
 * @param {number} input.cy - 卡面中心 y
 * @param {number} input.slotX - 执行者圆点左缘 x
 * @param {number} input.slotY - 执行者圆点中心 y
 * @returns {string} SVG path
 */
export function railOrthoBranchPath({ cardRight, cy, slotX, slotY }) {
  const elbow = Math.min(cardRight + 16, slotX - 6)
  const radius = 5
  const dy = slotY - cy
  if (Math.abs(dy) < radius * 2 || elbow <= cardRight) {
    return `M${px(cardRight)},${px(cy)} L${px(slotX)},${px(slotY)}`
  }
  const dir = dy > 0 ? 1 : -1
  return [
    `M${px(cardRight)},${px(cy)}`,
    `L${px(elbow - radius)},${px(cy)}`,
    `Q${px(elbow)},${px(cy)} ${px(elbow)},${px(cy + dir * radius)}`,
    `L${px(elbow)},${px(slotY - dir * radius)}`,
    `Q${px(elbow)},${px(slotY)} ${px(elbow + radius)},${px(slotY)}`,
    `L${px(slotX)},${px(slotY)}`,
  ].join(' ')
}

/**
 * 把量好的行几何拆成线。
 *
 * 每行产出一条 tick 与若干支线；支线数量等于该行实际渲染的执行者圆点数。没有
 * 绑定会话的卡不产支线——空线不画，画面上没有支线本身就是「这张卡还没派人」。
 *
 * @param {object} input - 几何
 * @param {number} input.trunkX - 主干 x
 * @param {number} input.leaderY - leader 节点中心 y
 * @param {Array<{ status: string, cardX: number, cardRight: number, cy: number, slots?: Array<{ x: number, y: number }> }>} input.rows
 *   自上而下的行几何
 * @param {boolean} [input.orthogonal] - 支线走直角（浅色皮的电路感）
 * @returns {Array<{ id: string, kind: string, d: string }>} 线路列表
 */
export function planRailLanes({ trunkX, leaderY, rows, orthogonal }) {
  const lanes = []
  let fromY = leaderY
  rows.forEach((row, index) => {
    lanes.push({
      id: `tick:${index}`,
      kind: railLaneKind(row.status),
      d: railTickPath({ trunkX, fromY, cy: row.cy, cardX: row.cardX }),
    })
    const slots = Array.isArray(row.slots) ? row.slots : []
    slots.forEach((slot, slotIndex) => {
      lanes.push({
        id: `branch:${index}:${slotIndex}`,
        kind: railLaneKind(row.status),
        d: orthogonal
          ? railOrthoBranchPath({ cardRight: row.cardRight, cy: row.cy, slotX: slot.x, slotY: slot.y })
          : railBranchPath({ cardRight: row.cardRight, cy: row.cy, slotX: slot.x, slotY: slot.y }),
      })
    })
    fromY = row.cy
  })
  return lanes
}
