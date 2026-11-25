/**
 * 看板面板：项目维度的任务看板。
 *
 * 看板是**项目**的看板：一个项目一个看板。面板先按自己所属的会话解析出项目，
 * 再从宿主取该项目的全部卡片（`src/client/project-board-data.js`）——leader 建的
 * 卡与 worker 建的卡在同一处，不再是「卡建在哪个会话就只能在哪看到」。
 *
 * 卡面视觉与交互：卡面零操作铬，active 卡三层、done 卡单行并收进折叠区，
 * 空态与骨架沿用同一套视觉。见
 * `.agents/notes/implemented/feature/2026-10-27-board-card-visual-and-interaction.md`。
 *
 * 信号灯不落存储：等你输入/需注意/执行中/未读/空闲由槽位绑定的会话状态实时
 * 推导。运行态的权威值是宿主按 `api-session/status` 事件维护的那一份，它只经
 * `useSessionStatus` 暴露——而本面板所在的 `sidebar.right.pane.tab` 座不注入这个
 * hook，所以实际拿得到的只有保留会话的快照：执行中与「上次执行失败」成立，
 * 等你输入与未读在这条路径上无从表达。会话列表对未保留的 subagent 子会话给的
 * 是兜底值，据此说「空闲」是撒谎，读不到时如实给「状态未知」。
 *
 * @module dsh-leader-agent/client/board
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  cardSignal,
  foldDoneCards,
  mergeCardSnapshot,
  mergeCardUpdate,
  mergeDetailCard,
  mergeSessionState,
  nextDoneWatermark,
  reconcileBoardOverlays,
  removeCardFromList,
  slotBindingsOf,
  slotViewsForCard,
  sortActiveCards,
  sortDoneCards,
} from './board-projection.js'
import {
  BOARD_REFRESH_MS,
  boardViewState,
  fetchBoardCards,
  fetchSlotLabels,
  isBoardViewable,
  resolveBoardAccess,
  sameProjectSummary,
} from './project-board-data.js'
import { SlotRetention, retainTargetOf } from './slot-retain.js'
import { BoardCard } from './board-card.js'
import { CardDetail } from './card-detail.js'
import { describeCardRemoval } from './card-detail-view.js'
import { ConfirmDialog } from './confirm-dialog.js'
import { ensureBoardStyles } from './board-styles.js'
import { productIcon } from './icons.js'
import { clearBoardForeground, noteBoardForeground } from './board-foreground.js'
import { projectRemoteErrorText } from './project-remote.js'
import { BOARD_MODE_KEY, readBoardMode, subscribeBoardMode } from './board-mode.js'
import { readLocalStorage } from './guide-card-logic.js'
import { BoardRail } from './board-rail.js'

/**
 * 订阅看板显示模式。
 *
 * 同一运行时里设置页写、这里读，走 `board-mode.js` 的模块级订阅；其它窗口靠
 * `storage` 事件同步。取不到存储时按默认模式走，不阻塞渲染。
 *
 * @returns {string} 当前模式
 */
function useBoardMode() {
  const [mode, setMode] = useState(() => readBoardMode(readLocalStorage(globalThis)))
  useEffect(() => {
    const off = subscribeBoardMode(setMode)
    const onStorage = (event) => {
      if (event.key !== BOARD_MODE_KEY) return
      setMode(readBoardMode(readLocalStorage(globalThis)))
    }
    globalThis.addEventListener?.('storage', onStorage)
    return () => {
      off()
      globalThis.removeEventListener?.('storage', onStorage)
    }
  }, [])
  return mode
}

/**
 * 读宿主当前的颜色方案。
 *
 * 主题服务由 `@deepseek-ai/dsh-client-ui-theme` 提供（`ctx.theme.getTheme()`）。
 * 服务缺失（老宿主）时退回系统偏好——总比在深色宿主里给一块浅色面板好。
 *
 * @param {(() => object | undefined) | undefined} getTheme - 取主题服务的延迟取值器
 * @returns {'light' | 'dark'} 颜色方案
 */
