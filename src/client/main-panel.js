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
 * 宿主在 web-app 的壳层给主区域标了 `data-slot="main"`；`[class*="mainPanel"]`
 * 是宿主改掉槽位标记时的兜底（CSS module 的类名保留了 `mainPanel` 词干）。
 *
 * @returns {Element | null} 槽位节点
 */
export function findMainSlot() {
  if (typeof document === 'undefined') return null
  return document.querySelector('#root [data-slot="main"]')
    ?? document.querySelector('[data-slot="main"]')
    ?? document.querySelector('[class*="mainPanel"]')
}

/**
 * 找主面板的容器。
 *
 * 槽位外面可能还套着带 `data-slot` 的包装；往上走到最后一个带槽位标记的节点。
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
