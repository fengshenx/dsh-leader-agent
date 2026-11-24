/**
 * 线路图覆盖层：在卡片列表下面垫一层 SVG，画出主干、节点与支线。
 *
 * 它不改列表的 DOM 语义——卡片、链接、会话入口都还是原来的元素，这一层只负责
 * 「看得见连线」。所有几何都在渲染后实测：卡面高度随标题换行变，语言一换就变，
 * 写死坐标的图在别的语言下必然错位。
 *
 * 动画只给「执行中」的线：金色光点沿路径跑，来源是槽位会话快照的 running 跳变，
 * 不是随机装饰。`prefers-reduced-motion` 下只留静态线，不跑光点。
 *
 * @module dsh-leader-agent/client/board-rail
 */

import { createElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { planRailLanes, railNodeState, RAIL_LANE_HOT, RAIL_LANE_WARN } from './board-rail-plan.js'
import { prefersReducedMotion, watchReducedMotion } from './motion-preference.js'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * 同时跑光点的上限。
 *
 * 二十张卡一起亮不是「工作流」，是圣诞树；超过这个数只保留静态金色，不再跑头。
 */
const MAX_ANIMATED_LANES = 6

/**
 * 造一个 SVG 元素。
 *
 * @param {string} tag - 标签名
 * @param {Record<string, unknown>} [attrs] - 属性
 * @returns {object} SVG 元素
 */
function svgNode(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

/**
 * 造一条路径。
 *
 * @param {string} d - path 数据
 * @param {string} className - 类名
 * @returns {object} SVG path
 */
function pathNode(d, className) {
  return svgNode('path', { d, class: className })
}

/**
 * 跟随系统的「减少动态效果」偏好。
 *
 * SMIL 光点不受 CSS 媒体查询管：偏好如果在看板打开后才切到 reduce，已经挂上的
 * comet 会继续跑。订阅变化后重画，绘制层才能把光点摘掉。
 *
 * @returns {boolean} 当前是否要求减少动态效果
 */
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => watchReducedMotion(globalThis, setReduced), [])
  return reduced
}

/**
 * 让一段金色高亮沿路径流动。
 *
 * dash 长度按路径实测长度给：短支线整条亮，长主干留一段跑动的光。用 CSS 变量把
 * 起止偏移带到 keyframes 里，避免为每条线写一份样式。
 *
 * @param {object} path - SVG path
 * @param {number} phase - 相位，错开同时起跑的光点
 * @returns {void}
 */
function primeFlow(path, phase) {
  let length = 200
  try {
    length = path.getTotalLength()
  } catch {
    // 路径退化（零长度）时按默认长度算，最多是一段不动的线
  }
  const dash = Math.min(120, Math.max(44, length * 0.55))
  path.style.strokeDasharray = `${dash} ${length + dash * 2}`
  path.style.setProperty('--dla-from', `${dash}px`)
  path.style.setProperty('--dla-to', `${-(length + dash * 2)}px`)
  path.style.animationDelay = `${-(phase % 7) * 0.31}s`
}

/**
 * 量一个元素相对内容区的矩形。
 *
 * @param {object} element - DOM 元素
 * @param {DOMRect} base - 内容区矩形
 * @returns {{x: number, y: number, cx: number, cy: number, right: number}} 相对坐标
 */
function measure(element, base) {
  const rect = element.getBoundingClientRect()
  return {
    x: rect.left - base.left,
    y: rect.top - base.top,
    cx: rect.left - base.left + rect.width / 2,
    cy: rect.top - base.top + rect.height / 2,
    right: rect.right - base.left,
  }
}

/**
 * 重画整张线路图。
 *
 * @param {object} svg - 覆盖层
 * @param {{ orthogonal?: boolean, theme?: string, reduced?: boolean }} options - 走线方式、主题与动效偏好
 * @returns {void}
 */
