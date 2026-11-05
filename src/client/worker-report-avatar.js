/**
 * agent 头像：minidenticons 像素图案（确定性 + 内置 seed 池），worker 与 leader 共用
 *
 * 同一名字恒定同一张脸，跨会话、跨重启都不换脸。头像带自己的
 * 底色（`<img>` 内部不继承 CSS 主题变量），底色明度压到 36% 以过非文本 3:1
 * 基线。
 *
 * 已知边界（不是待修项）：深色主题下彩底轮廓弱——气泡底是中性
 * 深色，36% 的蓝紫色相落上去只有 1.35:1（hue 240），块的外轮廓看不出边界；
 * 头像本身仍可辨（图案对底色 3.4846:1）。这是明确接受的取舍：不描边、不加容器
 * 环、不提亮底色——补救层在 20px 尺寸下会显得又脏又重，代价大于收益。
 *
 * 已知取舍：池子只有 63 个 seed，worker 多时会有撞图（3 个 worker 至少一次撞图
 * 约 4.7%，5 个约 15%）。分布够开（200 个名字命中 61 个 seed），
 * 撞图不影响身份识别——名字就在头像旁边。
 *
 * seed 取 worker 的身份名（派工 label）：label 由任务描述派生、随任务变，拿它做
 * seed 同一 worker 会跨任务换脸。
 *
 * @module dsh-leader-agent/client/worker-report-avatar
 */

import { minidenticon } from 'minidenticons'

/** 内置 seed 池（63 = 9 色相 × 7，字母序） */
export const AGENT_AVATAR_SEEDS = [
  'basalt', 'bloom', 'bolt', 'breeze', 'chalk', 'cipher', 'cliff', 'cloud', 'cobalt',
  'crimson', 'crystal', 'fern', 'field', 'forest', 'forge', 'frost', 'glacier', 'glint',
  'harbor', 'hazel', 'hedge', 'ink', 'ivory', 'kelp', 'lagoon', 'lichen', 'lime',
  'maple', 'meadow', 'mist', 'moss', 'nickel', 'oak', 'onyx', 'orbit', 'ore',
  'pearl', 'plain', 'pond', 'rain', 'raven', 'rope', 'rose', 'ruby', 'salt',
  'sapphire', 'scale', 'shale', 'silver', 'slate', 'stream', 'sun', 'thunder', 'topaz',
  'tundra', 'umber', 'velvet', 'vine', 'wald', 'wave', 'wheat', 'wind', 'zephyr',
]

const SATURATION = 50
const FOREGROUND_LIGHTNESS = 96
const BACKGROUND_LIGHTNESS = 36

/** minidenticon 输出根标签的 hsl 色相（图案与底色同色相） */
const HUE_PATTERN = /hsl\((\d+)/

const FNV_OFFSET_BASIS = 2166136261
const FNV_PRIME = 16777619

/**
 * 背景 rect 覆盖整个 viewBox：调用方裁圆角时底色也铺满，四角不露透明。
 * @param {string} hue - 色相
 * @returns {string} 背景 rect
 */
function backgroundRect(hue) {
  return `<rect x="-1.5" y="-1.5" width="8" height="8" fill="hsl(${hue} ${SATURATION}% ${BACKGROUND_LIGHTNESS}%)"/>`
}

/**
 * 名字 → 池内 seed（FNV-1a 取模，纯函数）。
 * @param {string} name - worker 身份名
 * @returns {string} 池内 seed
 */
export function agentAvatarSeed(name) {
  let hash = FNV_OFFSET_BASIS
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return AGENT_AVATAR_SEEDS[hash % AGENT_AVATAR_SEEDS.length] ?? AGENT_AVATAR_SEEDS[0]
}

/**
 * 名字 → SVG data URI（走 `<img src>`，不引入内联 SVG 注入面）。
 * @param {string} name - worker 身份名
 * @returns {string} data URI
 */
export function agentAvatarDataUri(name) {
  const svg = minidenticon(agentAvatarSeed(name), SATURATION, FOREGROUND_LIGHTNESS)
  const hue = HUE_PATTERN.exec(svg)?.[1] ?? '0'
  const withBackground = svg.replace(/(<svg[^>]*>)/, `$1${backgroundRect(hue)}`)
  return `data:image/svg+xml,${encodeURIComponent(withBackground)}`
}
