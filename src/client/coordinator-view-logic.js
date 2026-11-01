/**
 * 协调者视图目标的纯逻辑。
 *
 * 官方外壳把「输入框停靠底部」绑在会话的 active 形态上：形态由
 * `conversationPhase` 判定，而空会话一律落回居中的欢迎页。这里用一个第三方
 * 视图目标把协调者会话顶进 active 形态——目标被激活后，官方自己判定为 active，
 * 输入框落到底部，会话区保持空白。既不用跑一轮模型，也不往会话里塞消息。
 *
 * 目标不注册成可见 tab：官方没有「按会话过滤 tab」的能力，可见 tab 会出现在
 * 所有会话的头部。它只提供活动，视图区仍是官方那个空会话。
 *
 * @module dsh-leader-kit/client/coordinator-view-logic
 */

/** 协调者视图目标 id。 */
export const COORDINATOR_VIEW_TARGET = 'dsh-leader-kit'

/**
 * 构造协调者视图定义。
 *
 * 这个目标不物化任何节点，它只为把会话顶进 active 形态，快照恒定即可。
 *
 * @returns {object} 视图定义
 */
export function createCoordinatorViewDefinition() {
  const snapshot = { target: COORDINATOR_VIEW_TARGET }
  return {
    target: COORDINATOR_VIEW_TARGET,
    create: () => ({
      empty: snapshot,
      replace: () => snapshot,
      apply: () => snapshot,
    }),
    // 激活即生效：这个目标不产出内容，可见与否由谁激活它决定。
    isActive: () => true,
  }
}

/**
 * 协调者会话 id 索引。
 *
 * 主区域要判断「当前会话是不是协调者」，左栏项目面板要提供这份名单。两边共享
 * 一个模块级索引：面板读到项目列表后写入，主区域的入口订阅它。
 *
 * @returns {object} 索引
 */
export function createCoordinatorSessionIndex() {
  let ids = new Set()
  const listeners = new Set()
  return {
    /** @returns {Set<string>} 当前已知的协调者会话 id */
    getSnapshot: () => ids,
    /**
     * 订阅名单变化；订阅即刻收到一次当前名单。
     * @param {(ids: Set<string>) => void} listener - 回调
     * @returns {() => void} 退订函数
     */
    subscribe: (listener) => {
      listeners.add(listener)
      listener(ids)
      return () => { listeners.delete(listener) }
    },
    /**
     * 更新名单；内容没变时不通知。
     * @param {Iterable<string>} next - 新的协调者会话 id
     * @returns {void}
     */
    update: (next) => {
      const nextIds = new Set(next)
      if (nextIds.size === ids.size && [...nextIds].every((id) => ids.has(id))) return
      ids = nextIds
      for (const listener of [...listeners]) listener(ids)
    },
  }
}

/**
 * 从项目列表里取协调者会话 id。
 *
 * @param {unknown} projects - `projects/list` 的返回值
 * @returns {string[]} 协调者会话 id
 */
export function collectCoordinatorSessionIds(projects) {
  if (!Array.isArray(projects)) return []
  const ids = []
  for (const project of projects) {
    const id = project?.coordinatorSessionId
    if (typeof id === 'string' && id !== '') ids.push(id)
  }
  return ids
}

/**
 * 激活协调者视图目标。
 *
 * @param {object} conversation - `uiConversation` 服务
 * @param {string} sessionId - 会话 id
 * @returns {boolean} 是否激活成功
 */
export function activateCoordinatorView(conversation, sessionId) {
  if (conversation === undefined || typeof conversation.binding !== 'function') return false
  let binding
  try {
    binding = conversation.binding(sessionId)
  } catch {
    // 会话还没绑定：宿主在会话打开后才建绑定，等下一次机会。
    return false
  }
  binding.activate(COORDINATOR_VIEW_TARGET)
  return true
}
