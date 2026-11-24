/**
 * 主区域槽位与容器的定位。
 *
 * 两个 client 半边都要在主面板上做文章：标签栏把节点插到会话头之上，leader
 * 会话的改动文件汇总靠容器的标记做渲染层隐藏。定位规则只留一份，宿主换掉
 * 槽位标记时两处一起失效、一起修。
 *
 * 判据与兜底见 {@link findMainSlot}；`[class*="mainPanel"]` 依赖宿主 CSS module
 * 类名保留词干，是与宿主结构的耦合点，记录在 docs/limitations.md。
 *
 * @module dsh-leader-agent/client/main-panel
 */

/**
 * 找主面板槽位。
 *
 * 当前宿主（app.asar 实测）用 class 名含 `mainPanel` 的节点作主面板；
 * `data-slot="main"` 是旧版 / 兼容兜底（当前宿主精确搜索 0 命中）。改版时优先
 * 跟着真实的 `mainPanel` 走，旧标记只负责兼容。
 *
 * @returns {Element | null} 槽位节点
 */
export function findMainPanel() {
  if (typeof document === 'undefined') return null
  return document.querySelector('#root [class*="mainPanel"]')
    ?? document.querySelector('[class*="mainPanel"]')
}

/**
 * 找主面板槽位（含旧版兜底）。
 *
 * `data-slot="main"` 只用于标签栏落位；卡片隐藏在 `mainPanel` 消失时必须能
 * 摘标记，所以隐藏逻辑单独用 {@link findMainPanel}，不落到旧标记上。
 *
 * @returns {Element | null} 槽位节点
 */
export function findMainSlot() {
  if (typeof document === 'undefined') return null
  return findMainPanel()
    ?? document.querySelector('#root [data-slot="main"]')
    ?? document.querySelector('[data-slot="main"]')
}

/**
 * 找主面板的容器。
 *
 * 槽位外面可能还套着带 `data-slot` 的包装；往上走到最后一个带槽位标记的节点。
 * 标签栏需要父列来插栏，不能直接用 `mainPanel` 本身。
 *
 * @param {Element} slot - 主槽位
 * @returns {Element} 容器
 */
export function findColumn(slot) {
  let column = slot.parentElement
  while (column !== null && column.hasAttribute('data-slot') && column.parentElement !== null) {
    column = column.parentElement
  }
  return column ?? slot
}

/**
 * 跳过 `display:contents` 包装，取真正占布局的会话体。
 *
 * @param {Element} slot - 主槽位
 * @returns {Element | null} 会话体
 */
export function mainBodyOf(slot) {
  let body = slot.firstElementChild
  while (body !== null && typeof window !== 'undefined' && window.getComputedStyle(body).display === 'contents') {
    body = body.firstElementChild
  }
  return body
}
