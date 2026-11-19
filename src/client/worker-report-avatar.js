/**
 * agent 头像：blobatar 的「一个身体 + 两只胶囊眼」，worker 与 leader 共用。
 *
 * blobatar 用名字哈希决定形状、色相与表情，同一名字跨会话、跨重启恒定。这里只开放
 * 五种 20px 下仍立得住的形状，并把颜色锁在 mid / bright 两档：其余形状在 20px 下
 * 会变成扁条或一串凸起，pale / ink 两档会退成灰点或暗块。
 *
 * 身体铺同色相 ×0.62 的深色描边，宽 2.5（viewBox 单位）：浅色主题靠这圈描边立住
 * 轮廓，深色主题由亮身体本身承担；不铺底色块，避免深色主题上出现白方块。
 *
 * 五种形状的 core 系数与 body.r 都有随机范围，直接渲染会让 boxy 偏小、六边形面积
 * 只剩同半径圆的 83%。这里按渲染出的路径面积（π·r²）反推缩放，统一到半径 34，
 * 让每个头像在 20px 列表里占同样大的视觉面积。
 *
 * seed 取 worker 的身份名（派工 label）：label 由任务描述派生、随任务变，拿它做
 * seed 同一个 worker 会跨任务换脸。头像以内联 SVG 渲染，眼睛分组留给气泡 CSS
 * 做 hover 眨眼；不引 blobatar 的 motion / gaze 入口，动效只由本地样式控制。
 *
 * @module dsh-leader-agent/client/worker-report-avatar
 */

import { blobatar, _layout } from 'blobatar'

/** blobatar 的 shape band 位置；只开放这五种已验证的形状。 */
const SHAPE_BANDS = [0.11, 0.35, 0.54, 0.9, 0.93]

/** 只取 mid / bright 两档 tone，不混 pastel / pale / ink。 */
const TONE_BANDS = [0.4, 0.8]

/** viewBox 100 内的面积等效半径。 */
const TARGET_RADIUS = 34

/** 描边 = 身体色同色相 ×0.62。 */
const STROKE_FACTOR = 0.62

/** 与 viewBox 单位一致的描边宽度（20px 下约 0.5px）。 */
const STROKE_WIDTH = 2.5

/** blobatar 的坐标命令；白名单形状只会产出这几种绝对命令。 */
const PATH_TOKEN = /[A-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g

const BODY_GROUP = /<g fill="([^"]+)">(.*?)<\/g>/s

/**
 * 把数字收成两位小数，减少 data URI 体积。
 * @param {number} value - 数值
 * @returns {number} 两位小数
 */
function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * 按 sRGB 分量乘系数，得到同色相的深色描边。
 * @param {string} hex - `#rrggbb`
 * @returns {string} 深色 `#rrggbb`
 */
function darken(hex) {
  const channels = hex.slice(1).match(/[0-9a-f]{2}/gi)
  return '#' + channels
    .map((channel) => Math.round(Number.parseInt(channel, 16) * STROKE_FACTOR).toString(16).padStart(2, '0'))
    .join('')
}

/**
 * 把路径采样成闭合多边形；曲线按 24 段折线表示，误差远小于一个 viewBox 单位。
 * @param {string} d - 绝对坐标的 SVG path
 * @param {number} [steps] - 每段曲线的采样段数
 * @returns {number[][]} 多边形顶点
 */
function pathPolygon(d, steps = 24) {
  const tokens = d.match(PATH_TOKEN)
  const points = []
  let cursor = [0, 0]
  let start = [0, 0]
  let index = 0

  const lineTo = (x, y) => {
    points.push([x, y])
    cursor = [x, y]
  }

  while (index < tokens.length) {
    const command = tokens[index++]
    if (command === 'M') {
      start = [Number(tokens[index++]), Number(tokens[index++])]
      cursor = start
      points.push(start)
    } else if (command === 'L') {
      lineTo(Number(tokens[index++]), Number(tokens[index++]))
    } else if (command === 'C') {
      const x1 = Number(tokens[index++])
      const y1 = Number(tokens[index++])
      const x2 = Number(tokens[index++])
      const y2 = Number(tokens[index++])
      const x = Number(tokens[index++])
      const y = Number(tokens[index++])
      const from = cursor
      for (let step = 1; step <= steps; step++) {
        const t = step / steps
        const rest = 1 - t
        lineTo(
          rest ** 3 * from[0] + 3 * rest ** 2 * t * x1 + 3 * rest * t ** 2 * x2 + t ** 3 * x,
          rest ** 3 * from[1] + 3 * rest ** 2 * t * y1 + 3 * rest * t ** 2 * y2 + t ** 3 * y,
        )
      }
    } else if (command === 'Q') {
      const x1 = Number(tokens[index++])
      const y1 = Number(tokens[index++])
      const x = Number(tokens[index++])
      const y = Number(tokens[index++])
      const from = cursor
      for (let step = 1; step <= steps; step++) {
        const t = step / steps
        const rest = 1 - t
        lineTo(
          rest ** 2 * from[0] + 2 * rest * t * x1 + t ** 2 * x,
          rest ** 2 * from[1] + 2 * rest * t * y1 + t ** 2 * y,
        )
      }
    } else if (command === 'Z') {
      lineTo(start[0], start[1])
    }
  }

  return points
}

/**
 * 鞋带公式求多边形面积。
 * @param {number[][]} points - 多边形顶点
 * @returns {number} 面积
 */
function polygonArea(points) {
  let area = 0
  for (let index = 0; index < points.length; index++) {
    const [x0, y0] = points[index]
    const [x1, y1] = points[(index + 1) % points.length]
    area += x0 * y1 - x1 * y0
  }
  return Math.abs(area) / 2
}

