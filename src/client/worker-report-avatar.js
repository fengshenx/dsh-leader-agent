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
 * seed 同一个 worker 会跨任务换脸。保持 `<img src="data:image/svg+xml,...">`，
 * 不内联 SVG，也不引 blobatar 的 motion / gaze 入口。
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
 * 用鞋带公式算闭合路径面积；曲线按 24 段折线采样，误差远小于一个 viewBox 单位。
 * @param {string} d - 绝对坐标的 SVG path
 * @returns {number} 面积
 */
function pathArea(d) {
  const tokens = d.match(PATH_TOKEN)
  let cursor = [0, 0]
  let start = [0, 0]
  let area = 0
  let index = 0

  const lineTo = (x, y) => {
    area += cursor[0] * y - x * cursor[1]
    cursor = [x, y]
  }

  while (index < tokens.length) {
    const command = tokens[index++]
    if (command === 'M') {
      start = [Number(tokens[index++]), Number(tokens[index++])]
      cursor = start
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
      for (let step = 1; step <= 24; step++) {
        const t = step / 24
        const rest = 1 - t
        const a = rest * rest * rest
        const b = 3 * rest * rest * t
        const c = 3 * rest * t * t
        const e = t * t * t
        lineTo(a * from[0] + b * x1 + c * x2 + e * x, a * from[1] + b * y1 + c * y2 + e * y)
      }
    } else if (command === 'Q') {
      const x1 = Number(tokens[index++])
      const y1 = Number(tokens[index++])
      const x = Number(tokens[index++])
      const y = Number(tokens[index++])
      const from = cursor
      for (let step = 1; step <= 24; step++) {
        const t = step / 24
        const rest = 1 - t
        lineTo(rest * rest * from[0] + 2 * rest * t * x1 + t * t * x, rest * rest * from[1] + 2 * rest * t * y1 + t * t * y)
      }
    } else if (command === 'Z') {
      lineTo(start[0], start[1])
    }
  }

  return Math.abs(area) / 2
}

/**
 * 把路径绕身体中心缩放，并把中心搬到 viewBox 的 (50, 50)。
 * @param {string} d - 绝对坐标的 SVG path
 * @param {number} scale - 缩放系数
 * @param {number} cx - 身体中心 x
 * @param {number} cy - 身体中心 y
 * @returns {string} 变换后的 path
 */
function transformPath(d, scale, cx, cy) {
  const tokens = d.match(PATH_TOKEN)
  let index = 0
  let output = ''

  const pair = () => {
    const x = round2(50 + (Number(tokens[index++]) - cx) * scale)
    const y = round2(50 + (Number(tokens[index++]) - cy) * scale)
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
 * 名字 → SVG data URI（走 `<img src>`，不引入内联 SVG 注入面）。
 * @param {string} name - worker 身份名
 * @returns {string} data URI
 */
export function agentAvatarDataUri(name) {
  const options = { traits: { shape: SHAPE_BANDS, tone: TONE_BANDS } }
  const layout = _layout(name, options)
  const svg = blobatar(name, options)
  const bodyGroup = BODY_GROUP.exec(svg)
  const bodyMarkup = bodyGroup[2]
  const eyeGroup = BODY_GROUP.exec(svg.slice(bodyGroup.index + bodyGroup[0].length))
  const eyeMarkup = eyeGroup[2]

  const bodyPaths = [...bodyMarkup.matchAll(/<path d="([^"]+)"\/>/g)].map((match) => match[1])
  const eyePaths = [...eyeMarkup.matchAll(/<path d="([^"]+)"\/>/g)].map((match) => match[1])
  const area = bodyPaths.reduce((sum, d) => sum + pathArea(d), 0)
  const scale = TARGET_RADIUS / Math.sqrt(area / Math.PI)
  const head = bodyGroup[1]
  const eye = eyeGroup[1]

  const body = bodyPaths.map((d) => `<path d="${transformPath(d, scale, layout.body.cx, layout.body.cy)}"/>`).join('')
  const eyes = eyePaths.map((d) => `<path d="${transformPath(d, scale, layout.body.cx, layout.body.cy)}"/>`).join('')
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" data-shape="${layout.shape}">`
    + `<g fill="${head}" stroke="${darken(head)}" stroke-width="${STROKE_WIDTH}" stroke-linejoin="round">${body}</g>`
    + `<g fill="${eye}">${eyes}</g></svg>`

  return `data:image/svg+xml,${encodeURIComponent(markup)}`
}
