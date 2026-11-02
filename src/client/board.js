/**
 * 看板面板：项目维度的任务看板。
 *
 * 看板是**项目**的看板：一个项目一个看板。面板先按自己所属的会话解析出项目，
 * 再从宿主取该项目的全部卡片（`src/client/project-board-data.js`）——协调者建的
 * 卡与 worker 建的卡在同一处，不再是「卡建在哪个会话就只能在哪看到」。
 *
 * 卡面视觉与交互：卡面零操作铬，active 卡三层、done 卡单行并收进折叠区，
 * 空态与骨架沿用同一套视觉。见
 * `.agents/notes/2026-10-27-board-card-visual-and-interaction.md`。
 *
 * 信号灯不落存储：等你输入/需注意/执行中/未读/空闲由槽位绑定的会话状态实时
 * 推导。运行态的权威值是宿主按 `api-session/status` 事件维护的那一份，它只经
 * `useSessionStatus` 暴露——而本面板所在的 `sidebar.right.pane.tab` 座不注入这个
 * hook，所以实际拿得到的只有保留会话的快照：执行中与「上次执行失败」成立，
 * 等你输入与未读在这条路径上无从表达。会话列表对未保留的 subagent 子会话给的
 * 是兜底值，据此说「空闲」是撒谎，读不到时如实给「状态未知」。
 *
 * @module dsh-leader-kit/client/board
 */

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  mergeSessionState,
  slotBindingsOf,
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
import { ensureBoardStyles } from './board-styles.js'
import { productIcon } from './icons.js'

/**
 * 项目归属与协调者身份的复核间隔。
 *
 * 卡片每 2 秒拉一次，但「这个会话还是不是该项目的协调者」不必那么频繁：协调者
 * 被换新或归档是低频事件，30 秒足以让旧面板切到提示。
 */