function readColorScheme(getTheme) {
  try {
    const active = getTheme?.()?.getTheme?.().active
    if (active?.colorScheme === 'light' || active?.colorScheme === 'dark') return active.colorScheme
  } catch {
    // 主题服务形态不符：走下面的系统偏好兜底
  }
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/**
 * 跟随宿主主题。切换主题时宿主发 `theme/change`，这里只重读快照。
 *
 * @param {(() => object | undefined) | undefined} getTheme - 取主题服务
 * @param {((listener: () => void) => (() => void) | undefined) | undefined} onThemeChange - 订阅
 * @returns {'light' | 'dark'} 当前颜色方案
 */
function useHostColorScheme(getTheme, onThemeChange) {
  const [scheme, setScheme] = useState(() => readColorScheme(getTheme))
  useEffect(() => {
    if (typeof onThemeChange !== 'function') return undefined
    const off = onThemeChange(() => setScheme(readColorScheme(getTheme)))
    return typeof off === 'function' ? off : undefined
  }, [getTheme, onThemeChange])
  return scheme
}

/**
 * 线路图列表的类名：模式 + 主题各一档，浅色与深色共用同一套几何。
 *
 * @param {'light' | 'dark'} scheme - 宿主颜色方案
 * @returns {string} 类名
 */
function cinemaListClass(scheme) {
  return `dsh-leader-agent-board-list dsh-leader-agent-board-list-cinema dsh-leader-agent-board-list-cinema-${scheme}`
}

/**
 * 线路图顶部的 leader 节点。
 *
 * 它是整张图的源头：主干从这里向下，卡片都是它的下游。计数只放在这里，
 * 卡面不重复写。
 *
 * @param {object} props - 组件属性
 * @param {number} props.running - 执行中的卡片数
 * @param {number} props.total - 进行中的卡片数
 * @param {(key: string, params?: Record<string, unknown>) => string} props.t - 翻译函数
 * @returns {object} React 元素
 */
function BoardLeaderRow({ running, total, t }) {
  return createElement(
    'div',
    { className: 'dsh-leader-agent-board-rail-head' },
    createElement('span', { className: 'dsh-leader-agent-board-rail-orb', 'data-rail-leader-dot': '' }),
    createElement(
      'div',
      { className: 'dsh-leader-agent-board-rail-meta' },
      createElement('b', null, t('board.rail.leader')),
      createElement('span', null, t('board.rail.summary', { running, total })),
    ),
  )
}

/**
 * 项目归属与 leader 身份的复核间隔。
 *
 * 卡片每 2 秒拉一次，但「这个会话还是不是该项目的 leader」不必那么频繁：leader
 * 被换新或归档是低频事件，30 秒足以让旧面板切到提示。
 */
const PROJECT_RECHECK_MS = 30_000

/**
 * 看板数据的内存副本，按项目存。
 *
 * 右栏按会话存布局，切到 worker 时看板 body 是新挂的；先把同一项目上一份已加载
 * 的数据画出来，再照常 revalidate，避免先闪骨架。只活在这个浏览器页面里，不落盘。
 */
const BOARD_CACHE = new Map()

/**
 * 读某个项目上一次加载的看板快照。
 * @param {string} projectId - 项目 id
 * @returns {{ project: object, cards: object[] } | undefined} 快照
 */
function cachedBoard(projectId) {
  return BOARD_CACHE.get(projectId)
}

/**
 * 记住某个项目当前的看板快照。
 * @param {string} projectId - 项目 id
 * @param {object} project - 项目摘要
 * @param {object[]} cards - 卡片列表
 * @returns {void} 无返回
 */
function rememberBoard(projectId, project, cards) {
  BOARD_CACHE.set(projectId, { project, cards })
}

/**
 * 看板面板主体。
 *
 * @param {object} props - slot 注入的运行时属性
 * @param {string} props.sessionId - 面板所属会话
 * @param {() => object | undefined} props.getSessions - 取会话服务的延迟取值器
 * @param {() => object | undefined} props.getUiWorkspace - 取导航服务的延迟取值器
 * @param {(method: string, args: unknown[]) => Promise<unknown>} props.callRemote - 项目通道调用
 * @param {Function} [props.useSessionStatus] - 宿主会话状态 hook（宿主未挂载
 *   ui-session 时不存在）
 * @returns {object} React 元素
 */
export function BoardBody(props) {
  const {
    sessionId,
    getSessions,
    getUiWorkspace,
    useSessionStatus,
    useTabInfo,
    getSidebarRight,
    callRemote,
    getTheme,
    onThemeChange,
    t,
  } = props
  // 保留的看板 body 在别的会话/别的位置时仍挂着；只有当前可见的看板才轮询卡片。
  // `useTabInfo` 由右栏 slot 注入；缺它时按可见处理，退回旧行为。
  const useInfo = typeof useTabInfo === 'function' ? useTabInfo : useNoTabInfo
  const tabInfo = useInfo()
  const visible = tabInfo?.tab?.visible !== false
  // 标签栏切 worker 时要不要把这块看板带过去，取决于它是否本来就在前台。
  // 会话已经切走（mounted 不是自己）时保留记录；同一会话里被切到后台或右栏
  // 收起时清掉——那种情况下跟随等于替用户换页面。
  const mountedSessionId = getSidebarRight?.()?.mounted?.getSnapshot?.()
  useEffect(() => {
    if (visible) noteBoardForeground(sessionId)
    else if (mountedSessionId === sessionId) clearBoardForeground(sessionId)
  }, [visible, mountedSessionId, sessionId])
  // 标签栏补开看板时把项目 id 放进 navigation params；有它就能先用同一项目的
  // 上一份看板数据起步，新挂的 worker 面板不会先闪骨架。
  const params = tabInfo?.tab?.navigation?.params
  const projectHint = typeof params?.projectId === 'string' ? params.projectId : undefined
  return createElement(BoardPanel, {
    sessionId,
    getSessions,
    getUiWorkspace,
    useSessionStatus,
    callRemote,
    getTheme,
    onThemeChange,
    t,
    visible,
    projectHint,
  })
}

/**
 * 宿主没挂 ui-session 时的占位 hook。
 *
 * 保持 hook 调用顺序稳定：同一个渲染路径上，状态 hook 的个数不能变。
 */
function useNoSessionStatus() {
  return undefined
}

/**
 * 宿主没给 tabInfo hook 时的占位：按可见处理。
 *
 * 保持 hook 调用顺序稳定：同一个渲染路径上，状态 hook 的个数不能变。
 */
function useNoTabInfo() {
  return undefined
}

/**
 * 两份槽位显示名字典是否等价。
 *
 * 项目复核每 30 秒重取一次标签，内容没变时保持旧引用，避免看板整棵重渲染。
 *
 * @param {Record<string, string>} left - 左快照
 * @param {Record<string, string>} right - 右快照
 * @returns {boolean} 是否等价
 */
function sameSlotLabels(left, right) {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (left[key] !== right[key]) return false
  }
  return true
}

