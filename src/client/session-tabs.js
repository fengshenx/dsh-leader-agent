/**
 * 主区域顶部的项目会话标签栏。
 *
 * 宿主的中心列一次只挂一条会话，没有原生多标签。这里在 DOM 上补一条窄栏：
 * 把标签栏插到主面板的第一个子节点（会话头之上），内容用 React portal 渲染，
 * 订阅与状态仍走插件自己的会话快照与项目通道。
 *
 * 三个关键边界：
 *
 * - **只认项目会话**：当前会话必须是项目 leader 或登记表里的 worker；普通会话
 *   不显示标签栏（`resolveTabView` 负责判定）。
 * - **关标签不关会话**：标签只是导航快捷方式，关掉只丢 localStorage 里的一条
 *   id，会话本身留在项目树里。
 * - **不改宿主的布局树**：宿主重渲染换掉主面板时，靠 MutationObserver 把宿主
 *   节点重新插回第一个子节点；只加两个 data 标记让主面板/会话体在 flex 列里
 *   正确收缩，不碰宿主组件的内部结构。
 *
 * 主面板的标记与 flex 收缩规则参考了 dsh-session-tabs 0.1.6（MIT）的实现，
 * 许可见仓库根 THIRD_PARTY_LICENSE。
 *
 * @module dsh-leader-agent/client/session-tabs
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { productIcon } from './icons.js'
import { currentSessionIdOf } from './project-panel-logic.js'
import { onProjectsChanged } from './project-changes.js'
import { isProjectRemoteReady, onProjectRemoteReady } from './project-remote.js'
import { BOARD_TAB_KIND } from './project-board-monitor.js'
import { createSessionCompletionTracker } from './session-completion.js'
import {
  addOpenTab,
  emptyTabStore,
  hasOpenTab,
  parseTabStore,
  removeOpenTab,
  resolveTabView,
  SESSION_TABS_STORAGE_KEY,
  serializeTabStore,
  tabAfterClose,
} from './session-tabs-logic.js'

const STYLE_ID = 'dsh-leader-agent-session-tabs-style'

/** 主面板列标记：宿主列是 flex 列，标签栏占位后主区域必须能收缩。 */
const COLUMN_ATTR = 'data-dsh-leader-agent-tabs-column'

/** 会话体标记：宿主的会话根节点带高度约束，不覆盖会在标签栏下方溢出。 */
const MAIN_ATTR = 'data-dsh-leader-agent-tabs-main'

// client 侧的样式写在模板字符串里，不能出现反引号。
const STYLE_TEXT = `
[${COLUMN_ATTR}] { min-height: 0; }
[${MAIN_ATTR}] {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  height: auto !important;
}
[data-dsh-leader-agent-session-tabs] { display: contents; }
.dsh-leader-agent-tabs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 38px;
  min-width: 0;
  box-sizing: border-box;
  padding-block: 0;
  padding-inline-start: max(20px, var(--dsh-frame-leading-clearance, 0px));
  padding-inline-end: 20px;
  background: var(--dsw-alias-bg-base);
  border-bottom: .5px solid var(--dsw-alias-border-l3);
  -webkit-app-region: drag;
  overflow: hidden;
}
.dsh-leader-agent-tabs-scroll {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.dsh-leader-agent-tabs-scroll::-webkit-scrollbar { display: none; }
.dsh-leader-agent-tab {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  max-width: 240px;
  box-sizing: border-box;
  padding: 0 6px 0 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 18px;
  font-weight: 500;
  cursor: pointer;
  user-select: none;
  -webkit-app-region: no-drag;
  outline: none;
}
.dsh-leader-agent-tab:hover:not([aria-selected='true']) {
  background: color-mix(in srgb, var(--dsw-alias-interactive-bg-hover) 55%, transparent);
  color: var(--dsw-alias-label-primary);
}
.dsh-leader-agent-tab[aria-selected='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-leader-agent-tab:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6);
  outline-offset: -2px;
}
.dsh-leader-agent-tab[data-kind='leader'] { font-weight: 600; }
.dsh-leader-agent-tab-icon {
  flex: none;
  display: flex;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-leader-agent-tab-dot {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
}
.dsh-leader-agent-tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-leader-agent-tab-close {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-inline-start: 1px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ease, background-color 120ms ease;
}
.dsh-leader-agent-tab:hover .dsh-leader-agent-tab-close,
.dsh-leader-agent-tab[aria-selected='true'] .dsh-leader-agent-tab-close,
.dsh-leader-agent-tab-close:focus-visible { opacity: 1; }
.dsh-leader-agent-tab-close:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-leader-agent-tab-close:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6);
  outline-offset: -2px;
}
@media (prefers-reduced-motion: reduce) {
  .dsh-leader-agent-tab-close { transition: none; }
}
`