const PROJECT_RECHECK_MS = 30_000

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
  const { sessionId, getSessions, getUiWorkspace, useSessionStatus, callRemote, t } = props
  return createElement(BoardPanel, {
    sessionId,
    getSessions,
    getUiWorkspace,
    useSessionStatus,
    callRemote,
    t,
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
        const options = { source: 'dshCoordinatorBoard' }
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
 * @returns {object} React 元素
 */
function BoardEmpty({ allDone, projectName }) {
  const whose = projectName === undefined ? '本项目' : `「${projectName}」`
  return createElement(
    'div',
    { className: 'dsh-leader-kit-board-empty' },
    createElement(
      'div',
      {
        className: allDone
          ? 'dsh-leader-kit-board-empty-icon dsh-leader-kit-board-empty-icon-success'
          : 'dsh-leader-kit-board-empty-icon',
      },
      allDone
        ? productIcon('check-circle-outline', { size: 24 })
        : productIcon('checklist-outline', { size: 24 }),
    ),
    createElement(
      'div',
      { className: 'dsh-leader-kit-board-empty-title' },
      allDone ? '全部完成' : '还没有卡片',
    ),
    createElement(
      'div',
      { className: 'dsh-leader-kit-board-empty-hint' },
      allDone ? `${whose}的卡片都已完成` : '协调者调用 create_card 后，卡片会出现在这里',
    ),
  )
}

/**
 * 看板骨架：项目或身份还没解析出来时的占位。
 *
 * @returns {object} React 元素
 */
function BoardSkeleton() {
  return createElement(
    'div',
    { className: 'dsh-leader-kit-board-list' },
    createElement(
      'div',
      { className: 'dsh-leader-kit-board-group' },
      createElement('div', { className: 'dsh-leader-kit-board-skeleton' }),
      createElement('div', { className: 'dsh-leader-kit-board-skeleton' }),
      createElement('div', { className: 'dsh-leader-kit-board-skeleton' }),
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
 * @returns {object} React 元素
 */
function BoardPanel({ sessionId, getSessions, getUiWorkspace, useSessionStatus, callRemote, t }) {
  const [project, setProject] = useState(undefined)
  // 项目解析完成与否要和「解析出来是不属于项目」分开：解析是个异步往返，中间
  // 不能先闪一句「不属于任何项目」——那是还没问完就下的结论。
  const [resolved, setResolved] = useState(false)
  // 当前会话是不是该项目的 worker：看板对项目会话开放，worker 也算。
  // `undefined` 表示还没判定——不能默认 false，那会让 worker 的首帧落进
  // 「看板只在项目会话中打开」的分支。
  const [worker, setWorker] = useState(undefined)
  const [cards, setCards] = useState(() => [])
  // 两个错误源分开存：项目复核失败与卡片刷新失败各自有出口，否则一方成功
  // 会把另一方的错误清掉，错误页闪进闪出且提示与真实原因不符。
  const [projectError, setProjectError] = useState(null)
  const [cardsError, setCardsError] = useState(null)
  // 槽位显示名：项目 `SLOTS.md` 的 `label:`，没声明的槽位由 locales 回落。
  const [slotLabels, setSlotLabels] = useState(() => ({}))
  const [loaded, setLoaded] = useState(false)
  const [detail, setDetail] = useState(null)
  const [doneOpen, setDoneOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    ensureBoardStyles()
  }, [])

  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 60_000)
    return () => clearInterval(timer)
  }, [])

  // 看板是项目维度的：先按面板所属的会话解析出项目。会话换了（面板随之重挂载）
  // 就重新解析；同一会话下定期复核——协调者可能在面板打开期间被换新或归档，
  // 身份与存活状态不能只在挂载时问一次。
  useEffect(() => {
    let cancelled = false
    setProjectError(null)
    setResolved(false)
    // 换了会话就是换了项目，上一个项目的卡片与身份不能留在面板里。
    setCards([])
    setLoaded(false)
    setWorker(undefined)
    setSlotLabels({})
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
          setProjectError(`读取项目失败：${cause instanceof Error ? cause.message : String(cause)}`)
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
  }, [sessionId, callRemote])

  // 卡片取数：挂载时拉一次，之后定时刷新，窗口重新聚焦时立刻刷一次。
  // 定时刷新是必要的——卡片可能由别的会话（worker）建，那边的事件流不在本面板
  // 的窗口里，等不到它的变化。
  useEffect(() => {
    // 看板只对项目会话开放：同目录的普通会话也能解析到项目（卡片归属要用），
    // 但这里不给它们取卡。协调者会话已失效时同样不取。
    if (!isBoardViewable(project, sessionId, worker)) return undefined
    let cancelled = false
    const refresh = () => {
      fetchBoardCards(callRemote, project.id)
        .then((next) => {
          if (cancelled) return
          setCards(next)
          setLoaded(true)
          // 成功就清掉上一次的错误：项目通道比面板晚就绪、或一次 RPC 抖动，
          // 都不该把面板判死在错误页上——2 秒轮询本来就是干这个的。
          setCardsError(null)
        })
        .catch((cause) => {
          if (cancelled) return
          // 轮询失败保留已加载的卡片，只是把错误挂出来，不清空列表。
          setCardsError(`读取卡片失败：${cause instanceof Error ? cause.message : String(cause)}`)
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
  }, [project, worker, callRemote, sessionId])

  const cardList = cards
  const states = useSlotStates(cardList, getSessions, useSessionStatus, sessionId)

  const { active, done } = useMemo(() => ({
    active: sortActiveCards(
      cardList.filter((card) => card.status === 'active'),
      states,
    ),
    done: sortDoneCards(cardList.filter((card) => card.status === 'done')),
  }), [cardList, states])

  const openSession = useCallback((targetSessionId) => {
    const uiWorkspace = getUiWorkspace?.()
    if (uiWorkspace === undefined || uiWorkspace === null) return
    uiWorkspace.openSession(targetSessionId)
  }, [getUiWorkspace])

  const openDetail = useCallback((card, anchor) => { setDetail({ card, anchor }) }, [])

  // 取卡条件与下面的展示分支读同一个判定，避免两处守卫各写一套。
  const view = boardViewState(project, sessionId, worker)

  // 只有还没解析出项目时，项目错误才占满面板；已有摘要就让复核失败静默重试。
  if (projectError !== null && project === undefined) {
    return createElement(
      'div',
      { className: 'dsh-leader-kit-board-empty' },
      createElement('div', { className: 'dsh-leader-kit-board-empty-title' }, projectError),
    )
  }

  // 会话不属于任何项目：没有项目看板可看。这不是错误状态，是「这里没有看板」。
  // 解析还没回来时先给骨架——早闪一句「不属于任何项目」是还没问完就下的结论。
  if (view === 'no-project') {
    return createElement(
      'div',
      { className: 'dsh-leader-kit-board-list' },
      resolved
        ? createElement(
            'div',
            { className: 'dsh-leader-kit-board-empty' },
            createElement(
              'div',
              { className: 'dsh-leader-kit-board-empty-title' },
              '当前会话不属于任何项目',
            ),
            createElement(
              'div',
              { className: 'dsh-leader-kit-board-empty-hint' },
              '看板按项目组织：在项目会话（协调者或 worker）里打开它。',
            ),
          )
        : createElement(BoardSkeleton),
    )
  }

  // 身份还没问出来（worker 表那一趟还没回来）：先给骨架。这里不能落进下面的
  // 「不是项目会话」分支——worker 打开看板会先闪一句错话再跳到卡片列表。
  if (view === 'pending') {
    return createElement(BoardSkeleton)
  }

  // 属于项目但不是项目会话（同目录的普通会话）；协调者本身已失效（归档或被
  // 替换但绑定没改）时指路去左栏换新协调者，不把人指向一个打不开的会话。
  if (view === 'coordinator-dead' || view === 'not-viewable') {
    const coordinatorDead = view === 'coordinator-dead'
    return createElement(
      'div',
      { className: 'dsh-leader-kit-board-list' },
      createElement(
        'div',
        { className: 'dsh-leader-kit-board-empty' },
        createElement(
          'div',
          { className: 'dsh-leader-kit-board-empty-title' },
          coordinatorDead ? '该项目的协调者会话已失效' : '看板只在项目会话中打开',
        ),
        createElement(
          'div',
          { className: 'dsh-leader-kit-board-empty-hint' },
          coordinatorDead
            ? '请在左栏项目区块对该项目换新协调者，再打开看板。'
            : `这是「${project.name ?? '本项目'}」所在目录里的普通会话；去该项目的协调者或 worker 会话查看交付看板。`,
        ),
      ),
    )
  }

  // 首次取卡就失败才占满面板；已经有卡片时刷新失败只留着列表等下一轮。
  if (cardsError !== null && cards.length === 0) {
    return createElement(
      'div',
      { className: 'dsh-leader-kit-board-empty' },
      createElement('div', { className: 'dsh-leader-kit-board-empty-title' }, cardsError),
    )
  }

  if (!loaded) {
    return createElement(BoardSkeleton)
  }

  if (cards.length === 0) {
    return createElement(
      'div',
      { className: 'dsh-leader-kit-board-list' },
      createElement(BoardEmpty, { allDone: false, projectName: project.name }),
    )
  }

  return createElement(
    'div',
    { className: 'dsh-leader-kit-board' },
    createElement(
      'div',
      { className: 'dsh-leader-kit-board-list' },
      active.length > 0
        ? createElement(
            'div',
            { className: 'dsh-leader-kit-board-group' },
            active.map((card) => createElement(BoardCard, {
              key: card.id,
              card,
              states,
              now,
              slotLabels,
              t,
              onOpenDetail: openDetail,
              onOpenSession: openSession,
            })),
          )
        : null,
      active.length === 0 ? createElement(BoardEmpty, { allDone: true, projectName: project.name }) : null,
      done.length > 0
        ? createElement(
            'div',
            { className: 'dsh-leader-kit-board-done-section' },
            createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-leader-kit-board-done-toggle',
                'aria-expanded': doneOpen,
                onClick: () => { setDoneOpen(!doneOpen) },
              },
              createElement(
                'span',
                {
                  className: doneOpen
                    ? 'dsh-leader-kit-board-done-chevron dsh-leader-kit-board-done-chevron-open'
                    : 'dsh-leader-kit-board-done-chevron',
                },
                productIcon('chevron-right-outline', { size: 14 }),
              ),
              '已完成',
              createElement('span', { className: 'dsh-leader-kit-board-done-count' }, String(done.length)),
            ),
            doneOpen
              ? createElement(
                  'div',
                  { className: 'dsh-leader-kit-board-group' },
                  done.map((card) => createElement(BoardCard, {
                    key: card.id,
                    card,
                    states,
                    now,
                    slotLabels,
                    t,
                    onOpenDetail: openDetail,
                    onOpenSession: openSession,
                  })),
                )
              : null,
          )
        : null,
    ),
    detail === null
      ? null
      : createElement(CardDetail, {
          card: detail.card,
          onClose: () => { setDetail(null) },
          restoreFocus: detail.anchor,
        }),
  )
}
