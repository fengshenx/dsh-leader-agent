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

import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { productIcon } from './icons.js'
import { findColumn, findMainSlot, mainBodyOf } from './main-panel.js'
import { currentSessionIdOf } from './project-panel-logic.js'
import { onProjectsChanged } from './project-changes.js'
import { isProjectRemoteReady, onProjectRemoteReady } from './project-remote.js'
import { BOARD_TAB_KIND } from './project-board-monitor.js'
import { createSessionCompletionTracker } from './session-completion.js'
import { signalStyleText } from './signal-styles.js'
import {
  addOpenTab,
  emptyTabStore,
  hasOpenTab,
  hasSessionMenu,
  parseTabStore,
  removeOpenTab,
  resolveTabView,
  SESSION_TABS_STORAGE_KEY,
  serializeTabStore,
  tabAfterClose,
  tabIdForKey,
} from './session-tabs-logic.js'
import { lastBoardForegroundSession } from './board-foreground.js'

const STYLE_ID = 'dsh-leader-agent-session-tabs-style'

/** 主面板列标记：宿主列是 flex 列，标签栏占位后主区域必须能收缩。 */
const COLUMN_ATTR = 'data-dsh-leader-agent-tabs-column'

/** 会话体标记：宿主的会话根节点带高度约束，不覆盖会在标签栏下方溢出。 */
const MAIN_ATTR = 'data-dsh-leader-agent-tabs-main'

/**
 * 信号灯档位到字典键。
 *
 * 与看板卡面共用同一组文案：两处说的是同一档状态，不再各养一套。
 */
const SIGNAL_LABEL_KEYS = {
  running: 'board.state.running',
  unread: 'board.state.unread',
  idle: 'board.state.idle',
}

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
  /* 宿主右栏顶行是 38px 的条带：10px 上留白 + 底部 28px 内容带。标签栏
     同高，但内容要压到同一条 28px 带上，否则两边的 chip 与按钮差 5px。 */
  padding-block: 10px 0;
  padding-inline-start: max(20px, var(--dsh-frame-leading-clearance, 0px));
  /* 右侧只留右栏开关：它被钉到标签栏这一行（见下），标签滚动区必须在它
     左边结束，否则长标签会钻到按钮下面。会话「更多」是本插件自己渲染的
     flex 子项，不占这段留白。 */
  padding-inline-end: 42px;
  background: var(--dsw-alias-bg-base);
  /* 分隔线画成 inset shadow：border 会占掉 border-box 的 0.5px，内容带就
     凑不满 28px，与右栏条带对不齐。 */
  box-shadow: inset 0 -0.5px 0 var(--dsw-alias-border-l3);
  -webkit-app-region: drag;
  overflow: hidden;
}
/* 右栏展开后收起按钮在面板自己的顶条里，主列右缘不再有开关；42px 的开关
   留白此时只剩空档，把「更多」收回到 6px 边距，与弹出时同一列。 */
body:has([data-sidebar-right-session]:not([hidden]) [data-sidebar-right-open]) .dsh-leader-agent-tabs {
  padding-inline-end: 6px;
}
/* 右栏开关本来在会话头的标题行（标签栏下一行）。收起右栏时它在下面，
   展开后宿主把面板的收起按钮画在面板自己的顶部条（标签栏这一行）——
   同一个开关会上下跳一行。这里把开关钉到标签栏这一行：收起时它在
   [顶部条右侧 6px、顶行内容起点]，展开后宿主的收起按钮在同一坐标接管。
   用 fixed 是因为会话根带 overflow: hidden，普通绝对定位会被裁掉。 */
[${COLUMN_ATTR}] [data-sidebar-right-expand] {
  position: fixed;
  top: calc(var(--dsh-windows-titlebar-height, 0px) + 10px);
  right: 6px;
  z-index: 1;
}
/* 开关已经移出标题行；让 corner 的盒子（含 8px/负 16px 外边距）不再参与
   标题行排版，否则标题右侧会多出一段为按钮保留的空白。 */
[${COLUMN_ATTR}] [data-conversation-header-corner] {
  display: contents;
}
/* 「更多」由标签栏自己渲染（见 SessionTabBar）；只有宿主真给了 contextMenus
   服务、栏里真的补出这枚按钮时才藏宿主标题行里那一枚，避免同一个会话菜单
   出现两次（服务缺失时宿主原按钮继续可用）。 */