/**
 * 两个状态快照是否等价。
 *
 * 宿主每次发布都会重建状态对象，引用比较会让每次发布都触发重渲染。
 *
 * @param {ReadonlyMap<string, object>} left - 左快照
 * @param {ReadonlyMap<string, object>} right - 右快照
 * @returns {boolean} 是否等价
 */
function sameStatuses(left, right) {
  if (left.size !== right.size) return false
  for (const [sessionId, status] of left) {
    const other = right.get(sessionId)
    if (other === undefined
      || other.running !== status.running
      || other.pendingInteraction !== status.pendingInteraction
      || other.completionUnread !== status.completionUnread) {
      return false
    }
  }
  return true
}

/**
 * 槽位会话的状态表。
 *
 * 状态有两个来源，合并后成一个表：
 *
 * - **宿主会话状态**（`useSessionStatus`）：权威运行态、等你输入、未读确认。
 *   运行时状态由宿主的 `api-session/status` 事件驱动。
 * - **保留会话的快照**：运行态与最后一次执行失败的原因。保留同时让会话不被
 *   宿主回收。
 *
 * `sidebar.right.pane.tab` 座只注入 `tabInfo`，不提供 `useSessionStatus`，所以
 * 实际生产路径上只有快照这一路：执行中与失败成立，等你输入与未读无从表达。
 * 保留失败时该槽位不会出现在表里，界面上如实显示「状态未知」，不谎称空闲。
 *
 * @param {object[]} cards - 当前卡片
 * @param {() => object | undefined} getSessions - 取会话服务的延迟取值器
 * @param {Function} [useSessionStatus] - 宿主会话状态 hook，槽位没注入时为 `undefined`
 * @param {string} parentSessionId - 看板所属会话，卡片没记建卡会话时兜底当父会话
 * @returns {Map<string, object>} 会话 id 到状态
 */
