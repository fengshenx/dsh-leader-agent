/**
 * 系统「减少动态效果」偏好的读取与订阅。
 *
 * `drawRail` 里读一次偏好是不够的：用户在系统设置里中途打开 reduce 后，CSS 动画
 * 会停，但已经挂上的 SMIL `animateMotion` 光点不会停。订阅 media query 的变化，
 * 让绘制层在偏好切换时重画一次，光点才会跟着消失。
 *
 * 抽成独立模块是为了能在 node:test 里用假 `matchMedia` 钉住订阅与退订；真实
 * 媒体查询的状态不经过组件也能验证。
 *
 * @module dsh-leader-agent/client/motion-preference
 */

/** 查询串只在这里出现一次，避免读取与订阅走成两套。 */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * 当前是否要求减少动态效果。读不到就按不减少处理。
 *
 * @param {object} [scope] - 带 `matchMedia` 的全局对象
 * @returns {boolean} 是否减少
 */
export function prefersReducedMotion(scope = globalThis) {
  try {
    return scope?.matchMedia?.(REDUCED_MOTION_QUERY)?.matches === true
  } catch {
    return false
  }
}

/**
 * 订阅「减少动态效果」偏好的变化。
 *
 * 初始值由调用方用 {@link prefersReducedMotion} 读；这里只管后续变化。老 WebKit
 * 只有 `addListener`，一并兜住；两者都没有时什么也不订阅。
 *
 * @param {object} scope - 带 `matchMedia` 的全局对象
 * @param {(reduced: boolean) => void} onChange - 偏好变化回调
 * @returns {() => void} 取消订阅
 */
export function watchReducedMotion(scope, onChange) {
  let query
  try {
    query = scope?.matchMedia?.(REDUCED_MOTION_QUERY)
  } catch {
    return () => {}
  }
  if (query === undefined || query === null) return () => {}
  const listener = () => { onChange(query.matches === true) }
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', listener)
    return () => { query.removeEventListener('change', listener) }
  }
  if (typeof query.addListener === 'function') {
    query.addListener(listener)
    return () => { query.removeListener(listener) }
  }
  return () => {}
}