[${COLUMN_ATTR}]:has([data-dsh-leader-agent-tabs-menu]) [class*="headerMenuButton"] {
  display: none;
}
.dsh-leader-agent-tabs-action {
  flex: none;
  align-self: flex-end;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.dsh-leader-agent-tabs-action:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dsh-leader-agent-tabs-action:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #4176e6);
  outline-offset: -2px;
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
/* 标签要的是信号灯，不是加载态：宿主的 StateDot 运行中画转圈 spinner，这里改成
   与看板卡面同一套静态点——运行中琥珀色呼吸、完成未读蓝、空闲弱化灰。形状与
   色相都跟卡面对应，扫描标签时不会把「正在跑」读成「正在加载」。 */
${signalStyleText('dsh-leader-agent-tab-signal')}
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
  // 栏是否可见由栏自己判定（项目会话、有 worker、无浮层）；这里只负责在可见时
  // 才给宿主主面板加 flex 收缩标记。普通会话/收起状态不该被本插件改布局。
  const visibleRef = useRef(false)
  const applyRef = useRef(null)
  const reportVisible = useCallback((next) => {
    if (visibleRef.current === next) return
    visibleRef.current = next
    applyRef.current?.()
  }, [])

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

    const apply = () => {
      if (!alive) return
      if (!visibleRef.current) {
        // 栏不在时连标记一起摘掉：`!important` 的 flex 覆盖只该在栏占位时生效。
        column?.removeAttribute(COLUMN_ATTR)
        mainBody?.removeAttribute(MAIN_ATTR)
        created.remove()
        column = null
        mainBody = null
        return
      }
      const slot = findMainSlot()
      if (slot === null) return
      const nextColumn = findColumn(slot)
      const nextBody = mainBodyOf(slot)
      if (nextColumn !== column) {
        column?.removeAttribute(COLUMN_ATTR)
        column = nextColumn
      }
      if (nextBody !== mainBody) {
        mainBody?.removeAttribute(MAIN_ATTR)
        mainBody = nextBody
      }
      column.setAttribute(COLUMN_ATTR, '')
      mainBody?.setAttribute(MAIN_ATTR, '')
      if (created.parentElement !== column) column.insertBefore(created, column.firstElementChild)
    }
    applyRef.current = apply

    apply()
    if (visibleRef.current && created.parentElement === null) {
      // 壳层还没把主槽位挂出来时给一次迟到机会；之后靠 body 观察器补。
      retry = setTimeout(apply, 250)
    }
    setHost(created)

    const schedule = () => {
      if (!alive || scheduled) return
      scheduled = true
      scheduleTimer = setTimeout(() => {
        scheduled = false
        if (!alive || !visibleRef.current) return
        // 主面板被宿主换掉、会话体重新挂载时，标记和插入点都要重来。
        if (created.parentElement === null || (mainBody !== null && !mainBody.isConnected)) apply()
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
      applyRef.current = null
      visibleRef.current = false
      column?.removeAttribute(COLUMN_ATTR)
      mainBody?.removeAttribute(MAIN_ATTR)
      created.remove()
      // 热重载后样式表要跟着新实现换一份。
      document.getElementById(STYLE_ID)?.remove()
    }
  }, [])

  return host === null
    ? null
    : createPortal(createElement(SessionTabBar, { ...props, reportVisible }), host)
}

/**
 * 标签栏本体。
 * @param {object} props - 槽位注入的运行时能力
 * @returns {object | null} React 元素；不需要标签栏时不渲染
 */
