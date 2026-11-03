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
 * 让 Leader 自我介绍的点击动作。
 *
 * 走宿主的输入机（会话作用域标准 props 里的 `inputActions`，rc.2 起就在）：
 * `setDraft` 把话填进输入框、`submit` 当场提交。这是用户点击触发的一次发送，
 * 卡片自己渲染时仍然不写转录、不请求模型。
 *
 * 输入机缺失时（宿主把它从标准 props 里拿掉）不渲染这个按钮——比点了没反应好。
 *
 * @param {{ setDraft?: (text: string) => void, submit?: () => void } | undefined} inputActions - 宿主的输入动作
 * @param {string} prompt - 要发出去的那句话
 * @returns {boolean} 是否真的发出去了
 */
export function sendIntroPrompt(inputActions, prompt) {
  if (typeof inputActions?.setDraft !== 'function' || typeof inputActions?.submit !== 'function') return false
  inputActions.setDraft(prompt)
  inputActions.submit()
  return true
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
