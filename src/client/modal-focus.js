/**
 * 浮层的焦点循环与关闭判定。
 *
 * 判定规则对齐宿主 `packages/client/ui-primitives/src/useModalLayer.ts`，但按本仓的
 * 单层浮层场景做了简化，省略了宿主的三处机制：
 *
 * - **浮层层级栈**：宿主只让顶层浮层响应 Escape 与 Tab。本仓的浮层不叠加——左栏的
 *   确认框与右栏的卡片详情各有全屏遮罩，不会同时开着。
 * - **portaled 菜单豁免**：宿主在焦点位于 `[role="menu"]` 里时放行，让菜单自己管
 *   遍历。本仓浮层里没有菜单。
 * - **组合输入守护**：宿主自己维护 composition 状态（`event.isComposing` 在部分
 *   浏览器不可靠）。卡片详情的链接编辑态里有输入框，组合态下按 Escape 的风险是
 *   存在的：这里只在按键判断里留一个 `isComposing` 检查，编辑器自己的回车提交
 *   另按 `keyCode === 229` 兜底（Safari 确认候选词时 `isComposing` 已是 false）。
 *
 * 这里把判定从 DOM 事件里拆出来，是因为「Tab 到边缘要绕回」「Escape 要不要关」
 * 这两条是浮层最容易写错的地方，而它们不必依赖真实 DOM 就能断言。
 *
 * @module dsh-leader-agent/client/modal-focus
 */

/** 可聚焦元素的选取规则，与宿主 `useModalLayer` 一致。 */
export const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'

/**
 * 初始聚焦的元素。
 *
 * 优先 `[data-modal-autofocus]` 标记的元素，其次第一个可聚焦元素，都没有就聚焦
 * 浮层容器本身（它有 `tabIndex="-1"`，至少能接住键盘）。
 *
 * @param {HTMLElement} root - 浮层容器
 * @param {(element: HTMLElement, selector: string) => HTMLElement | null} [query] - 查询函数
 * @returns {HTMLElement} 应聚焦的元素
 */
export function pickInitialFocus(root, query = (element, selector) => element.querySelector(selector)) {
  return query(root, '[data-modal-autofocus]') ?? query(root, FOCUSABLE) ?? root
}

/**
 * 按下 Tab 时焦点该落到哪。
 *
 * 焦点已经在边缘时绕回另一端；焦点不在可聚焦元素里（浮层容器本身，或焦点跑到
 * 浮层外）时收进第一个（或 Shift+Tab 时的最后一个）。
 *
 * 与宿主有一处刻意不同：宿主用「焦点是否在浮层内」判断，焦点落在浮层内的
 * 非可聚焦元素上（如标题）时放行浏览器默认遍历；这里用「焦点是否在可聚焦元素
 * 列表里」判断，落在非可聚焦元素上时也收边——否则 Shift+Tab 会从标题跑出浮层，
 * 焦点陷阱漏风。
 *
 * @param {readonly object[]} items - 可聚焦元素，按 DOM 顺序
 * @param {object | null} active - 当前聚焦的元素
 * @param {boolean} shift - 是否是 Shift+Tab
 * @param {object | null} [fallback] - 没有可聚焦元素时的落点
 * @returns {{ target: object | null, preventDefault: boolean }} 目标元素与是否阻止默认行为
 */
export function nextFocusTarget(items, active, shift, fallback = null) {
  if (items.length === 0) return { target: fallback, preventDefault: true }
  const first = items[0]
  const last = items[items.length - 1]
  if (active === null || active === undefined || !items.includes(active)) {
    return { target: shift ? last : first, preventDefault: true }
  }
  const atEdge = shift ? active === first : active === last
  if (!atEdge) return { target: null, preventDefault: false }
  return { target: shift ? last : first, preventDefault: true }
}

/**
 * 键盘事件是否该被浮层忽略。
 *
 * 组合输入中的按键、带修饰键的按键与已被处理过的事件都不该动浮层。
 *
 * @param {object} event - 键盘事件
 * @returns {boolean} 是否忽略
 */
export function isKeyboardEventBlocked(event) {
  return event.defaultPrevented === true
    || event.isComposing === true
    || event.ctrlKey === true
    || event.altKey === true
    || event.metaKey === true
}

/**
 * 按下 Escape 时该做什么。
 *
 * @param {object} event - 键盘事件
 * @returns {'ignore' | 'prevent-only' | 'close'} 动作
 */
export function escapeAction(event) {
  if (event.key !== 'Escape' || event.shiftKey === true) return 'ignore'
  // 长按 Escape 的重复事件只阻止默认行为，不重复关闭
  return event.repeat === true ? 'prevent-only' : 'close'
}
