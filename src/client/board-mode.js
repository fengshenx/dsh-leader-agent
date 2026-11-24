/**
 * 看板显示模式：`cinema`（线路图）与 `work`（纯列表）。
 *
 * 这是**显示偏好**，不是项目数据：它跟着浏览器窗口走，不跟项目走，所以存
 * localStorage 而不是宿主卡片库。放在 localStorage 还有一个实际好处——设置页写
 * 完之后，同一运行时的看板通过模块级订阅立刻换模式，其它窗口靠 `storage` 事件
 * 同步，不需要一次异步取数，也不会在打开时先闪一下旧模式。
 *
 * 访问 `localStorage` 属性本身可能抛（隐私模式），所以存储口一律由调用方传入，
 * 读失败按默认值走，写失败静默丢弃：模式切换是呈现层的事，不值得让看板崩掉。
 *
 * @module dsh-leader-agent/client/board-mode
 */

/** 存储键。改键等于丢掉老用户的选择，不轻易动。 */
export const BOARD_MODE_KEY = 'dsh-leader-agent.board.mode'

/**
 * 宿主判定的默认模式缓存键。
 *
 * 老用户（升级前已有项目/卡片）默认工作，新装默认炫酷；默认值单独存，不冒充
 * 用户的显式选择。显式 key 存在时永远优先。
 */
export const BOARD_DEFAULT_KEY = 'dsh-leader-agent.board.default'

/** 线路图模式：列表 + 主干与支线。 */
export const BOARD_MODE_CINEMA = 'cinema'

/** 工作模式：现在的纯列表，零动效。 */
export const BOARD_MODE_WORK = 'work'

/** 默认模式。产品定位是「打开就能看到工作流」，缺省值必须和它一致。 */
export const BOARD_MODE_DEFAULT = BOARD_MODE_CINEMA

/** 全部合法模式，设置页按这个顺序渲染选项。 */
export const BOARD_MODES = Object.freeze([BOARD_MODE_CINEMA, BOARD_MODE_WORK])

/**
 * 把任意读到的值收成合法模式。
 *
 * 只有明确的 `work` 才算工作模式，其余（旧版遗留、手改坏、空值）一律回到默认：
 * 未知值不该把看板切成一个没人设计过的状态。
 *
 * @param {unknown} value - 待规范化的值
 * @returns {string} `cinema` 或 `work`
 */
export function normalizeBoardMode(value) {
  return value === BOARD_MODE_WORK ? BOARD_MODE_WORK : BOARD_MODE_CINEMA
}

/**
 * 从存储口读模式与「默认值是否已就绪」。
 *
 * 没写过任何偏好时返回 `resolved: false`：此时 `mode` 只是内置兜底，不能拿它当
 * 用户偏好渲染——老用户升级后的首帧会先画成炫酷，等宿主判定的工作默认值到了
 * 再切。`resolved` 让看板在默认值落地前不画线路图。
 *
 * @param {{ getItem?: (key: string) => string | null } | undefined} storage - 存储口
 * @returns {{ mode: string, resolved: boolean }} 合法模式与是否已有偏好依据
 */
export function readBoardModeSnapshot(storage) {
  try {
    const explicit = storage?.getItem?.(BOARD_MODE_KEY)
    if (explicit !== null && explicit !== undefined) return { mode: normalizeBoardMode(explicit), resolved: true }
    const fallback = storage?.getItem?.(BOARD_DEFAULT_KEY)
    if (fallback !== null && fallback !== undefined) return { mode: normalizeBoardMode(fallback), resolved: true }
  } catch {
    // 隐私模式读存储会抛：连显式选择都读不到，只能按内置默认走
    return { mode: BOARD_MODE_DEFAULT, resolved: false }
  }
  return { mode: BOARD_MODE_DEFAULT, resolved: false }
}

/**
 * 从存储口读模式。
 *
 * @param {{ getItem?: (key: string) => string | null } | undefined} storage - 存储口
 * @returns {string} 合法模式
 */
export function readBoardMode(storage) {
  return readBoardModeSnapshot(storage).mode
}

/**
 * 缓存宿主判定的默认模式。
 *
 * 只在没有显式选择时写；写成功返回实际生效的模式。写失败也返回该模式——默认值
 * 仍要在本次运行时生效，否则隐私模式下老用户会一直停在内置炫酷。同值或已有
 * 显式选择时返回 undefined：那种情况下存储里本来就有可读依据，订阅者不必再
 * 被通知一次。
 *
 * @param {{ getItem?: (key: string) => string | null, setItem?: (key: string, value: string) => void } | undefined} storage - 存储口
 * @param {unknown} mode - 宿主给出的默认模式
 * @returns {string | undefined} 本次生效的模式
 */
export function cacheBoardDefault(storage, mode) {
  const next = normalizeBoardMode(mode)
  try {
    const explicit = storage?.getItem?.(BOARD_MODE_KEY)
    if (explicit !== null && explicit !== undefined) return undefined
    if (storage?.getItem?.(BOARD_DEFAULT_KEY) === next) return undefined
    storage?.setItem?.(BOARD_DEFAULT_KEY, next)
    return next
  } catch {
    // 隐私模式/配额满：缓存写不进去，但默认值仍要在本次会话生效
    return next
  }
}

/**
 * 写模式。
 *
 * @param {{ setItem?: (key: string, value: string) => void } | undefined} storage - 存储口
 * @param {unknown} mode - 目标模式
 * @returns {string} 实际写入的合法模式
 */
export function writeBoardMode(storage, mode) {
  const next = normalizeBoardMode(mode)
  try {
    storage?.setItem?.(BOARD_MODE_KEY, next)
  } catch {
    // 隐私模式/配额满：本次会话按用户刚选的值走，刷新后退回上一次能写进去的值
  }
  return next
}

/** 同一运行时内的订阅者。设置页写、看板读，都在这张表上。 */
const listeners = new Set()

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
 * 广播模式变化（只给本运行时，跨窗口由 `storage` 事件负责）。
 *
 * @param {string} mode - 新模式
 * @returns {void}
 */
export function announceBoardMode(mode) {
  const next = normalizeBoardMode(mode)
  // 先取快照：回调里退订会改动 Set，边迭代边删会漏掉后面的订阅者
  for (const listener of Array.from(listeners)) listener(next)
}

/**
 * 写并广播。
 *
 * @param {object | undefined} storage - 存储口
 * @param {unknown} mode - 目标模式
 * @returns {string} 生效的模式
 */
export function setBoardMode(storage, mode) {
  const next = writeBoardMode(storage, mode)
  announceBoardMode(next)
  return next
}
