/**
 * 左栏项目区块。
 *
 * 宿主侧的项目注册表是唯一真源，浏览器侧只做呈现与操作：列项目、加项目、打开
 * 项目的 leader 会话、改名、换新 leader、删除项目。
 *
 * **加项目**：选目录 → 直接建好。宿主在选中的目录里建一个 leader 会话并与项目
 * 绑定，项目名默认取目录名（要改随时用行上的「重命名」）。建完就在列表里，不多
 * 一步确认——注册流程要用户再点一次才生效，凭空多一道手续。
 *
 * **打开项目**：点项目名就打开它的 leader 会话——项目的切换就是会话的切换，会话
 * 的工作目录在创建时定死。
 *
 * **项目树**：点项目行展开或收起该项目的 worker 会话。归属由宿主判定——浏览器侧
 * 没有文件系统，做不了路径归一；worker 身份看会话头的 `origin`。
 *
 * **与官方工作区树并行**：项目的 worker 与 leader 会话不在官方工作区树里重复出现。
 * 官方没有「按项目排除会话」的扩展点，这层排除走渲染层（见
 * `workspace-exclusion.js`）。项目目录的工作区行照常显示：用户在项目目录里手动
 * 开的会话不属于项目，藏掉工作区会让它们无处可寻。
 *
 * **位置**：宽侧栏里区块插在「自动化任务」面板行之下、工作区列表之上。左栏正文
 * 区只有 `sidebar.workspaces` 一个槽且已被官方工作区浏览占用，slot 机制没有装饰
 * 或包装能力，第三方无法在它旁边插入并列区块——所以这里按宿主左栏的结构，在
 * 面板列表之后安一个容器，用 portal 把内容渲染进去。锚点找不到时内容退回底部
 * 槽，不至于消失。
 *
 * 窄侧栏（56px 导轨）放不下列表，改为一个入口按钮 + 浮层。
 *
 * @module dsh-leader-kit/client/project-panel
 */

import { createElement, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ProjectSection } from './project-section.js'
import { productIcon } from './icons.js'
import {
  classifyDeletionResult,
  collectExcludedSessionIds,
  createWriteQueue,
  currentSessionIdOf,
  defaultProjectName,
  describeDeletionNotice,
  describeProjectRemoval,
  isArchiveActiveRefusal,
  isProjectOpenable,
  moveProjectBefore,
  openLeaderSession,
  quietWorkspaceOf,
  validateProjectName,
} from './project-panel-logic.js'
import { isProjectRemoteReady, onProjectRemoteReady, projectRemoteError } from './project-remote.js'
import { notifyProjectsChanged } from './project-changes.js'
import { showToast } from './toast.js'
import { createWorkspaceExclusion } from './workspace-exclusion.js'
import { ConfirmDialog } from './confirm-dialog.js'

/**
 * 项目区块。
 * @param {object} props - slot 注入的运行时属性
 * @param {boolean} props.wide - 侧栏是否宽（false 为 56px 导轨）
 * @param {(method: string, args: unknown[]) => Promise<unknown>} props.callRemote - 调用宿主远程方法
 * @param {() => object | undefined} props.getUiWorkspace - 取导航服务
 * @param {() => object | undefined} props.getSessions - 取会话服务
 * @param {() => object | undefined} props.getWorkspaces - 取工作区服务（归档会话走它）
 * @param {(listener: () => void) => (() => void)} [props.onWorkspacesReady] - 订阅工作区服务就绪
 * @returns {object} React 元素
 */
