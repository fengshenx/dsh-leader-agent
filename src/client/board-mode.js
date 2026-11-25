/**
 * 看板显示模式：`work`（纯列表，默认）与 `cinema`（线路图）。
 *
 * 这是**显示偏好**，但自 2026-11-25 起和自动续行上限一样存在宿主侧
 * `settings.json` 里，不再写浏览器 localStorage：同一个 dsh 实例下的所有窗口
 * 与项目看到同一份选择，换浏览器或清缓存不会把模式打回默认。
 *
 * 客户端保留一份模块级内存快照：设置页保存成功后广播，看板不必重新异步取数；
 * 其它窗口通过看板 `focus` 时重读宿主设置同步。取不到宿主配置时按默认模式走，
 * 不阻塞渲染。
 *
 * @module dsh-leader-agent/client/board-mode
 */

import {
  BOARD_MODE_CINEMA,
  BOARD_MODE_DEFAULT,
  BOARD_MODE_WORK,
  BOARD_MODES,
  normalizeBoardMode,
} from '../shared/settings.js'

export {
  BOARD_MODE_CINEMA,
  BOARD_MODE_DEFAULT,
  BOARD_MODE_WORK,
  BOARD_MODES,
  normalizeBoardMode,
}

/** 当前运行时看到的模式；先按默认值起步，挂载后由宿主设置回填。 */
let current = BOARD_MODE_DEFAULT

/** 同一运行时内的订阅者。设置页写、看板读，都在这张表上。 */
const listeners = new Set()

/**
 * 取当前运行时快照。
 *
 * @returns {string} `work` 或 `cinema`
 */
export function getBoardMode() {
  return current
}

/**
 * 订阅模式变化。
 *
 * @param {(mode: string) => void} listener - 变化回调
 * @returns {() => void} 取消订阅
 */
export function subscribeBoardMode(listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 更新运行时快照并广播。
 *
 * 宿主保存成功后调用；同值不广播，避免设置页与看板的回填互相触发。
 *
 * @param {unknown} mode - 新模式
 * @returns {string} 生效的合法模式
 */
export function setBoardMode(mode) {
  const next = normalizeBoardMode(mode)
  if (next === current) return next
  current = next
  // 先取快照：回调里退订会改动 Set，边迭代边删会漏掉后面的订阅者
  for (const listener of Array.from(listeners)) listener(next)
  return next
}