/** 注入标签栏样式表。同一页面只注入一次。 */
function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_TEXT
  document.head.append(style)
}

/**
 * 找主面板槽位。
 *
 * 宿主在 web-app 的壳层给主区域标了 `data-slot="main"`；`[class*="mainPanel"]`
 * 是宿主改掉槽位标记时的兜底（CSS module 的类名保留了 `mainPanel` 词干）。
 *
 * @returns {Element | null} 槽位节点
 */
function findMainSlot() {
  if (typeof document === 'undefined') return null
  return document.querySelector('#root [data-slot="main"]')
    ?? document.querySelector('[data-slot="main"]')
    ?? document.querySelector('[class*="mainPanel"]')
}

/**
 * 找标签栏要插入的列。
 *
 * 槽位外面可能还套着带 `data-slot` 的包装；往上走到最后一个带槽位标记的节点。
 * 走到主面板为止——主面板自己是 `display:flex; flex-direction:column` 的
 * 容器，标签栏作为它的第一个子节点即可。
 *
 * @param {Element} slot - 主槽位
 * @returns {Element} 插入列
 */
function findColumn(slot) {
  let column = slot.parentElement
  while (column !== null && column.hasAttribute('data-slot') && column.parentElement !== null) {
    column = column.parentElement
  }
  return column ?? slot
}

/** 跳过 `display:contents` 包装，取真正占布局的会话体。 */
function mainBodyOf(slot) {
  let body = slot.firstElementChild
  while (body !== null && typeof window !== 'undefined' && window.getComputedStyle(body).display === 'contents') {
    body = body.firstElementChild
  }
  return body
}

/**
 * 标签栏挂载点。
 *
 * 在浮层槽位里渲染一个不占布局的锚，effect 把宿主节点插到主面板顶部，再把
 * 真正的标签栏 portal 进去。这样标签栏跟着 React 生命周期走，但不受主面板
 * 重渲染的父子关系约束。
 *
 * @param {object} props - 槽位注入的运行时能力
 * @param {string} props.locale - 宿主注入的语言
 * @returns {object | null} React 元素
 */
export function SessionTabsAnchor(props) {
  const [host, setHost] = useState(null)

  useEffect(() => {
    ensureStyles()
    const created = document.createElement('div')
    created.setAttribute('data-dsh-leader-agent-session-tabs', '')
    let column = null
    let mainBody = null
    let retry = null
    let scheduled = false
    let scheduleTimer = null
    let alive = true

    const ensure = () => {
      const slot = findMainSlot()
      if (slot === null) return
      const nextColumn = findColumn(slot)
      const nextBody = mainBodyOf(slot)
      if (nextColumn !== column) {
        column?.removeAttribute(COLUMN_ATTR)
        column = nextColumn
        column.setAttribute(COLUMN_ATTR, '')
      }
      if (nextBody !== mainBody) {
        mainBody?.removeAttribute(MAIN_ATTR)
        mainBody = nextBody
        mainBody?.setAttribute(MAIN_ATTR, '')
      }
      if (created.parentElement !== column) column.insertBefore(created, column.firstElementChild)
    }

    ensure()
    if (created.parentElement === null) {
      // 壳层还没把主槽位挂出来时给一次迟到机会；之后靠 body 观察器补。
      retry = setTimeout(ensure, 250)
    }
    setHost(created)

    const schedule = () => {
      if (!alive || scheduled) return
      scheduled = true
      scheduleTimer = setTimeout(() => {
        scheduled = false
        if (!alive) return
        // 主面板被宿主换掉、会话体重新挂载时，标记和插入点都要重来。
        if (created.parentElement === null || (mainBody !== null && !mainBody.isConnected)) ensure()
      }, 16)
    }

    const observer = new MutationObserver(schedule)
    if (typeof document !== 'undefined' && document.body !== null) {
      observer.observe(document.body, { childList: true, subtree: true })
    }

    return () => {
      alive = false
      observer.disconnect()
      if (retry !== null) clearTimeout(retry)
      if (scheduleTimer !== null) clearTimeout(scheduleTimer)
      column?.removeAttribute(COLUMN_ATTR)
      mainBody?.removeAttribute(MAIN_ATTR)
      created.remove()
      // 热重载后样式表要跟着新实现换一份。
      document.getElementById(STYLE_ID)?.remove()
    }
  }, [])

  return host === null
    ? null
    : createPortal(createElement(SessionTabBar, props), host)
}

