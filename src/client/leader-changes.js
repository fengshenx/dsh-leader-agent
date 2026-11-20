/**
 * leader 会话隐藏改动文件汇总卡片的判定与样式。
 *
 * 宿主的 `@deepseek-ai/dsh-client-ui-deliverables` 在每个完成轮次的收尾消息后
 * 渲染一张「已编辑 N 个文件」卡片，注册在 chat 视图的 `conversation.chat.turnTail`
 * 列表槽里。slot 注册没有按会话过滤的参数，第三方也不能卸载别人的注册；宿主
 * 唯一的开关是全局偏好「显示代码工作视图」，关掉会连带轨迹视图与完整预设列表。
 *
 * leader 会话是协调者，卡片上列的是它自己的文件改动，对看对话的人没有信息量。
 * 这里只做**渲染层隐藏**：判定当前主区域会话是 leader 时，给主面板容器加一个
 * 标记，样式表按宿主的 `data-changed-files` 属性把卡片藏掉。数据层不动，摘要
 * 请求照发（隐藏与不渲染是两件事，见 docs/limitations.md）。
 *
 * 与 `workspace-exclusion` 同一套做法：宿主 DOM 上的语义标记 + 自家样式表，
 * 不碰宿主的组件与数据。标记名（`data-changed-files`）是宿主的实现细节，
 * 宿主改版时要跟着核。
 *
 * @module dsh-leader-agent/client/leader-changes
 */

import { findMainPanel } from './main-panel.js'

/** 主面板容器上的隐藏标记。 */
export const HIDE_ATTR = 'data-dsh-leader-agent-hide-changed-files'

/** 样式表 id。 */
const STYLE_ID = 'dsh-leader-agent-leader-changes'

// client 侧的样式写在模板字符串里，不能出现反引号。
const STYLE_TEXT = `
[${HIDE_ATTR}] [data-changed-files] {
  display: none !important;
}
`

/**
 * 注入隐藏规则。同一页面只注入一次。
 * @returns {void}
 */
export function ensureLeaderChangesStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  document.head.append(style)
}

/**
 * 这个会话是不是某个项目的 leader。
 *
 * 名单来自左栏项目区块写入的索引（`projects/list` 的 `leaderSessionId`），
 * 不含 worker 与同目录的普通会话。
 *
 * @param {Set<string> | undefined} leaderIds - leader 会话 id 名单
 * @param {string | undefined} sessionId - 主区域当前会话 id
 * @returns {boolean} 是否隐藏该会话的改动文件卡片
 */
export function isLeaderSession(leaderIds, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  return leaderIds instanceof Set && leaderIds.has(sessionId)
}

/**
 * 按判定给容器加/摘隐藏标记。
 *
 * 抽成独立函数是为了能脱离 DOM 单测：容器只需提供 `setAttribute` 与
 * `removeAttribute`。
 *
 * @param {object | null | undefined} column - 主面板容器
 * @param {boolean} hide - 是否隐藏
 * @returns {void}
 */
export function applyHideState(column, hide) {
  if (column === null || column === undefined) return
  if (hide) column.setAttribute(HIDE_ATTR, '')
  else column.removeAttribute(HIDE_ATTR)
}

/**
 * 观察主面板并维护隐藏标记。
 *
 * 切换会话时主面板节点可能被宿主替换：先对新节点加标记，再摘掉旧节点的标记，
 * 避免旧 column 上留下跨会话的 `display:none`。卸载时断开 observer、清掉节流
 * timer，并摘掉当前标记。
 *
 * @param {boolean} hide - 是否隐藏
 * @param {object} [options] - 依赖注入（单测用）
 * @param {Document} [options.documentRef] - 文档
 * @param {() => Element | null} [options.findPanel] - 找真实主面板节点
 * @param {(column: object | null | undefined, hide: boolean) => void} [options.apply] - 加/摘标记
 * @param {typeof MutationObserver} [options.Observer] - MutationObserver 构造器
 * @param {(callback: () => void) => unknown} [options.schedule] - 节流调度
 * @param {(timer: unknown) => void} [options.cancel] - 取消节流
 * @returns {() => void} 清理函数
 */
export function watchLeaderChanges(hide, {
  documentRef = typeof document === 'undefined' ? undefined : document,
  findPanel = findMainPanel,
  apply = applyHideState,
  Observer = typeof MutationObserver === 'undefined' ? undefined : MutationObserver,
  schedule = (callback) => setTimeout(callback, 16),
  cancel = (timer) => clearTimeout(timer),
} = {}) {
  let column = null
  let scheduled = false
  let timer = null
  let alive = true

  const applyNow = () => {
    if (!alive || documentRef === undefined) return
    const next = findPanel()
    if (next === null) {
      // 主面板标记被宿主改掉时也要摘掉旧标记，否则卡片会继续被隐藏。
      apply(column, false)
      column = null
      return
    }
    if (next !== column) {
      apply(column, false)
      column = next
    }
    apply(column, hide)
  }
  applyNow()

  const observer = hide && documentRef?.body !== undefined && Observer !== undefined
    ? new Observer(() => {
      if (scheduled) return
      scheduled = true
      timer = schedule(() => {
        scheduled = false
        applyNow()
      })
    })
    : null
  observer?.observe(documentRef.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  })

  return () => {
    alive = false
    observer?.disconnect()
    if (timer !== null) cancel(timer)
    apply(column, false)
  }
}
