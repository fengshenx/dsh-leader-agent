/**
 * 看板是不是「在前台」的跨组件记录。
 *
 * 标签栏切到 worker 时要把 leader 的看板一起带过去，但只在看板本来就在前台
 * 时才该动布局：右栏收起着、或 leader 的右栏停在别的 tab 上时，跟随等于替
 * 用户换页面。看板 body 自己知道宿主的 `tabInfo.tab.visible`，可见时记下会话
 * id；同一会话里被切到后台（或右栏收起）时清掉。会话已经切走的那种不可见
 * 不清——那正是跟随要读的最后状态。
 *
 * @module dsh-leader-agent/client/board-foreground
 */

/** 最近一次在前台显示看板的会话 id。 */
let foregroundSessionId

/**
 * 记下某个会话的看板在前台。
 * @param {string} sessionId - 会话 id
 * @returns {void} 无返回
 */
export function noteBoardForeground(sessionId) {
  foregroundSessionId = sessionId
}

/**
 * 清掉某个会话的前台记录；别的会话记的不动。
 * @param {string} sessionId - 会话 id
 * @returns {void} 无返回
 */
export function clearBoardForeground(sessionId) {
  if (foregroundSessionId === sessionId) foregroundSessionId = undefined
}

/**
 * 读最近在前台显示看板的会话。
 * @returns {string | undefined} 会话 id
 */
export function lastBoardForegroundSession() {
  return foregroundSessionId
}