/**
 * 标签栏本体。
 * @param {object} props - 槽位注入的运行时能力
 * @returns {object | null} React 元素；不需要标签栏时不渲染
 */
function SessionTabBar({ t, callRemote, getSessions, getUiWorkspace, getLayout, getSidebarRight }) {
  const sessions = getSessions?.()
  const [snapshot, setSnapshot] = useState(() => sessions?.list?.getSnapshot?.() ?? {
    phase: 'pending',
    ids: [],
    byId: {},
  })
  const [completed, setCompleted] = useState(() => new Set())
  const [projects, setProjects] = useState([])
  const [groups, setGroups] = useState([])
  const [store, setStore] = useState(readStore)
  const [panelActive, setPanelActive] = useState(false)
  const lastCurrent = useRef(undefined)

  const refresh = useCallback(async () => {
    if (!isProjectRemoteReady()) return
    try {
      const [nextProjects, nextGroups] = await Promise.all([
        callRemote('list', []),
        callRemote('sessionsByProject', []),
      ])
      setProjects(Array.isArray(nextProjects) ? nextProjects : [])
      setGroups(Array.isArray(nextGroups) ? nextGroups : [])
    } catch (error) {
      // 标签栏是增强入口：通道抖动时保留上一帧，不弹 toast 抢会话区的注意力。
      console.error('dsh-leader-agent: 读取项目标签数据失败', error)
    }
  }, [callRemote])

  useEffect(() => {
    if (!sessions?.list?.subscribe) return undefined
    const tracker = createSessionCompletionTracker()
    const sync = () => {
      const next = sessions.list.getSnapshot()
      setSnapshot(next)
      setCompleted(new Set(tracker.update(next)))
    }
    sync()
    return sessions.list.subscribe(sync)
  }, [sessions])

  useEffect(() => onProjectRemoteReady(() => { void refresh() }), [refresh])

  useEffect(() => {
    const stop = onProjectsChanged(() => { void refresh() })
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => {
      stop()
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  useEffect(() => {
    const info = getLayout?.()?.panelInfo
    if (info === undefined || typeof info.subscribe !== 'function') return undefined
    const sync = () => setPanelActive(info.getSnapshot().activePanelId !== null)
    sync()
    return info.subscribe(sync)
  }, [getLayout])

  const currentSessionId = useMemo(() => currentSessionIdOf(snapshot.byId), [snapshot])

  useEffect(() => {
    const previous = lastCurrent.current
    lastCurrent.current = currentSessionId
    if (previous !== undefined && currentSessionId !== undefined && previous !== currentSessionId) {
      // 打开刚派工的 worker 时登记表可能还没有它：切会话这一次主动重读，不让标签晚一拍。
      void refresh()
    }
  }, [currentSessionId, refresh])

  useEffect(() => {
    try {
      window.localStorage.setItem(SESSION_TABS_STORAGE_KEY, serializeTabStore(store))
    } catch {
      // 隐私模式或配额满：标签只在本次页面内有效，不影响会话导航。
    }
  }, [store])

  const rows = useMemo(() => {
    const next = {}
    for (const [id, row] of Object.entries(snapshot.byId ?? {})) {
      next[id] = {
        id,
        title: row.title,
        displayTitle: row.displayTitle,
        running: row.running,
        completed: completed.has(id),
      }
    }
    return next
  }, [snapshot, completed])

  const view = useMemo(() => resolveTabView({
    projects,
    groups,
    rows,
    currentSessionId,
    store,
  }), [projects, groups, rows, currentSessionId, store])

  useEffect(() => {
    if (!view.visible || !view.isWorkerCurrent || currentSessionId === undefined) return
    if (hasOpenTab(store, view.project.id, currentSessionId)) return
    setStore((current) => addOpenTab(current, view.project.id, currentSessionId))
    // 故意不依赖 store：关掉当前标签时当前会话还没切走，依赖 store 会把它同帧加回来。
  }, [view.visible, view.isWorkerCurrent, view.project?.id, currentSessionId])

  // 右栏按会话隔离：切到 worker 时宿主会换成 worker 自己的右栏布局，leader 开着
  // 的看板就跟着消失。看板是项目级的，worker 也能看；leader 右栏里已经有看板 tab
  // 时，切到 worker 后把它开回来，保持「屏幕上一直是同一块看板」。
  //
  // `tabsIn` 是 sidebarRight 服务上面向 provider 的读取方法（不在 ISidebarRight
  // 接口里，但 rc.2 就有）；没有它时宁可不跟随，也不替用户猜要不要开。
  const lastBoardCarry = useRef(undefined)
  useEffect(() => {
    if (panelActive || currentSessionId === undefined) return
    if (!view.visible || !view.isWorkerCurrent) {
      lastBoardCarry.current = undefined
      return
    }
    if (lastBoardCarry.current === currentSessionId) return
    const leaderId = view.project?.leaderSessionId
    if (typeof leaderId !== 'string' || leaderId === '') return
    const sidebarRight = getSidebarRight?.()
    if (sidebarRight === undefined || sidebarRight === null) return
    if (typeof sidebarRight.tabsIn !== 'function') return
    if (!sidebarRight.tabsIn(leaderId).some((tab) => tab.kind === BOARD_TAB_KIND)) return
    // 宿主在切换会话的同一帧把右栏挂到 worker 上；没落定就先不开，避免开在
    // leader 自己的右栏里。下一轮视图变化会再走到这里。
    if (sidebarRight.mounted?.getSnapshot?.() !== currentSessionId) return
    lastBoardCarry.current = currentSessionId
    // 把项目 id 带进 tab navigation：看板 body 新挂时先用同一项目的上一份数据
    // 起步，不让右栏先闪一下骨架。
    sidebarRight.openTab(BOARD_TAB_KIND, { params: { projectId: view.project.id } })
  }, [currentSessionId, getSidebarRight, panelActive, view.visible, view.isWorkerCurrent, view.project?.leaderSessionId])

  if (!view.visible || panelActive) return null

  const listLabel = typeof t === 'function' ? t('tabs.list') : '项目会话标签'
  const closeLabel = typeof t === 'function' ? t('tabs.close') : '关闭标签'
  const openSession = (sessionId) => {
    if (sessionId === view.activeSessionId) return
    const workspace = getUiWorkspace?.()
    if (workspace !== undefined && typeof workspace.openSession === 'function') {
      workspace.openSession(sessionId)
    }
  }
  const closeSession = (sessionId) => {
    const fallback = tabAfterClose(view, sessionId)
    if (fallback !== null) {
      const workspace = getUiWorkspace?.()
      // 切不回 leader 时不摘标签，免得留下一个当前会话没有标签的栏。
      if (workspace === undefined || typeof workspace.openSession !== 'function') return
      workspace.openSession(fallback)
    }
    setStore((current) => removeOpenTab(current, view.project.id, sessionId))
  }

  return createElement(
    'div',
    {
      className: 'dsh-leader-agent-tabs',
      'data-dsh-leader-agent-session-tabs-bar': '',
      role: 'tablist',
      'aria-label': listLabel,
    },
    createElement(
      'div',
      { className: 'dsh-leader-agent-tabs-scroll' },
      ...view.tabs.map((tab) => createElement(
        'div',
        {
          key: tab.id,
          className: 'dsh-leader-agent-tab',
          'data-session-id': tab.id,
          'data-kind': tab.kind,
          role: 'tab',
          tabIndex: tab.id === view.activeSessionId ? 0 : -1,
          'aria-selected': tab.id === view.activeSessionId ? 'true' : 'false',
          title: tab.label,
          onClick: () => openSession(tab.id),
          onKeyDown: (event) => {
            // 关闭按钮自己的回车/空格会冒泡到这里，不能顺手把标签再打开一次。
            if (event.target !== event.currentTarget) return
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            openSession(tab.id)
          },
        },
        tab.kind === 'leader'
          ? createElement(
              'span',
              { className: 'dsh-leader-agent-tab-icon' },
              productIcon('apps-add-outline', { size: 14 }),
            )
          : createElement(
              'span',
              { className: 'dsh-leader-agent-tab-dot' },
              createElement(StateDot, {
                state: tab.state,
                size: tab.state === 'ongoing' ? 12 : 8,
              }),
            ),
        createElement('span', { className: 'dsh-leader-agent-tab-label' }, tab.label),
        tab.kind === 'worker'
          ? createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-leader-agent-tab-close',
                'aria-label': closeLabel + ' ' + tab.label,
                title: closeLabel + ' ' + tab.label,
                onClick: (event) => {
                  event.stopPropagation()
                  closeSession(tab.id)
                },
              },
              productIcon('close-outline', { size: 12 }),
            )
          : null,
      )),
    ),
  )
}

/**
 * 读 localStorage 里的标签库。
 * @returns {{version: 1, projects: Record<string, string[]>}} 标签库
 */
function readStore() {
  if (typeof window === 'undefined') return emptyTabStore()
  try {
    return parseTabStore(window.localStorage.getItem(SESSION_TABS_STORAGE_KEY))
  } catch {
    // 隐私模式禁用 localStorage：本次页面内从空库开始。
    return emptyTabStore()
  }
}