function drawRail(svg, options = {}) {
  const stage = svg.parentElement
  if (stage === null) return
  svg.replaceChildren()

  const rowElements = [...stage.querySelectorAll('[data-rail-row]')]
  if (rowElements.length === 0) return

  const base = stage.getBoundingClientRect()
  const dot = stage.querySelector('[data-rail-leader-dot]')
  const leader = dot === null ? { cx: 20, cy: 0 } : measure(dot, base)

  const rows = []
  for (const row of rowElements) {
    const cardElement = row.querySelector('.dsh-leader-agent-board-card')
    if (cardElement === null) continue
    const card = measure(cardElement, base)
    const slots = [...row.querySelectorAll('[data-rail-slot]')]
      .map((slot) => {
        const rect = measure(slot, base)
        // 支线停在圆点左缘外 2px：画到圆心上会从首字上穿过去
        return { x: rect.cx - 12, y: rect.cy, status: slot.dataset.railState }
      })
    rows.push({
      status: row.dataset.railStatus ?? 'none',
      cardX: card.x,
      cardRight: card.right,
      cy: card.cy,
      slots,
    })
  }
  if (rows.length === 0) return

  const trunkX = leader.cx
  const lastY = rows[rows.length - 1].cy
  svg.appendChild(pathNode(`M${trunkX},${leader.cy} L${trunkX},${lastY}`, 'dsh-leader-agent-board-rail-trunk'))

  rows.forEach((row) => {
    const nodeClass = `dsh-leader-agent-board-rail-node dsh-leader-agent-board-rail-node-${railNodeState(row.status)}`
    svg.appendChild(options.orthogonal === true
      ? svgNode('rect', { x: trunkX - 3.2, y: row.cy - 3.2, width: 6.4, height: 6.4, rx: 1.2, class: nodeClass })
      : svgNode('circle', { cx: trunkX, cy: row.cy, r: 3.4, class: nodeClass }))
    // 浅色皮的节点是方块，再加扩散圆环会变成「光晕」，那正是浅色最忌讳的材质
    if (row.status === 'running' && options.theme !== 'light') {
      svg.appendChild(svgNode('circle', {
        cx: trunkX,
        cy: row.cy,
        r: 9,
        class: 'dsh-leader-agent-board-rail-halo',
      }))
    }
  })

  const reduced = options.reduced === true
  let animated = 0
  planRailLanes({ trunkX, leaderY: leader.cy, rows, orthogonal: options.orthogonal }).forEach((lane, index) => {
    if (lane.kind === RAIL_LANE_HOT) {
      svg.appendChild(pathNode(lane.d, 'dsh-leader-agent-board-rail-hot'))
      if (reduced || animated >= MAX_ANIMATED_LANES) return
      animated += 1
      const trail = pathNode(lane.d, 'dsh-leader-agent-board-rail-trail')
      svg.appendChild(trail)
      primeFlow(trail, index)
      const comet = svgNode('circle', { r: 3, class: 'dsh-leader-agent-board-rail-comet' })
      comet.appendChild(svgNode('animateMotion', {
        dur: '2400ms',
        begin: `${(index % 7) * 0.28}s`,
        repeatCount: 'indefinite',
        path: lane.d,
      }))
      svg.appendChild(comet)
      return
    }
    if (lane.kind === RAIL_LANE_WARN) {
      svg.appendChild(pathNode(lane.d, 'dsh-leader-agent-board-rail-warn'))
      return
    }
    svg.appendChild(pathNode(lane.d, 'dsh-leader-agent-board-rail-edge'))
  })
}

/**
 * 线路图覆盖层。
 *
 * `railKey` 是行身份与状态的签名：卡片轮询每 2 秒会换一个新数组，但签名不变时
 * 不必重画——重画会让光点从头再跑一遍。
 *
 * @param {object} props - 组件属性
 * @param {string} props.railKey - 行与状态的签名
 * @returns {object} React 元素
 */
export function BoardRail({ railKey, orthogonal, theme }) {
  const ref = useRef(null)
  const reduced = usePrefersReducedMotion()
  // 最近一次真正画上去的签名。隐藏/显示只改可见性，不改内容与几何；用它把
  // 「右栏重新可见」的 0 → N 尺寸变化挡在重画之外——重画会重建 SVG，SMIL
  // 光点跟着从头起跑。
  const drawnKey = useRef('')

  useLayoutEffect(() => {
    const svg = ref.current
    if (svg === null) return undefined
    const stage = svg.parentElement
    if (stage === null) return undefined
    let timer = 0
    const draw = () => {
      // 宿主用 display:none 隐藏非当前会话的右栏：尺寸归零不是布局变化
      if (stage.clientWidth === 0 || stage.clientHeight === 0) return
      // 宽度决定卡片换行与行高，是线路几何的唯一外部变量；宽度没变、内容签名
      // 没变时，重画的结果与现在这层 SVG 相同，不必重建动画节点。
      const key = `${railKey}|${orthogonal}|${theme}|${reduced}|${stage.clientWidth}`
      if (key === drawnKey.current) return
      drawnKey.current = key
      drawRail(svg, { orthogonal, theme, reduced })
    }
    draw()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      // 面板过渡期间尺寸可能连续变化：等稳定后只画一次，避免每帧重建
      clearTimeout(timer)
      timer = setTimeout(draw, 80)
    })
    observer.observe(stage)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [railKey, orthogonal, theme, reduced])

  return createElement('svg', {
    ref,
    className: 'dsh-leader-agent-board-rail',
    'aria-hidden': 'true',
  })
}