function useSlotStates(cards, getSessions, useSessionStatus, parentSessionId) {
  const [snapshots, setSnapshots] = useState(() => new Map())
  const retention = useRef(undefined)
  const latest = useRef(getSessions)
  latest.current = getSessions
  const parent = useRef(parentSessionId)
  parent.current = parentSessionId
  // 建卡会话表：子代理槽位的地址要用真正的父会话，卡片自己记着 `createdBy`。
  // 表必须按 `cards` 记忆（每次渲染新建会连带 `needed` 变化，把同步效果拖成每
  // 帧跑一次），保留器的闭包经 ref 读最新值。
  const parentsNow = useMemo(() => {
    const table = new Map()
    for (const card of cards) {
      const creator = typeof card.createdBy === 'string' && card.createdBy !== '' ? card.createdBy : undefined
      for (const binding of slotBindingsOf(card)) {
        if (binding.sessionId === '') continue
        // 同一个会话可能绑在多张卡上：优先留记了建卡会话的那一张，存量卡没有
        // `createdBy`，拿它当父会话会让地址挂到看板会话上。
        if (!table.has(binding.sessionId) || (table.get(binding.sessionId) === undefined && creator !== undefined)) {
          table.set(binding.sessionId, creator)
        }
      }
    }
    return table
  }, [cards])
  const parents = useRef(parentsNow)
  parents.current = parentsNow

  // 依赖用 id 排序串而不是 Map 本身：卡片每 2 秒轮询都会换一个新数组，用 Map
  // 当依赖会让 `needed` 每轮都是新 Set，同步效果跟着每 2 秒跑一次——保留失败的
  // 槽位不在账本里，每次都会再 retain 一遍，日志被去重挡住但底层调用没停。
  const neededKey = useMemo(() => [...parentsNow.keys()].sort().join('\n'), [parentsNow])
  const needed = useMemo(
    () => new Set(neededKey === '' ? [] : neededKey.split('\n')),
    [neededKey],
  )

  const useStatuses = useSessionStatus ?? useNoSessionStatus
  const statuses = useStatuses(
    (state) => {
      const next = new Map()
      for (const sessionId of needed) {
        const status = state.get(sessionId)
        if (status !== undefined) next.set(sessionId, status)
      }
      return next
    },
    sameStatuses,
  )

  // 构造本身没有副作用（只是建一张账本表），所以在渲染期惰性创建即可——放进
  // effect 反而要多一个「尚未就绪」的分支。
  if (retention.current === undefined) {
    retention.current = new SlotRetention({
      retain: (sessionId) => {
        const sessions = latest.current()
        if (sessions === undefined || sessions === null) throw new Error('会话服务不可用')
        const options = { source: 'dshLeaderBoard' }
        try {
          return sessions.retain(sessionId, options)
        } catch (error) {
          // 有些会话在客户端会话目录里没有独立条目（如历史 subagent 时代的
          // worker），裸 id 认不出来。这类会话要靠
          // `{ parentSessionId, childSessionId }` 地址才找得到——父会话是建这张卡
          // 的会话，卡片没记时退回看板所属会话。
          // 地址也拿不到就把原错误抛回去，由保留器记下「未知」，不静默换成空闲。
          const target = retainTargetOf(sessions, sessionId, parents.current.get(sessionId) ?? parent.current)
          if (target === undefined) throw error
          try {
            return sessions.retain(target, options)
          } catch {
            throw error
          }
        }
      },
      onState: (sessionId, state) => {
        setSnapshots((previous) => {
          const current = previous.get(sessionId)
          // 宿主每次发布都重建快照对象，值没变就不必换表——换表会让整棵看板重渲染
          if (current !== undefined
            && current.running === state.running
            && current.failed === state.failed) {
            return previous
          }
          const next = new Map(previous)
          next.set(sessionId, state)
          return next
        })
      },
      onDrop: (sessionId) => {
        setSnapshots((previous) => {
          if (!previous.has(sessionId)) return previous
          const next = new Map(previous)
          next.delete(sessionId)
          return next
        })
      },
    })
  }

  useEffect(() => {
    // 依赖只有 needed：`getSessions` 每次渲染都是新函数，带上它会让保存失败的
    // 槽位在每一帧重试一次 retain（宿主对未知会话是同步抛错），把控制台刷满。
    // 取值本来就经 `latest` 的 ref，不需要进依赖。
    retention.current.sync(needed)
  }, [needed])

  useEffect(() => () => {
    retention.current.dispose()
  }, [])

  return useMemo(() => {
    const merged = new Map()
    for (const sessionId of needed) {
      merged.set(sessionId, mergeSessionState(
        statuses?.get(sessionId),
        snapshots.get(sessionId),
      ))
    }
    return merged
  }, [needed, statuses, snapshots])
}

/**
 * 空态。
 *
 * @param {object} props - 组件属性
 * @param {boolean} props.allDone - 是否全部完成
 * @param {string} [props.projectName] - 项目名；看板是项目维度的，空态要说清是谁的
 * @param {(key: string, params?: Record<string, unknown>) => string} props.t - 当前语言的翻译函数
 * @returns {object} React 元素
 */
function BoardEmpty({ allDone, projectName, t }) {
  return createElement(
    'div',
    { className: 'dsh-leader-agent-board-empty' },
    createElement(
      'div',
      {
        className: allDone
          ? 'dsh-leader-agent-board-empty-icon dsh-leader-agent-board-empty-icon-success'
          : 'dsh-leader-agent-board-empty-icon',
      },
      allDone
        ? productIcon('check-circle-outline', { size: 24 })
        : productIcon('checklist-outline', { size: 24 }),
    ),
    createElement(
      'div',
      { className: 'dsh-leader-agent-board-empty-title' },
      allDone ? t('board.empty.doneTitle') : t('board.empty.title'),
    ),
    createElement(
      'div',
      { className: 'dsh-leader-agent-board-empty-hint' },
      allDone
        ? (projectName === undefined
            ? t('board.empty.doneHintOwn')
            : t('board.empty.doneHintNamed', { project: projectName }))
        : t('board.empty.hint'),
    ),
  )
}

/**
 * 看板骨架：项目或身份还没解析出来时的占位。
 *
 * @returns {object} React 元素
 */
function BoardSkeleton({ listClass }) {
  return createElement(
    'div',
    { className: listClass },
    createElement(
      'div',
      { className: 'dsh-leader-agent-board-group' },
      createElement('div', { className: 'dsh-leader-agent-board-skeleton' }),
      createElement('div', { className: 'dsh-leader-agent-board-skeleton' }),
      createElement('div', { className: 'dsh-leader-agent-board-skeleton' }),
    ),
  )
}