function SessionTabBar({ t, callRemote, getSessions, getUiWorkspace, getLayout, getSidebarRight, getContextMenus, reportVisible }) {
  const sessions = getSessions?.()
  const menus = getContextMenus?.() ?? null
  const hasMenu = hasSessionMenu(menus)
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
  const [menuOpen, setMenuOpen] = useState(false)
  const lastCurrent = useRef(undefined)
  const tabRefs = useRef(new Map())
  // 键盘切换后要聚焦的标签：宿主切会话时会把焦点收回会话区，等它落定再抢回来。
  const pendingFocus = useRef(undefined)

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

  // 菜单可能被宿主的快捷键/外部点击关掉；按钮的 aria-expanded 跟着服务走，
  // 不能只记自己点击的那一下。
  useEffect(() => {
    const active = menus?.active
    if (active === undefined || typeof active.subscribe !== 'function') return undefined
    const sync = () => {
      const target = active.getSnapshot()
      setMenuOpen(target?.kind === 'sessionHeader' && target.value?.sessionId === currentSessionId)
    }
    sync()
    return active.subscribe(sync)
  }, [menus, currentSessionId])

  // 程序化切会话不会经过标签点击的 pointerdown，宿主菜单不会自己关；旧会话的
  // sessionHeader 菜单必须在这时收掉，否则按钮报 false、菜单却还在旧目标上。
  useEffect(() => {
    const active = menus?.active
    if (active === undefined || typeof active.getSnapshot !== 'function' || typeof menus.close !== 'function') return
    const target = active.getSnapshot()
    if (target?.kind === 'sessionHeader'
      && typeof target.value?.sessionId === 'string'
      && target.value.sessionId !== currentSessionId) {
      menus.close()
    }
  }, [menus, currentSessionId])

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
    const id = pendingFocus.current
    if (id === undefined || view.activeSessionId !== id) return undefined
    pendingFocus.current = undefined
    // 会话切换的同一帧宿主会把焦点交给输入框；下一帧再聚焦标签，顺序才稳。
    const frame = requestAnimationFrame(() => { tabRefs.current.get(id)?.focus() })
    return () => cancelAnimationFrame(frame)
  }, [view.activeSessionId])

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
  const carryBoard = useCallback(() => {
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
    // 只有看板本来就在 leader 的前台（可见 = 右栏展开且是当前 tab）才跟随：
    // 收起右栏或停在别的 tab 上时跟随等于替用户展开/换页面，还会抢焦点。
    // 从 worker 切到另一个 worker 也不跟随：前台记录已属于那个 worker，
    // 带过去等于替目标会话换右栏。
    if (lastBoardForegroundSession() !== leaderId) return
    if (!sidebarRight.tabsIn(leaderId).some((tab) => tab.kind === BOARD_TAB_KIND)) return
    // 宿主在切换会话的同一帧把右栏挂到 worker 上；没落定就先不开，避免开在
    // leader 自己的右栏里。下一轮视图变化会再走到这里。
    if (sidebarRight.mounted?.getSnapshot?.() !== currentSessionId) return
    // 目标会话的右栏已经有看板 tab（keepMounted 保留的）时只切焦点，不再
    // openTab：openTab 对已存在的页走 reveal，宿主会让 pane 闪一下高亮——
    // 那正是「切一次闪一次」的来源。
    const existing = sidebarRight.tabsIn(currentSessionId).find((tab) => tab.kind === BOARD_TAB_KIND)
    if (existing !== undefined) {
      lastBoardCarry.current = currentSessionId
      if (sidebarRight.active?.()?.id !== existing.id) sidebarRight.focus(existing.id)
      return
    }
    try {
      // 把项目 id 带进 tab navigation：看板 body 新挂时先用同一项目的上一份
      // 数据起步，不让右栏先闪一下骨架。
      sidebarRight.openTab(BOARD_TAB_KIND, { params: { projectId: view.project.id } })
    } catch {
      // layout effect 可能早于宿主 adopt worker 的右栏 store；这时不标记已处理，
      // 让下面的 effect 在 paint 后重试。openTab 的公开契约也会在没有 surface
      // 时抛错，不能把异常漏进渲染。
      return
    }
    lastBoardCarry.current = currentSessionId
  }, [currentSessionId, getSidebarRight, panelActive, view.visible, view.isWorkerCurrent, view.project?.id, view.project?.leaderSessionId])
  // 先抢在 paint 前开：worker 的右栏默认收起/停在 guide，晚一帧开会让面板
  // 先关再开，看起来闪一下。layout effect 失败时由同名 effect 兜底。
  useLayoutEffect(() => { carryBoard() }, [carryBoard])
  useEffect(() => { carryBoard() }, [carryBoard])

  // 栏真正占位时才让锚点给宿主主面板加 flex 收缩标记；普通会话/浮层打开时
  // 摘掉，别让一个全局布局补丁常驻在宿主上。
  const barVisible = view.visible && !panelActive
  useLayoutEffect(() => { reportVisible?.(barVisible) }, [barVisible, reportVisible])

  if (!barVisible) return null

  const listLabel = t('tabs.list')
  const closeLabel = t('tabs.close')
  const moreLabel = t('tabs.more')
  const openSessionMenu = (event) => {
    if (!hasMenu || currentSessionId === undefined) return
    if (menuOpen) {
      menus.close()
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    menus.open(
      { kind: 'sessionHeader', value: { sessionId: currentSessionId } },
      { x: rect.left, y: rect.bottom },
      { button: 'dsh-leader-agent-session-tabs-more' },
    )
  }
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
      ...(hasMenu ? { 'data-dsh-leader-agent-tabs-menu': '' } : {}),
    },
    createElement(
      'div',
      { className: 'dsh-leader-agent-tabs-scroll', role: 'tablist', 'aria-label': listLabel },
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
          ref: (node) => {
            if (node === null) tabRefs.current.delete(tab.id)
            else tabRefs.current.set(tab.id, node)
          },
          onClick: () => openSession(tab.id),
          onKeyDown: (event) => {
            // 关闭按钮自己的回车/空格会冒泡到这里，不能顺手把标签再打开一次。
            if (event.target !== event.currentTarget) return
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              openSession(tab.id)
              return
            }
            // roving tabindex：非当前标签是 -1，方向键/Home/End 是它们唯一的入口。
            const nextId = tabIdForKey(view.tabs, tab.id, event.key)
            if (nextId === undefined) return
            event.preventDefault()
            if (nextId === view.activeSessionId) {
              tabRefs.current.get(nextId)?.focus()
              return
            }
            pendingFocus.current = nextId
            openSession(nextId)
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
              createElement('span', {
                className: `dsh-leader-agent-tab-signal dsh-leader-agent-tab-signal-${tab.state}`,
                'data-signal': tab.state,
                role: 'img',
                'aria-label': t(SIGNAL_LABEL_KEYS[tab.state]),
                title: t(SIGNAL_LABEL_KEYS[tab.state]),
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
    !hasMenu
      ? null
      : createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-leader-agent-tabs-action',
            'data-dsh-leader-agent-tabs-more': '',
            'aria-label': moreLabel,
            'aria-haspopup': 'menu',
            'aria-expanded': menuOpen ? 'true' : 'false',
            title: moreLabel,
            disabled: currentSessionId === undefined,
            onClick: openSessionMenu,
          },
          productIcon('ellipsis-outline', { size: 14 }),
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
