/**
 * 一次性提示条（toast）的状态。
 *
 * 只装「说完就该消失」的消息：操作失败、引导下一步。常驻提示会把一次性失败
 * 说成持续状态，一直挂在界面上——删除项目成功后的那句「已删除项目…」就是这么
 * 变成噪音的。
 *
 * 形态对齐宿主自带的 Toast：顶部居中、固定时长后淡出、不拦截点击。同一时刻
 * 只留一条，新消息替换旧消息并重启计时。
 *
 * @module dsh-leader-kit/client/toast
 */

/** 淡出开始前的停留时长；失败文案比一句成功回执更长，比宿主默认的 3 秒多给 1 秒。 */
const HOLD_MS = 4000
/** 淡出时长，必须与样式表里的动画时长一致。 */
const FADE_MS = 1000

let current = null
let sequence = 0
const listeners = new Set()

/**
 * 通知订阅者状态有变。
 * @returns {void}
 */
function emit() {
  for (const listener of listeners) listener()
}

/**
 * 显示一条提示。空字符串不显示——调用方常把「没必要提示」表达成空串。
 * @param {string} text - 提示正文
 * @returns {void}
 */
export function showToast(text) {
  if (typeof text !== 'string' || text === '') return
  current = { id: (sequence += 1), text, holdMs: HOLD_MS, fadeMs: FADE_MS }
  emit()
}

/**
 * 撤掉一条提示。
 *
 * 只撤当前那条：淡出由组件按 id 计时，旧提示的计时器可能晚于新提示到达，
 * 按 id 比对才不会把刚弹出来的那条误撤。
 * @param {number} id - 提示 id
 * @returns {void}
 */
export function dismissToast(id) {
  if (current === null || current.id !== id) return
  current = null
  emit()
}

/**
 * 当前要显示的提示。
 * @returns {{id: number, text: string, holdMs: number, fadeMs: number} | null} 提示；没有时是 null
 */
export function currentToast() {
  return current
}

/**
 * 订阅提示变化。
 * @param {() => void} listener - 变化回调
 * @returns {() => void} 取消订阅
 */
export function subscribeToasts(listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