export function ProjectPanel(props) {
  const { wide, callRemote, getUiWorkspace, getSessions, getWorkspaces, onWorkspacesReady } = props
  const [projects, setProjects] = useState([])
  const [busy, setBusy] = useState(false)
  const [floating, setFloating] = useState(false)
  /** 项目 id 到该项目的会话 id 列表。 */
  const [sessionsByProject, setSessionsByProject] = useState(() => new Map())
  /** 会话 id 到会话行（标题、运行状态、来源）。 */
  const [sessionRows, setSessionRows] = useState({})
  /** 展开了子会话列表的项目 id。 */
  const [expandedProjects, setExpandedProjects] = useState(() => new Set())
  /** 整个项目列表是否展开（区块标题可折叠）。 */
  const [listExpanded, setListExpanded] = useState(true)
  /** 待确认删除的项目；null 表示没有待确认的删除。 */
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleteError, setDeleteError] = useState('')
  /**
   * 待确认「停止并归档」的会话；null 表示没有。
   *
   * 只在宿主以 `workspace/session-active` 拒绝时出现：会话还在跑，归档会打断它，
   * 这件事得用户点头。
   */
  const [pendingArchive, setPendingArchive] = useState(null)
  const [archiveError, setArchiveError] = useState('')
  /** 已归档的会话 id：宿主快照是真源，左栏只按它把行藏起来。 */
  const [archivedSessionIds, setArchivedSessionIds] = useState(() => new Set())
  /** 主区域的当前会话 id；宿主按它点亮会话行与工作区分组。 */
  const [currentSessionId, setCurrentSessionId] = useState(undefined)
  /** 工作区视图（`{ workspaceId, sessionIds }`）；用来从当前会话反查所属工作区。 */
  const [workspaceItems, setWorkspaceItems] = useState([])
  /**
   * 等待用户改名的待建项目；null 表示没有。
   *
   * 只在目录名当不了项目名时出现（根目录取不出名字、目录名超过上限）：这时直接
   * 提交必然失败，而失败的出口是没有的——项目没建成，列表里就没有那一行，行上
   * 的「重命名」也不存在。给一个能改名的输入框，比让用户去终端重来强。
   */
  const [naming, setNaming] = useState(null)
  /** 拖拽排序的写入队列：连续拖动时一笔一笔地发，见 `reorderProject`。 */
  const [reorderQueue] = useState(() => createWriteQueue())

  const refresh = useCallback(async () => {
    // 通道还没挂好时不发请求：报错只会写一条看不懂的「通道不可用」，
    // 通道就绪后会自动补刷。
    if (!isProjectRemoteReady()) return
    try {
      const value = await callRemote('list', [])
      setProjects(Array.isArray(value) ? value : [])
      // 项目有变就广播：右栏「看板」入口按项目与会话身份画，注销项目或换 leader
      // 之后不通知，那里会留下一枚点开说「不属于任何项目」的胶囊。增删改的每个
      // 入口都在成功之后调本函数，广播放这里就不会漏。
      notifyProjectsChanged()
    } catch (error) {
      showToast(`读取项目失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [callRemote])

  /**
   * 重读项目下的会话归属。
   *
   * 归属判据在宿主侧——浏览器没有文件系统，做不了路径归一，这里只取结果。
   * @returns {Promise<void>} 完成
   */
  const refreshSessionIndex = useCallback(async () => {
    if (!isProjectRemoteReady()) return
    try {
      const value = await callRemote('sessionsByProject', [])
      const grouped = new Map()
      for (const entry of Array.isArray(value) ? value : []) {
        if (typeof entry?.projectId !== 'string') continue
        grouped.set(entry.projectId, Array.isArray(entry.sessionIds) ? entry.sessionIds : [])
      }
      setSessionsByProject(grouped)
    } catch (error) {
      showToast(`读取项目会话失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [callRemote])

  useEffect(() => {
    void refresh()
    void refreshSessionIndex()
    // 窗口重新获得焦点时刷新：项目也可能在另一个窗口里被增删。
    const onFocus = () => { void refresh(); void refreshSessionIndex() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh, refreshSessionIndex])

  // 通道挂好后补刷一次：挂载前那一次必然失败。挂载失败也要重渲染，错误原因
  // 才出现在界面上。
  const [, setChannelTick] = useState(0)
  useEffect(() => onProjectRemoteReady(() => {
    setChannelTick((tick) => tick + 1)
    void refresh()
    void refreshSessionIndex()
  }), [refresh, refreshSessionIndex])

  // 订阅会话列表：标题与运行状态随会话变化，归属也会因新会话而变。
  useEffect(() => {
    const sessions = getSessions?.()
    if (sessions?.list?.subscribe === undefined) return undefined
    let pending = null
    /** 上一次同步时的当前会话；切换它要跳过防抖，见下。 */
    let lastCurrent
    let primed = false
    const sync = () => {
      const snapshot = sessions.list.getSnapshot()
      const rows = {}
      for (const [id, row] of Object.entries(snapshot.byId ?? {})) {
        rows[id] = {
          id,
          title: row.title,
          displayTitle: row.displayTitle,
          running: row.running,
          origin: row.origin,
        }
      }
      setSessionRows(rows)
      const nextCurrent = currentSessionIdOf(snapshot.byId)
      setCurrentSessionId(nextCurrent)
      // 打开刚派工的 worker 时，归属表里可能还没有它：等防抖意味着先渲染一帧
      // 「哪个项目都不亮」，项目行要晚一秒才亮。切会话这一次值一次远程调用。
      const switched = primed && nextCurrent !== undefined && nextCurrent !== lastCurrent
      primed = true
      lastCurrent = nextCurrent
      if (switched) {
        if (pending !== null) {
          clearTimeout(pending)
          pending = null
        }
        void refreshSessionIndex()
        return
      }
      // 归属重算要过宿主，合并到一次延迟刷新里，避免每条事件都打一次远程调用。
      if (pending !== null) clearTimeout(pending)
      pending = setTimeout(() => { pending = null; void refreshSessionIndex() }, 1000)
    }
    sync()
    const unsubscribe = sessions.list.subscribe(sync)
    return () => {
      unsubscribe()
      if (pending !== null) clearTimeout(pending)
    }
  }, [getSessions, refreshSessionIndex])

  // 订阅已归档集合：宿主的工作区快照是真源。归档是宿主的既有能力，别处（官方
  // 工作区树）归档的会话在这里也要一起消失，所以不靠本地记账。
  //
  // 工作区服务可能晚于本插件就绪，首帧取不到不代表以后取不到：挂不上订阅时等
  // 一次就绪通知再挂，否则归档后行不消失且毫无提示。
  useEffect(() => {
    let unsubscribe = null
    const attach = () => {
      // 服务已就绪时同步挂上，随后就绪通知还会来一次——这一条守卫就是为它。
      if (unsubscribe !== null) return
      const list = getWorkspaces?.()?.list
      if (list?.getSnapshot === undefined || list.subscribe === undefined) return
      const sync = () => {
        const snapshot = list.getSnapshot()
        setArchivedSessionIds(new Set(Array.isArray(snapshot?.archivedSessionIds)
          ? snapshot.archivedSessionIds
          : []))
        setWorkspaceItems(Array.isArray(snapshot?.items) ? snapshot.items : [])
      }
      sync()
      unsubscribe = list.subscribe(sync)
    }
    attach()
    const off = onWorkspacesReady?.(attach)
    return () => {
      off?.()
      unsubscribe?.()
    }
  }, [getWorkspaces, onWorkspacesReady])

  const excludedSessionIds = useMemo(
    () => collectExcludedSessionIds(projects, sessionsByProject),
    [projects, sessionsByProject],
  )

  // 项目的 leader 与 worker 会话都不在官方工作区树里重复出现：它们由项目区块呈现。
  // worker 是普通根会话（不是 subagent），官方树不会自己滤掉，只能按会话 id 排除。
  // 用户在项目目录里手动开的会话不属于项目，留在官方树里。
  //
  // 当前会话若就是被排除的那条，它所属的工作区在官方树里会点亮成「开着」的样子，
  // 而里面没有可见的会话行——这个点亮一并压掉。
  const quietWorkspaceId = quietWorkspaceOf(currentSessionId, excludedSessionIds, workspaceItems)
  // 项目工作区行照常显示：项目目录本身也是用户在官方树里看得见、能用的入口。
  useEffect(() => {
    const exclusion = createWorkspaceExclusion()
    exclusion.update({
      sessionIds: excludedSessionIds,
      quietWorkspaceIds: quietWorkspaceId === undefined ? [] : [quietWorkspaceId],
    })
    return () => exclusion.dispose()
  }, [excludedSessionIds, quietWorkspaceId])

  const startAdd = useCallback(async () => {
    if (busy) return
    // 重新点「加项目」就是放弃上一个待建项：上一次可能停在改名框上，留着它会让
    // 这次建完项目后还挂着一个指向别的目录的输入块。
    setNaming(null)
    const uiWorkspace = getUiWorkspace?.()
    if (uiWorkspace === undefined) {
      showToast('目录选择器不可用：当前宿主无法选择目录，请换用 web profile 后再试。')
      return
    }
    setBusy(true)
    try {
      const directory = await uiWorkspace.pickDirectory()
      if (typeof directory !== 'string' || directory === '') return
      // 名字默认取目录名：用户挑完目录就想看到项目建好，再让他填一遍名字、
      // 再点一次确认，都是多余的手续。名字要改随时用行上的「重命名」。
      const check = defaultProjectName(directory)
      if (!check.ok) {
        // 目录名当不了项目名，直接提交只会换回一条没有出口的报错——让用户在这里改。
        setNaming({ directory, name: check.name, error: check.error })
        return
      }
      await callRemote('create', [directory, check.name])
      await refresh()
      // 新项目行就是唯一回执，列表收着就等于没有回执——建完必须展开给它看。
      setListExpanded(true)
    } catch (error) {
      showToast(`建项目失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [busy, callRemote, getUiWorkspace, refresh])

  /**
   * 提交改名后的建项目请求。
   * @returns {Promise<void>} 完成
   */
  const confirmNaming = useCallback(async () => {
    if (busy || naming === null) return
    const check = validateProjectName(naming.name)
    if (!check.ok) {
      setNaming({ ...naming, error: check.error })
      return
    }
    setBusy(true)
    setNaming({ ...naming, error: '' })
    try {
      await callRemote('create', [naming.directory, naming.name.trim()])
      setNaming(null)
      await refresh()
      setListExpanded(true)
    } catch (error) {
      setNaming({ ...naming, error: `建项目失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setBusy(false)
    }
  }, [busy, callRemote, naming, refresh])

  const cancelNaming = useCallback(() => {
    setNaming(null)
  }, [])

  const onNamingChange = useCallback((value) => {
    setNaming((current) => (current === null ? null : { ...current, name: value, error: '' }))
  }, [])

  const openProject = useCallback(async (project) => {
    if (!isProjectOpenable(project)) {
      showToast(`项目「${project.name}」的 leader 会话已被删除，请换新 leader。`)
      return
    }
    const uiWorkspace = getUiWorkspace?.()
    if (uiWorkspace === undefined) {
      showToast('导航服务不可用：无法打开会话。')
      return
    }
    // 归属是为了分组：不归属就落「未分组」，而项目会话行被藏了，那里只剩空组头。
    // 打开前先确保它挂上（工作区被删过时这一步会重建并归位）。
    const result = await openLeaderSession({
      project,
      callRemote,
      openSession: (sessionId) => uiWorkspace.openSession(sessionId),
    })
    if (result.ok !== true) {
      showToast(result.message)
      return
    }
    if (result.recreated === true) {
      // 工作区被用户删过：这次打开重建了一个，并把会话挂回去。用户点的是项目行，
      // 不会注意左栏工作区树里多回一行，不提示的话会以为删除仍然生效。
      showToast(result.reconnected > 0
        ? `项目「${project.name}」的工作区已重建，${result.reconnected} 个会话已归位。`
        : `项目「${project.name}」的工作区已重建。`)
    }
    // 宿主可能刚注册了工作区：归属要同步回列表，否则删除时不知道它是插件注册
    // 的，工作区会被漏在宿主里。
    if (result.workspaceId !== project.workspaceId) {
      setProjects((current) => current.map((item) => (
        item.id === project.id ? { ...item, workspaceId: result.workspaceId } : item
      )))
    }
  }, [callRemote, getUiWorkspace])

  const renameProject = useCallback(async (project, name) => {
    if (busy) return
    // 行内提交已经用 planProjectRename 校验过，正常走不到这里；守住绕过行内的
    // 调用方。校验是「输入能改好」的问题，行内会就地显示原因，这里只做兜底。
    const check = validateProjectName(name)
    if (!check.ok) {
      showToast(check.error)
      return
    }
    setBusy(true)
    try {
      await callRemote('rename', [project.id, name])
      await refresh()
    } catch (error) {
      showToast(`改名失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [busy, callRemote, refresh])

  /**
   * 拖拽落地后调整项目顺序。
   *
   * 先按落点本地重排再发请求：远程往返几十毫秒，行停在原处再跳过去会看成「没
   * 拖动」。失败时用宿主快照兜回来——那才是真源，界面不该停在一个没存下的顺序上。
   *
   * 连续拖动走串行队列：两笔并发时服务端收到的先后不等于用户操作的先后，两次
   * `projects/list` 的响应也可能倒序到达。只有最后一笔做收尾刷新——早先那笔刷新
   * 回来会先把界面退到中间态，再被最后一笔的刷新跳回去。
   *
   * @param {string} projectId - 被拖动的项目 id
   * @param {string} beforeId - 落点项目 id；空串表示末尾
   * @returns {Promise<void>} 完成
   */
  const reorderProject = useCallback((projectId, beforeId) => {
    setProjects((current) => moveProjectBefore(current, projectId, beforeId))
    return reorderQueue.push(async (isLatest) => {
      try {
        await callRemote('reorder', [projectId, beforeId])
      } catch (error) {
        showToast(`调整项目顺序失败：${error instanceof Error ? error.message : String(error)}`)
      }
      // 成功时把宿主算出的顺序（leader 状态等派生字段也一并刷新）拉回来；失败时
      // 用同一份快照把本地乐观重排撤销掉。
      if (isLatest()) await refresh()
    })
  }, [callRemote, refresh, reorderQueue])

  const replaceLeader = useCallback(async (project) => {
    if (busy) return
    setBusy(true)
    try {
      await callRemote('replaceLeader', [project.id])
      await refresh()
    } catch (error) {
      showToast(`换新 leader 失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [busy, callRemote, refresh])

  const requestDelete = useCallback((project) => {
    setDeleteError('')
    setPendingDelete(project)
  }, [])

  const cancelDelete = useCallback(() => {
    setDeleteError('')
    setPendingDelete(null)
  }, [])

  const confirmDelete = useCallback(async () => {
    if (busy || pendingDelete === null) return
    const project = pendingDelete
    setBusy(true)
    try {
      const result = await callRemote('deleteProject', [project.id])
      const outcome = classifyDeletionResult(result)
      if (outcome === 'failed') {
        setDeleteError(result?.reason ?? '删除失败。')
        await refresh()
        return
      }
      setPendingDelete(null)
      // 项目已经不在了（别人先删了、或重复确认）：目标已达成，按幂等成功收尾。
      // 成功不留提示——项目行消失本身就是回执，只有工作区摘除失败才报。
      showToast(describeDeletionNotice(project, result))
      await refresh()
    } catch (error) {
      setDeleteError(`删除失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [busy, callRemote, pendingDelete, refresh])

  /**
   * 归档一个会话，并摘掉它留在卡片与派工登记表上的痕迹。
   *
   * 顺序是先归档后摘卡：归档被宿主拒绝（会话还在跑）时不该先动卡片——那会让
   * 「会话仍在列表里，卡上槽位却没了」这种半截状态出现。
   *
   * @param {string} sessionId - 会话 id
   * @param {object} [options] - 选项
   * @param {boolean} [options.stopActivity] - 停止正在执行的任务再归档
   * @returns {Promise<void>} 完成
   */
  const archiveSession = useCallback(async (sessionId, { stopActivity = false } = {}) => {
    const workspaces = getWorkspaces?.()
    if (workspaces?.archiveSession === undefined) {
      showToast('工作区服务不可用：无法归档会话。')
      return
    }
    setBusy(true)
    try {
      await workspaces.archiveSession(sessionId, stopActivity ? { stopActivity: true } : undefined)
      // 摘卡失败不该说成「归档失败」：归档已经生效，会话已从列表消失。
      try {
        await callRemote('detachSession', [sessionId])
      } catch (error) {
        showToast(`会话已归档，但摘卡失败：${error instanceof Error ? error.message : String(error)}`)
      }
      setPendingArchive(null)
      await refreshSessionIndex()
    } catch (error) {
      if (!stopActivity && isArchiveActiveRefusal(error)) {
        setArchiveError('')
        setPendingArchive({ sessionId })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      if (stopActivity) {
        setArchiveError(`停止并归档失败：${message}`)
        return
      }
      showToast(`归档会话失败：${message}`)
    } finally {
      setBusy(false)
    }
  }, [callRemote, getWorkspaces, refreshSessionIndex])

  const confirmArchive = useCallback(async () => {
    if (busy || pendingArchive === null) return
    await archiveSession(pendingArchive.sessionId, { stopActivity: true })
  }, [archiveSession, busy, pendingArchive])

  const cancelArchive = useCallback(() => {
    setArchiveError('')
    setPendingArchive(null)
  }, [])

  const body = createElement(ProjectSection, {
    projects,
    busy,
    // 通道状态是持续状态，不是一次性消息：放在列表位置，而不是弹一条会自己
    // 消失的提示。就绪后这里变空，列表照常出现。
    remoteStatus: isProjectRemoteReady() ? '' : `项目通道未就绪。${projectRemoteError()}`,
    onAdd: () => { void startAdd() },
    naming,
    onConfirmNaming: () => { void confirmNaming() },
    onCancelNaming: cancelNaming,
    onNamingChange,
    onOpen: openProject,
    onRename: (project, name) => { void renameProject(project, name) },
    onReplace: (project) => { void replaceLeader(project) },
    onRemove: requestDelete,
    onReorder: (projectId, beforeId) => { void reorderProject(projectId, beforeId) },
    sessionsByProject,
    sessionRows,
    expandedProjects,
    listExpanded,
    onToggleList: () => setListExpanded((value) => !value),
    onToggleExpand: (projectId) => setExpandedProjects((current) => {
      const next = new Set(current)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return next
    }),
    onOpenSession: (sessionId) => {
      const uiWorkspace = getUiWorkspace?.()
      if (uiWorkspace === undefined) {
        showToast('导航服务不可用：无法打开会话。')
        return
      }
      uiWorkspace.openSession(sessionId)
    },
    onArchiveSession: (sessionId) => { void archiveSession(sessionId) },
    archivedSessionIds,
    currentSessionId,
  })

  // 弹窗自己 portal 到 body，但必须挂在不会被浮层收起卸载的位置：窄栏下浮层
  // 收起时它的子树整个卸载，放在浮层里会让确认框跟着消失。
  const dialog = createElement(ConfirmDialog, {
    open: pendingDelete !== null,
    title: '删除项目',
    description: pendingDelete === null ? '' : describeProjectRemoval(pendingDelete),
    confirmLabel: '删除',
    cancelLabel: '取消',
    danger: true,
    busy,
    error: deleteError,
    onConfirm: () => { void confirmDelete() },
    onCancel: cancelDelete,
  })

  const archiveDialog = createElement(ConfirmDialog, {
    open: pendingArchive !== null,
    title: '会话还在执行',
    description: '这个会话正在跑。归档会先停掉它的任务，再从列表移除并摘掉卡片上绑定的槽位。会话记录保留。',
    confirmLabel: '停止并归档',
    cancelLabel: '取消',
    danger: true,
    busy,
    error: archiveError,
    onConfirm: () => { void confirmArchive() },
    onCancel: cancelArchive,
  })

  if (!wide) {
    // 窄导轨放不下列表：图标入口 + 浮层。图标取工作区同款，工作区在导轨里也是
    // 一列图标。
    return createElement(
      'div',
      { style: { position: 'relative' } },
      createElement(
        'button',
        {
          type: 'button',
          title: '项目',
          'aria-label': '项目',
          onClick: () => setFloating((value) => !value),
          style: {
            width: '100%',
            padding: '4px 0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: floating ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            background: floating ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
            border: 'none',
            borderRadius: 'var(--dsw-radius-sm)',
            cursor: 'pointer',
          },
        },
        productIcon('workspace-tree-outline'),
      ),
      floating
        ? createElement(
            'div',
            {
              style: {
                position: 'fixed',
                left: '60px',
                bottom: '56px',
                width: '240px',
                maxHeight: '60vh',
                overflowY: 'auto',
                padding: '8px',
                background: 'var(--dsw-specific-sidebar-fill)',
                border: '1px solid var(--dsw-alias-border-l4)',
                borderRadius: 'var(--dsw-radius-lg)',
                boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
                zIndex: 40,
              },
            },
            body,
          )
        : null,
      dialog,
      archiveDialog,
    )
  }

  return createElement(
    Fragment,
    null,
    createElement(SidebarPlacement, null, body),
    dialog,
    archiveDialog,
  )
}

/**
 * 找左栏根容器：向上找到第一个「直接子元素里有面板列表 nav」的祖先。
 *
 * 插槽 occupant 在宿主树里的层数随宿主版本变，固定层数会失配；「最近的、且直接
 * 含有 nav 的祖先」这个判据在宿主改版时自然落空，退回原位渲染。
 *
 * @param {Element} anchor - 锚点元素
 * @returns {Element | null} 左栏根容器
 */
function findSidebarRoot(anchor) {
  let node = anchor.parentElement
  while (node !== null) {
    if (node.querySelector(':scope > nav') !== null) return node
    node = node.parentElement
  }
  return null
}

/**
 * 把区块安到左栏的面板列表之下、工作区列表之上。
 *
 * 宿主左栏的正文区只有一个 `sidebar.workspaces` 槽（已被官方工作区浏览占用），
 * 第三方插件没有并列区块的注册位。宿主的面板列表是一个 `nav`，它的下一个兄弟
 * 元素就是工作区所在的滚动区——在两者之间插一个容器即可得到想要的位置。宿主
 * 改版导致找不到锚点时，内容退回原处渲染，功能不受影响。
 *
 * @param {object} props - 组件属性
 * @param {object} props.children - 区块内容
 * @returns {object} React 元素
 */
function SidebarPlacement(props) {
  const anchorRef = useRef(null)
  const [container, setContainer] = useState(null)

  useEffect(() => {
    const anchor = anchorRef.current
    if (anchor === null) return undefined
    const root = findSidebarRoot(anchor)
    if (root === null) return undefined
    const nav = root.querySelector(':scope > nav')
    if (nav === null) return undefined
    const host = document.createElement('div')
    host.setAttribute('data-dsh-leader-kit-projects', '')
    host.style.flex = 'none'
    nav.insertAdjacentElement('afterend', host)
    setContainer(host)
    return () => {
      host.remove()
      setContainer(null)
    }
  }, [])

  return createElement(
    'div',
    // 锚点自身不参与布局：内容移到宿主容器后，锚点只剩一个定位点；宿主结构变了
    // 导致没移成时，内容就落回这个锚点里，仍然可见。
    { ref: anchorRef, style: { display: 'contents' } },
    container === null ? props.children : createPortal(props.children, container),
  )
}
