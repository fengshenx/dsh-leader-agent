/**
 * leader 会话引导卡的纯逻辑。
 *
 * 触发条件两条都为真：当前会话是某项目的 leader；会话还没有任何消息。「有没有
 * 消息」用宿主会话快照的 `blank`（`SessionSnapshot.blank`，宿主自己的口径）——
 * 不数事件、不看时间窗，第一句话发出后条件自然不成立，也就不需要「已读」标记。
 *
 * 关闭状态存 localStorage：仓外插件不能新增 session event 类型，而一次性提示
 * 本就不该写进会话记录（写进去就不满足「引导出现期间会话事件数为 0」）。
 *
 * @module dsh-leader-kit/client/guide-card-logic
 */

/** 关闭标记的 localStorage 键前缀，后面接 leader 会话 id。 */
export const GUIDE_DISMISS_PREFIX = 'dsh-leader-kit.guide.dismissed.'

/** 「看上手文档」指向的文档路径。 */
export const GUIDE_DOC_PATH = 'docs/getting-started.md'

/**
 * 关闭标记的存储键。
 * @param {string} sessionId - leader 会话 id
 * @returns {string} 存储键
 */
export function guideDismissKey(sessionId) {
  return `${GUIDE_DISMISS_PREFIX}${sessionId}`
}

/**
 * 是否显示引导卡。
 * @param {object} state - 判定输入
 * @param {boolean} state.isLeader - 当前会话是不是某项目的 leader
 * @param {boolean} state.blank - 会话快照的 `blank`
 * @param {boolean} state.dismissed - 本会话是否已被「知道了」关掉
 * @returns {boolean} 显示时为 true
 */
export function shouldShowGuide({ isLeader, blank, dismissed }) {
  return isLeader === true && blank === true && dismissed !== true
}

/**
 * 取浏览器里的 localStorage。
 *
 * 访问 `localStorage` 这个属性本身就可能抛（隐私模式），所以不能在模块顶层取：
 * 那会让整个客户端产物加载失败。
 *
 * @param {{ localStorage?: unknown } | undefined} scope - 通常是 `globalThis`
 * @returns {{ getItem?: (key: string) => string | null, setItem?: (key: string, value: string) => void } | undefined} 存储口，取不到时为 undefined
 */
export function readLocalStorage(scope) {
  try {
    return scope?.localStorage
  } catch {
    return undefined
  }
}

/**
 * 复制上手文档路径，并告诉用户结果。
 *
 * 第三方 bundle 没有打开本地文件的通道，发布包也不带 `docs/`，所以「看上手
 * 文档」只能把路径交给用户，而不是假装能跳转。
 *
 * @param {string} path - 文档路径
 * @param {(key: string) => string} t - 翻译函数
 * @param {{ clipboard?: { writeText?: (text: string) => Promise<void> }, notify: (text: string) => void }} io - 剪贴板与提示通道
 * @returns {Promise<boolean>} 是否复制成功
 */
export async function copyGuidePath(path, t, { clipboard, notify }) {
  try {
    if (typeof clipboard?.writeText !== 'function') throw new TypeError('没有剪贴板能力')
    await clipboard.writeText(path)
    notify(t('guide.toast.docs-copied'))
    return true
  } catch {
    // 剪贴板权限被拒或不在安全上下文：仍然把路径告诉用户，不让按钮点了没反应。
    notify(t('guide.toast.docs-failed'))
    return false
  }
}

/**
 * 关闭标记的读写口。
 *
 * 标记按 leader 会话 id 记而不是项目 id：项目 id 要在浏览器侧再拉一次
 * `projects/list`，而会话 id 正是触发条件的另一半，本地已有。换了 leader
 * 会话，引导会再出现一次——那正是该重新提醒的时候。
 *
 * @param {{ getItem?: (key: string) => string | null, setItem?: (key: string, value: string) => void } | undefined} storage - localStorage 或等价实现，缺失时按「没关过」处理
 * @returns {{ isDismissed: (sessionId: string) => boolean, dismiss: (sessionId: string) => void }} 读写口
 */
export function createGuideDismissal(storage) {
  return {
    isDismissed: (sessionId) => {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      try {
        return storage?.getItem?.(guideDismissKey(sessionId)) === '1'
      } catch {
        // 隐私模式读 localStorage 会抛：读不到只当没关过，卡片再出现一次比让整块界面崩掉好。
        return false
      }
    },
    dismiss: (sessionId) => {
      if (typeof sessionId !== 'string' || sessionId === '') return
      try {
        storage?.setItem?.(guideDismissKey(sessionId), '1')
      } catch {
        // 同上：写不进去只是这次没记住，不值得让点击处理抛异常。
      }
    },
  }
}