/**
 * 看板面板主体实现。
 *
 * @param {object} props - 组件属性
 * @param {string} props.sessionId - 面板所属会话
 * @param {() => object | undefined} props.getSessions - 取会话服务的延迟取值器
 * @param {() => object | undefined} props.getUiWorkspace - 取导航服务的延迟取值器
 * @param {(method: string, args: unknown[]) => Promise<unknown>} props.callRemote - 项目通道调用
 * @param {Function} [props.useSessionStatus] - 宿主会话状态 hook
 * @param {(key: string) => string} props.t - 当前语言的翻译函数（槽位显示名）
 * @param {boolean} [props.visible] - 当前看板是否在屏幕上可见
 * @param {string} [props.projectHint] - 补开看板时带过来的项目 id
 * @returns {object} React 元素
 */
function BoardPanel({
  sessionId,
  getSessions,
  getUiWorkspace,
  useSessionStatus,
  callRemote,
  getTheme,
  onThemeChange,
  t,
  visible,
  projectHint,
}) {
  // 同一项目的上一份看板数据：worker 的首帧直接画卡，不等项目/卡片 RPC。
  const cached = projectHint === undefined ? undefined : cachedBoard(projectHint)
  const [project, setProject] = useState(cached?.project)
  // 项目解析完成与否要和「解析出来是不属于项目」分开：解析是个异步往返，中间
  // 不能先闪一句「不属于任何项目」——那是还没问完就下的结论。
  const [resolved, setResolved] = useState(cached !== undefined)
  // 当前会话是不是该项目的 worker：看板对项目会话开放，worker 也算。
  // `undefined` 表示还没判定——不能默认 false，那会让 worker 的首帧落进
  // 「看板只在项目会话中打开」的分支。缓存来自补开的 worker 看板，先按 worker
  // 画出来，项目访问权回来后再校正。
  const [worker, setWorker] = useState(cached === undefined ? undefined : true)
  const [cards, setCards] = useState(() => cached?.cards ?? [])
  // 两个错误源分开存：项目复核失败与卡片刷新失败各自有出口，否则一方成功
  // 会把另一方的错误清掉，错误页闪进闪出且提示与真实原因不符。
  const [projectError, setProjectError] = useState(null)
  const [cardsError, setCardsError] = useState(null)
  // 槽位显示名：项目 `SLOTS.md` 的 `label:`，没声明的槽位由 locales 回落。
  const [slotLabels, setSlotLabels] = useState(() => ({}))
  const [loaded, setLoaded] = useState(cached !== undefined)
  // 缓存只用于本次挂载的首帧；项目访问权回来后就不再走「保留旧状态」的分支。
  const prefilled = useRef(cached !== undefined)
  // 可见性暂停后重入的是同一会话：要沿用已加载的卡片，不能当换会话清空。
  const accessSession = useRef(undefined)
  const [detail, setDetail] = useState(null)
  // 删除确认框独立于详情：确认框打开时详情先卸载，避免两层 modal 同时监听
  // Escape、抢焦点陷阱。取消后详情按原 anchor 重新打开。
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  // 删除前已发出的轮询可能带着旧快照晚到；记住本地删掉的 id，别让它在下一轮
  // 请求返回时又冒出来。卡片 id 不复用，这个集合在会话生命周期内不需要清。
  const deletedCardIds = useRef(new Set())
  const [doneOpen, setDoneOpen] = useState(false)
  // 已完成区的页码：组件本地状态，收起再展开不回退（宿主会话列表同样不持久化）。
  const [doneWatermark, setDoneWatermark] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    ensureBoardStyles()
  }, [])

  useEffect(() => {
    // 看板换了项目（或项目被删掉）时放弃未完成的删除确认：确认框里的卡属于
    // 上一个看板，不能跟着新看板漂移。项目摘要每 30 秒复核一次，但 id 没变时
    // 这个 effect 不会重跑，不会误关用户正开着的确认框。
    setPendingDelete(null)
    setDeleteError('')
  }, [project?.id])

  useEffect(() => {
    // 隐藏的看板不跑时钟：相对时间回到可见时会重新取一次 Date.now()。
    if (!visible) return undefined
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
    return () => clearInterval(timer)
  }, [visible])

  // 浮层 portal 到 document.body，不随看板 body 的显隐卸载。切走会话/切到别的
  // tab 后它仍会盖在新会话上，所以一不可见就关掉详情与删除确认。
  useEffect(() => {
    if (visible) return
    setDetail(null)
    setPendingDelete(null)
    setDeleteError('')
  }, [visible])

  // 看板是项目维度的：先按面板所属的会话解析出项目。会话换了（面板随之重挂载）
  // 就重新解析；同一会话下定期复核——leader 可能在面板打开期间被换新或归档，
  // 身份与存活状态不能只在挂载时问一次。
  useEffect(() => {
    // 隐藏的看板不复核项目身份：切回可见时这个 effect 会立刻重跑一次。
    if (!visible) return undefined
    let cancelled = false
    const sameSession = accessSession.current === sessionId
    accessSession.current = sessionId
    const keepPrefilled = prefilled.current || sameSession
    prefilled.current = false
    setProjectError(null)
    if (!keepPrefilled) {
      setResolved(false)
      // 换了会话就是换了项目，上一个项目的卡片与身份不能留在面板里。
      setCards([])
      setLoaded(false)
      setWorker(undefined)
      setSlotLabels({})
      deletedCardIds.current.clear()
    }
    // 会话换了就放弃上一条删除确认：确认框属于旧会话的看板，不能跟着新看板漂移。
    setPendingDelete(null)
    setDeleteError('')
    const load = () => {
      resolveBoardAccess(callRemote, sessionId)
        .then((access) => {
          if (cancelled) return
          // 摘要没变时保持旧引用：否则卡片取数的 effect 会跟着每 30 秒重启一次。
          // 项目与 worker 身份同一批落地：中间没有「有项目但身份未知」的渲染。
          setProject((previous) => (sameProjectSummary(previous, access.project) ? previous : access.project))
          setWorker(access.worker)
          setResolved(true)
          setProjectError(null)
          if (access.project === undefined) {
            setSlotLabels({})
            return
          }
          // 显示名是装饰信息：取不到就回落 locale/原名，不把看板打进错误页。
          fetchSlotLabels(callRemote, access.project.id)
            .then((labels) => {
              if (cancelled) return
              setSlotLabels((previous) => (sameSlotLabels(previous, labels) ? previous : labels))
            })
            .catch(() => {})
        })
        .catch((cause) => {
          if (cancelled) return
          // 复核失败只在还没有摘要时才算错误；已有摘要就保留旧值——面板每 30 秒
          // 复核一次，一次 RPC 抖动不该把已显示的看板打回错误页。
          setProjectError(projectRemoteErrorText(cause, t, 'board.error.project'))
        })
    }
    load()
    const timer = setInterval(load, PROJECT_RECHECK_MS)
    const onFocus = () => { load() }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [sessionId, callRemote, visible, t])

  // 卡片取数：挂载时拉一次，之后定时刷新，窗口重新聚焦时立刻刷一次。
  // 定时刷新是必要的——卡片可能由别的会话（worker）建，那边的事件流不在本面板
  // 的窗口里，等不到它的变化。
  useEffect(() => {
    // 被 keepMounted 保留但当前不可见的看板不轮询：切回可见时会立刻刷一次，
    // 已挂着的卡片原样显示，不会因为重新挂载而闪骨架。
    if (!visible) return undefined
    // 看板只对项目会话开放：同目录的普通会话也能解析到项目（卡片归属要用），
    // 但这里不给它们取卡。leader 会话已失效时同样不取。
    if (!isBoardViewable(project, sessionId, worker)) return undefined
    let cancelled = false
    const refresh = () => {
      fetchBoardCards(callRemote, project.id)
        .then((next) => {
          if (cancelled) return
          // 保存链接后本地回填的卡版本更高：在这一刻之前发出的取数请求，响应
          // 晚到时不能把刚保存的内容打回旧值。已删除的卡同理，不能从旧快照里
          // 复活。
          setCards((current) => {
            const merged = mergeCardSnapshot(current, next)
            return deletedCardIds.current.size === 0
              ? merged
              : merged.filter((card) => !deletedCardIds.current.has(card.id))
          })
          setLoaded(true)
          // 成功就清掉上一次的错误：项目通道比面板晚就绪、或一次 RPC 抖动，
          // 都不该把面板判死在错误页上——2 秒轮询本来就是干这个的。
          setCardsError(null)
        })
        .catch((cause) => {
          if (cancelled) return
          // 轮询失败保留已加载的卡片，只是把错误挂出来，不清空列表。
          setCardsError(projectRemoteErrorText(cause, t, 'board.error.cards'))
        })
    }
    refresh()
    const timer = setInterval(refresh, BOARD_REFRESH_MS)
    const onFocus = () => { refresh() }
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [project, worker, callRemote, sessionId, visible, t])

  // 卡片状态一变就更新内存快照：同一项目的下一个看板 body 直接拿这份数据起步。
  useEffect(() => {
    if (project === undefined || !loaded) return
    rememberBoard(project.id, project, cards)
  }, [project, cards, loaded])

  const cardList = cards
  const states = useSlotStates(cardList, getSessions, useSessionStatus, sessionId)

  const { active, done } = useMemo(() => ({
    active: sortActiveCards(
      cardList.filter((card) => card.status === 'active'),
      states,
    ),
    done: sortDoneCards(cardList.filter((card) => card.status === 'done')),
  }), [cardList, states])
  const doneFold = foldDoneCards(done, doneWatermark, t)

  const mode = useBoardMode()
  const cinema = mode === 'cinema'
  const scheme = useHostColorScheme(getTheme, onThemeChange)
  const listClass = cinema ? cinemaListClass(scheme) : 'dsh-leader-agent-board-list'
  // 线路图只画进行中的卡：完成区是历史，收在折叠里，不参与拓扑
  const signals = useMemo(
    () => new Map(active.map((card) => [card.id, cardSignal(card, states)])),
    [active, states],
  )
  const runningCount = useMemo(
    () => [...signals.values()].filter((signal) => signal === 'running').length,
    [signals],
  )
  // 行身份 + 状态的签名：轮询每 2 秒换一次数组，签名不变就不重画，光点不从头上路
  // 签名要带每个执行者的状态：一张卡上两个 worker 一跑一停，卡片级信号可能
  // 一直是 running，只有槽位状态能触发支线重画
  const railKey = useMemo(
    () => `${mode}|${scheme}|${active.map((card) => {
      const slotStates = slotViewsForCard(card, states)
        .filter((slot) => slot.sessionId !== '')
        .map((slot) => slot.state)
        .join(',')
      return `${card.id}:${signals.get(card.id)}:${slotStates}`
    }).join('|')}`,
    [mode, scheme, active, states, signals],
  )

  const openSession = useCallback((targetSessionId) => {
    const uiWorkspace = getUiWorkspace?.()
    if (uiWorkspace === undefined || uiWorkspace === null) return
    uiWorkspace.openSession(targetSessionId)
  }, [getUiWorkspace])

  const openDetail = useCallback((card, anchor) => { setDetail({ card, anchor }) }, [])

  // 链接改完立刻回填：浮层里的卡片是打开瞬间的快照，不回填的话刚保存的内容要
  // 等关掉重开才看得见。列表一起换掉，卡面 chip 也不必等下一轮轮询。
  const cardUpdated = useCallback((updated) => {
    if (updated === null || typeof updated !== 'object') return
    setCards((current) => mergeCardUpdate(current, updated))
    setDetail((current) => mergeDetailCard(current, updated))
  }, [])

  const requestDelete = useCallback(() => {
    setDeleteError('')
    setPendingDelete(detail?.card ?? null)
  }, [detail])

  const cancelDelete = useCallback(() => {
    // 请求已经发出时不再撤掉确认框：关闭它不会取消宿主侧的删除，
    // 只会让用户以为没删。等请求返回后按结果显示。
    if (deleteBusy) return
    setDeleteError('')
    setPendingDelete(null)
  }, [deleteBusy])

  const confirmDelete = useCallback(async () => {
    if (deleteBusy || pendingDelete === null) return
    setDeleteBusy(true)
    setDeleteError('')
    try {
      await callRemote('deleteCard', [pendingDelete.id])
      deletedCardIds.current.add(pendingDelete.id)
      setCards((current) => removeCardFromList(current, pendingDelete.id))
      setDetail((current) => (current?.card?.id === pendingDelete.id ? null : current))
      setPendingDelete(null)
    } catch (error) {
      setDeleteError(projectRemoteErrorText(error, t, 'board.error.delete'))
    } finally {
      setDeleteBusy(false)
    }
  }, [callRemote, deleteBusy, pendingDelete])

  // 取卡条件与下面的展示分支读同一个判定，避免两处守卫各写一套。
  const view = boardViewState(project, sessionId, worker)

  // 详情与确认框只对列表里还在的卡有效。轮询把列表清空（另一窗口删掉最后一张卡）
  // 时会走下面的空态提前 return：那里不渲染浮层，但状态留着会在下一张卡到达时把
  // 旧确认框弹回来。对账放在所有提前 return 之前，这条路径也覆盖到。
  const overlays = reconcileBoardOverlays(cards, detail, pendingDelete)

  // 只有还没解析出项目时，项目错误才占满面板；已有摘要就让复核失败静默重试。
  if (projectError !== null && project === undefined) {
    return createElement(
      'div',
      { className: 'dsh-leader-agent-board-empty' },
      createElement('div', { className: 'dsh-leader-agent-board-empty-title' }, projectError),
    )
  }

  // 会话不属于任何项目：没有项目看板可看。这不是错误状态，是「这里没有看板」。
  // 解析还没回来时先给骨架——早闪一句「不属于任何项目」是还没问完就下的结论。
  if (view === 'no-project') {
    return createElement(
      'div',
      { className: listClass },
      resolved
        ? createElement(
            'div',
            { className: 'dsh-leader-agent-board-empty' },
            createElement(
              'div',
              { className: 'dsh-leader-agent-board-empty-title' },
              t('board.noProject.title'),
            ),
            createElement(
              'div',
              { className: 'dsh-leader-agent-board-empty-hint' },
              t('board.noProject.hint'),
            ),
          )
        : createElement(BoardSkeleton, { listClass }),
    )
  }

  // 身份还没问出来（worker 表那一趟还没回来）：先给骨架。这里不能落进下面的
  // 「不是项目会话」分支——worker 打开看板会先闪一句错话再跳到卡片列表。
  if (view === 'pending') {
    return createElement(BoardSkeleton, { listClass })
  }

  // 属于项目但不是项目会话（同目录的普通会话）；leader 本身已失效（归档或被
  // 替换但绑定没改）时指路去左栏换新 leader，不把人指向一个打不开的会话。
  if (view === 'leader-dead' || view === 'not-viewable') {
    const leaderDead = view === 'leader-dead'
    // 没有项目名时不能把它塞进「某项目名 + 介词」的提示：ru/de 的格会错。
    const projectName = project?.name
    return createElement(
      'div',
      { className: listClass },
      createElement(
        'div',
        { className: 'dsh-leader-agent-board-empty' },
        createElement(
          'div',
          { className: 'dsh-leader-agent-board-empty-title' },
          leaderDead ? t('board.leaderDead.title') : t('board.notProject.title'),
        ),
        createElement(
          'div',
          { className: 'dsh-leader-agent-board-empty-hint' },
          leaderDead
            ? t('board.leaderDead.hint')
            : projectName ? t('board.notProject.hint', { project: projectName }) : t('board.notProject.unknown'),
        ),
      ),
    )
  }

  // 首次取卡就失败才占满面板；已经有卡片时刷新失败只留着列表等下一轮。
  if (cardsError !== null && cards.length === 0) {
    return createElement(
      'div',
      { className: 'dsh-leader-agent-board-empty' },
      createElement('div', { className: 'dsh-leader-agent-board-empty-title' }, cardsError),
    )
  }

  if (!loaded) {
    return createElement(BoardSkeleton, { listClass })
  }

  if (cards.length === 0) {
    return createElement(
      'div',
      { className: listClass },
      createElement(BoardEmpty, { allDone: false, projectName: project.name, t }),
    )
  }

  const deleteDialog = createElement(ConfirmDialog, {
    open: overlays.pendingDelete !== null,
    title: t('board.delete.title'),
    description: overlays.pendingDelete === null ? '' : describeCardRemoval(overlays.pendingDelete, t),
    confirmLabel: t('common.delete'),
    cancelLabel: t('common.cancel'),
    danger: true,
    busy: deleteBusy,
    error: deleteError,
    onConfirm: () => { void confirmDelete() },
    onCancel: cancelDelete,
  })

  return createElement(
    'div',
    { className: 'dsh-leader-agent-board', 'data-mode': mode, 'data-theme': scheme },
    createElement(
      'div',
      { className: listClass },
      createElement(
        'div',
        { className: 'dsh-leader-agent-board-stage' },
        cinema
          ? createElement(BoardRail, { railKey, orthogonal: scheme === 'light', theme: scheme })
          : null,
        cinema ? createElement(BoardLeaderRow, { running: runningCount, total: active.length, t }) : null,
        active.length > 0
        ? createElement(
            'div',
            { className: 'dsh-leader-agent-board-group' },
            active.map((card) => createElement(BoardCard, {
              key: card.id,
              card,
              states,
              now,
              slotLabels,
              t,
              cinema,
              onOpenDetail: openDetail,
              onOpenSession: openSession,
            })),
          )
        : null,
      active.length === 0 ? createElement(BoardEmpty, { allDone: true, projectName: project.name, t }) : null,
      done.length > 0
        ? createElement(
            'div',
            { className: 'dsh-leader-agent-board-done-section' },
            createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-leader-agent-board-done-toggle',
                'aria-expanded': doneOpen,
                onClick: () => { setDoneOpen(!doneOpen) },
              },
              createElement(
                'span',
                {
                  className: doneOpen
                    ? 'dsh-leader-agent-board-done-chevron dsh-leader-agent-board-done-chevron-open'
                    : 'dsh-leader-agent-board-done-chevron',
                },
                productIcon('chevron-right-outline', { size: 14 }),
              ),
              t('board.done'),
              createElement('span', { className: 'dsh-leader-agent-board-done-count' }, String(done.length)),
            ),
            doneOpen
              ? createElement(
                  'div',
                  { className: 'dsh-leader-agent-board-group' },
                  doneFold.rows.map((card) => createElement(BoardCard, {
                    key: card.id,
                    card,
                    states,
                    now,
                    slotLabels,
                    t,
                    onOpenDetail: openDetail,
                    onOpenSession: openSession,
                  })),
                  doneFold.hiddenCount === 0 && !doneFold.expanded
                    ? null
                    : createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-leader-agent-board-done-more',
                          'aria-expanded': doneFold.expanded,
                          onClick: () => {
                            if (doneFold.expanded) {
                              setDoneWatermark(0)
                              return
                            }
                            setDoneWatermark((value) => nextDoneWatermark(
                              doneFold.hiddenCount,
                              Math.max(value, done.length - doneFold.hiddenCount),
                            ))
                          },
                        },
                        doneFold.expanded ? t('common.collapse') : doneFold.expandLabel,
                      ),
                )
              : null,
          )
        : null,
      ),
    ),
    overlays.detail === null || overlays.pendingDelete !== null
      ? null
      : createElement(CardDetail, {
          card: overlays.detail.card,
          onClose: () => { setDetail(null) },
          callRemote,
          onUpdated: cardUpdated,
          onDelete: requestDelete,
          restoreFocus: overlays.detail.anchor,
          t,
        }),
    deleteDialog,
  )
}