/**
 * 路径面积；需要并集时由调用方先取凸包。
 * @param {string} d - 绝对坐标的 SVG path
 * @returns {number} 面积
 */
function pathArea(d) {
  return polygonArea(pathPolygon(d))
}

/**
 * 单调链凸包。白名单里只有 droplet 是多条 path，它的椭圆与 taper 是相切的
 * 凸形，并集仍是凸集；取凸包就是可见并集轮廓，也避免两条 path 各描一圈留下内缝。
 * @param {number[][]} points - 多边形顶点
 * @returns {number[][]} 凸包顶点
 */
function convexHull(points) {
  const sorted = [...points].sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const cross = (origin, a, b) =>
    (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0])
  const lower = []
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop()
    lower.push(point)
  }
  const upper = []
  for (const point of sorted.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop()
    upper.push(point)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

/**
 * 把路径绕身体中心缩放，并把中心搬到 viewBox 的 (50, 50)；shiftY 用于给 droplet
 * 尖顶的描边留出上边距。
 * @param {string} d - 绝对坐标的 SVG path
 * @param {number} scale - 缩放系数
 * @param {number} cx - 身体中心 x
 * @param {number} cy - 身体中心 y
 * @param {number} [shiftY] - 额外下移量
 * @returns {string} 变换后的 path
 */
function transformPath(d, scale, cx, cy, shiftY = 0) {
  const tokens = d.match(PATH_TOKEN)
  let index = 0
  let output = ''

  const pair = () => {
    const x = round2(50 + (Number(tokens[index++]) - cx) * scale)
    const y = round2(50 + (Number(tokens[index++]) - cy) * scale + shiftY)
    return `${x} ${y}`
  }

  while (index < tokens.length) {
    const command = tokens[index++]
    if (command === 'M' || command === 'L') {
      output += `${command}${pair()}`
    } else if (command === 'C') {
      output += `C${pair()} ${pair()} ${pair()}`
    } else if (command === 'Q') {
      output += `Q${pair()} ${pair()}`
    } else if (command === 'Z') {
      output += 'Z'
    }
  }

  return output
}

/**
 * 把多边形顶点写成缩放后的 path。
 * @param {number[][]} points - 凸包顶点
 * @param {number} scale - 缩放系数
 * @param {number} cx - 身体中心 x
 * @param {number} cy - 身体中心 y
 * @param {number} shiftY - 额外下移量
 * @returns {string} path
 */
function polygonPath(points, scale, cx, cy, shiftY) {
  return 'M' + points
    .map(([x, y]) => `${round2(50 + (x - cx) * scale)} ${round2(50 + (y - cy) * scale + shiftY)}`)
    .join('L') + 'Z'
}

/** 眼睛分组在气泡样式里的类名；hover 眨眼由它定位。 */
export const AVATAR_EYE_CLASS = 'dsh-leader-agent-agent-bubble__avatar-eye'

/**
 * 名字 → 可直接渲染的 SVG 片段。
 *
 * 用内联 SVG 而不是 data URI，眼睛分组才能被气泡 CSS 的 hover 动画选中；名字
 * 不参与拼接，body / eyes 都是数值路径，不引入 HTML 注入面。
 *
 * @param {string} name - worker 身份名
 * @returns {{ shape: string, head: string, stroke: string, eye: string, body: string[], eyes: string[], strokeWidth: number }} 头像几何
 */
export function buildAvatar(name) {
  const options = { traits: { shape: SHAPE_BANDS, tone: TONE_BANDS } }
  const layout = _layout(name, options)
  const svg = blobatar(name, options)
  const bodyGroup = BODY_GROUP.exec(svg)
  const bodyMarkup = bodyGroup[2]
  const eyeGroup = BODY_GROUP.exec(svg.slice(bodyGroup.index + bodyGroup[0].length))
  const eyeMarkup = eyeGroup[2]

  const bodyPaths = [...bodyMarkup.matchAll(/<path d="([^"]+)"\/>/g)].map((match) => match[1])
  const eyePaths = [...eyeMarkup.matchAll(/<path d="([^"]+)"\/>/g)].map((match) => match[1])
  // droplet 的 taper 与椭圆在原始 viewBox 里重叠；按路径直接相加会把重叠区算两次，
  // 头像会缩得偏小。两条 path 的并集轮廓是凸包，按凸包面积反推才是可见面积。
  const union = bodyPaths.length > 1
    ? convexHull(bodyPaths.flatMap((d) => pathPolygon(d, 32)))
    : null
  const area = union === null ? bodyPaths.reduce((sum, d) => sum + pathArea(d), 0) : polygonArea(union)
  const scale = TARGET_RADIUS / Math.sqrt(area / Math.PI)
  const head = bodyGroup[1]
  const eye = eyeGroup[1]

  const padding = STROKE_WIDTH / 2 + 0.25
  const shiftY = union === null
    ? 0
    : Math.max(0, padding - Math.min(...union.map(([, y]) => 50 + (y - layout.body.cy) * scale)))
  const body = union === null
    ? bodyPaths.map((d) => transformPath(d, scale, layout.body.cx, layout.body.cy))
    : [polygonPath(union, scale, layout.body.cx, layout.body.cy, shiftY)]
  const eyes = eyePaths.map((d) => transformPath(d, scale, layout.body.cx, layout.body.cy, shiftY))

  return { shape: layout.shape, head, stroke: darken(head), eye, body, eyes, strokeWidth: STROKE_WIDTH }
}
