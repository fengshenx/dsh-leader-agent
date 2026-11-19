/**
 * 浏览器侧会话标签栏的纯逻辑。
 *
 * 标签是「按项目记住的导航快捷方式」，不是第二套会话列表：
 *
 * - 项目行本身是 leader 会话的入口，所以第一个标签就是项目名（leader 标签）；
 * - worker 标签只在用户点开过该 worker 之后出现，关掉只丢快捷方式，不动会话；
 * - 普通会话（不属于任何项目）没有标签栏。
 *
 * 这里只做数据推导，不碰 DOM、localStorage 和 React；持久化读写的容错在
 * `session-tabs.js`，规则本身由 `tests/session-tabs-logic.test.js` 钉住。
 *
 * @module dsh-leader-agent/client/session-tabs-logic
 */

/** localStorage 键。版本进键名：旧格式直接读不到，不需要迁移分支。 */
export const SESSION_TABS_STORAGE_KEY = 'dsh-leader-agent.session-tabs.v1'

/** 单个项目最多记住的 worker 标签数；localStorage 被手改成超大数组时兜底。 */
export const MAX_OPEN_TABS_PER_PROJECT = 50

/** 会话 id / 项目 id 的边界：非空、不过长、不含控制字符。 */
function validKey(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    // oxlint-disable-next-line no-control-regex -- 校验的正是控制字符本身
    && !/[\u0000-\u001f\u007f]/.test(value)
}

/**
 * 空标签库。
 * @returns {{version: 1, projects: Record<string, string[]>}} 空库
 */
export function emptyTabStore() {
  return { version: 1, projects: {} }
}

/** 取项目表；损坏的输入当空表，读路径不因为一个坏字段整块失效。 */
function projectsOf(store) {
  const projects = store?.projects
  if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) return {}
  return projects
}

/**
 * 把任意输入规范成标签库。
 *
 * 只认 `version === 1`：localStorage 可能被旧版本、手改或别的插件写过，形状
 * 不对时回空库，不让脏数据进入渲染链。id 去重并按上限截断。
 *
 * @param {unknown} value - 解析后的 JSON 值
 * @returns {{version: 1, projects: Record<string, string[]>}} 规范库
 */
function normalizeStore(value) {
  if (value === null || typeof value !== 'object' || value.version !== 1) return emptyTabStore()
  const entries = []
  for (const [projectId, ids] of Object.entries(projectsOf(value))) {
    if (!validKey(projectId) || !Array.isArray(ids)) continue
    const seen = new Set()
    for (const id of ids) {
      if (!validKey(id) || seen.has(id)) continue
      seen.add(id)
      if (seen.size >= MAX_OPEN_TABS_PER_PROJECT) break
    }
    if (seen.size > 0) entries.push([projectId, [...seen]])
  }
  return { version: 1, projects: Object.fromEntries(entries) }
}

/**
 * 读 localStorage 里的标签库。
 *
 * 坏 JSON 回空库：标签是增强信息，一条坏记录不该让整条栏消失。
 *
 * @param {string | null | undefined} raw - localStorage 原文
 * @returns {{version: 1, projects: Record<string, string[]>}} 规范库
 */
export function parseTabStore(raw) {
  if (typeof raw !== 'string' || raw === '') return emptyTabStore()
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    // 手改或半截写入：回空库比让标签栏崩掉合适。
    return emptyTabStore()
  }
  return normalizeStore(value)
}

/**
 * 序列化标签库。
 * @param {{version: 1, projects: Record<string, string[]>}} store - 标签库
 * @returns {string} JSON 文本
 */
export function serializeTabStore(store) {
  return JSON.stringify(normalizeStore(store))
}

/**
 * 某项目已打开的 worker 标签。
 * @param {{version: 1, projects: Record<string, string[]>}} store - 标签库
 * @param {string} projectId - 项目 id
 * @returns {string[]} 会话 id 列表（副本）
 */
export function openTabIds(store, projectId) {
  if (!validKey(projectId)) return []
  const ids = projectsOf(store)[projectId]
  if (!Array.isArray(ids)) return []
  return ids.filter((id) => validKey(id))
}

/**
 * 某项目是否已记住这个 worker 标签。
 * @param {{version: 1, projects: Record<string, string[]>}} store - 标签库
 * @param {string} projectId - 项目 id
 * @param {string} sessionId - 会话 id
 * @returns {boolean} 是否已打开
 */
export function hasOpenTab(store, projectId, sessionId) {
  return openTabIds(store, projectId).includes(sessionId)
}

/**
 * 记住一个 worker 标签。
 *
 * 已存在时返回原对象：React 的 `setState` 按引用判断，无变化的动作不该触发
 * 重渲染，也避免「打开当前 worker」的 effect 与渲染互相追着跑。
 *
 * @param {{version: 1, projects: Record<string, string[]>}} store - 标签库
 * @param {string} projectId - 项目 id
 * @param {string} sessionId - 会话 id
 * @returns {{version: 1, projects: Record<string, string[]>}} 新库或原库
 */
export function addOpenTab(store, projectId, sessionId) {
  if (!validKey(projectId) || !validKey(sessionId)) return store
  const current = openTabIds(store, projectId)
  if (current.includes(sessionId)) return store
  if (current.length >= MAX_OPEN_TABS_PER_PROJECT) return store
  return {
    version: 1,
    projects: { ...projectsOf(store), [projectId]: [...current, sessionId] },
  }
}

/**
 * 忘掉一个 worker 标签。
 *
 * 关标签只摘快捷方式：会话本身还在项目树里，重新点开就再记回来。
 *
 * @param {{version: 1, projects: Record<string, string[]>}} store - 标签库
 * @param {string} projectId - 项目 id
 * @param {string} sessionId - 会话 id
 * @returns {{version: 1, projects: Record<string, string[]>}} 新库或原库
 */
export function removeOpenTab(store, projectId, sessionId) {
  if (!validKey(projectId) || !validKey(sessionId)) return store
  const current = openTabIds(store, projectId)
  if (!current.includes(sessionId)) return store
  const next = current.filter((id) => id !== sessionId)
  const projects = { ...projectsOf(store) }
  if (next.length === 0) delete projects[projectId]
  else projects[projectId] = next
  return { version: 1, projects }
}

/**
 * worker 标签上的信号灯档位。
 *
 * 与项目树会话行同一口径：运行中盖过「完成未查看」，都没有就是空闲。宿主
 * 会话快照只给这两档；「等你输入」属于卡片信号，不在会话行上，标签栏不另
 * 造一套判定。
 *
 * @param {object | undefined} row - 会话行
 * @returns {'ongoing' | 'done' | 'idle'} StateDot 档位
 */
export function workerTabState(row) {
  if (row?.running === true) return 'ongoing'
  if (row?.completed === true) return 'done'
  return 'idle'
}

/**
 * 标签文字。
 *
 * 优先 `displayTitle`（宿主可能按内容改写过），退回 `title`，再退回 id：
 * 标签栏不能因为标题还没生成就出现空标签。
 *
 * @param {object | undefined} row - 会话行
 * @param {string} sessionId - 会话 id
 * @returns {string} 显示文字
 */
export function sessionLabel(row, sessionId) {
  const display = row?.displayTitle
  if (typeof display === 'string' && display !== '') return display
  const title = row?.title
  if (typeof title === 'string' && title !== '') return title
  return sessionId
}

/**
 * 当前会话属于哪个项目、是 leader 还是 worker。
 *
 * 只认项目摘要的 `leaderSessionId` 与登记表的 `sessionIds`：同一目录里用户
 * 手动开的普通会话不在登记表里，不能因为目录相同就给它标签栏。退役 leader
 * 在登记表里但不再是项目会话，按隐藏处理（看板同一口径）。
 *
 * @param {object[]} projects - 项目摘要
 * @param {object[]} groups - `sessionsByProject` 结果
 * @param {string} sessionId - 当前会话 id
 * @returns {{project: object, group: object | undefined, leader: boolean} | null} 归属
 */
function findProjectSession(projects, groups, sessionId) {
  if (!validKey(sessionId) || !Array.isArray(projects)) return null
  const leaderProject = projects.find((project) => (
    project !== null
    && typeof project === 'object'
    && project.leaderSessionId === sessionId
    && validKey(project.id)
  ))
  if (leaderProject !== undefined) {
    if (leaderProject.leaderAlive === false) return null
    const group = Array.isArray(groups)
      ? groups.find((entry) => entry?.projectId === leaderProject.id)
      : undefined
    return { project: leaderProject, group, leader: true }
  }
  if (!Array.isArray(groups)) return null
  const group = groups.find((entry) => (
    entry !== null
    && typeof entry === 'object'
    && Array.isArray(entry.sessionIds)
    && entry.sessionIds.includes(sessionId)
  ))
  if (group === undefined) return null
  const project = projects.find((entry) => entry?.id === group.projectId)
  if (project === undefined || !validKey(project.leaderSessionId)) return null
  if (project.leaderAlive === false) return null
  const retired = Array.isArray(project.retiredLeaderSessionIds)
    ? project.retiredLeaderSessionIds
    : []
  if (retired.includes(sessionId)) return null
  return { project, group, leader: false }
}

/** 标签栏的隐藏结果；每次新建对象，避免调用方改到共享常量。 */
function hiddenView(activeSessionId) {
  return {
    visible: false,
    project: null,
    leaderId: null,
    tabs: [],
    activeSessionId,
    isLeaderCurrent: false,
    isWorkerCurrent: false,
    workerIds: [],
  }
}

/**
 * 由项目、会话快照与标签库推导这一帧的标签栏。
 *
 * 只有项目会话显示标签栏，且项目里至少有一个 live worker——只有一个 leader
 * 的项目没有可切换的对象，一条只有项目名的栏只是占高度。worker 标签的顺序
 * 跟登记表（项目树里的会话行顺序），不按点开先后，重开也不会跳位。
 *
 * 当前 worker 已打开但标签库里还没有它时（刚点开的那一帧），标签先不画，
 * 由调用方在 effect 里补记；这里不把「当前会话」强塞进标签，否则关掉当前
 * 标签时会被同一帧重新加回来，关不掉。
 *
 * @param {object} input - 输入
 * @param {object[]} input.projects - 项目摘要
 * @param {object[]} input.groups - `sessionsByProject` 结果
 * @param {Record<string, object>} input.rows - 会话 id 到会话行
 * @param {string | undefined} input.currentSessionId - 主区域当前会话 id
 * @param {{version: 1, projects: Record<string, string[]>}} input.store - 标签库
 * @returns {object} 标签栏视图
 */
export function resolveTabView({ projects, groups, rows, currentSessionId, store }) {
  if (!validKey(currentSessionId)) return hiddenView(currentSessionId)
  const found = findProjectSession(projects, groups, currentSessionId)
  if (found === null) return hiddenView(currentSessionId)
  const { project, group, leader } = found
  const retired = new Set(Array.isArray(project.retiredLeaderSessionIds)
    ? project.retiredLeaderSessionIds
    : [])
  const groupIds = Array.isArray(group?.sessionIds) ? group.sessionIds : []
  const workerIds = []
  const seen = new Set()
  for (const id of groupIds) {
    if (!validKey(id) || seen.has(id) || id === project.leaderSessionId || retired.has(id)) continue
    seen.add(id)
    if (rows?.[id] === undefined) continue
    workerIds.push(id)
  }
  if (workerIds.length === 0) return hiddenView(currentSessionId)
  const open = new Set(openTabIds(store, project.id))
  const tabs = [
    {
      id: project.leaderSessionId,
      kind: 'leader',
      label: typeof project.name === 'string' && project.name !== '' ? project.name : project.id,
      state: 'idle',
    },
    ...workerIds
      .filter((id) => open.has(id))
      .map((id) => ({
        id,
        kind: 'worker',
        label: sessionLabel(rows[id], id),
        state: workerTabState(rows[id]),
      })),
  ]
  return {
    visible: true,
    project,
    leaderId: project.leaderSessionId,
    tabs,
    activeSessionId: currentSessionId,
    isLeaderCurrent: leader,
    isWorkerCurrent: !leader && workerIds.includes(currentSessionId),
    workerIds,
  }
}

/**
 * 方向键 / Home / End 在标签之间的落点。
 *
 * `role="tablist"` 的键盘约定：左右方向键在当前标签之间移动（到头循环），
 * Home / End 跳到首尾。其它键返回 `undefined`，由调用方决定是否处理。
 *
 * @param {Array<{ id: string }>} tabs - 当前标签
 * @param {string | undefined} activeId - 当前选中的标签 id
 * @param {string} key - 键盘事件的 key
 * @returns {string | undefined} 要聚焦并切换到的标签 id
 */
export function tabIdForKey(tabs, activeId, key) {
  if (!Array.isArray(tabs) || tabs.length === 0) return undefined
  const found = tabs.findIndex((tab) => tab?.id === activeId)
  // 当前会话不在标签里（刚点开的 worker 标签还没记上）时从第一个算起。
  const index = found === -1 ? 0 : found
  switch (key) {
    case 'ArrowRight':
      return tabs[(index + 1) % tabs.length]?.id
    case 'ArrowLeft':
      return tabs[(index - 1 + tabs.length) % tabs.length]?.id
    case 'Home':
      return tabs[0]?.id
    case 'End':
      return tabs[tabs.length - 1]?.id
    default:
      return undefined
  }
}

/**
 * 关掉某个标签后要切到哪个会话。
 *
 * 只有关的是当前标签才需要导航：切到项目标签（leader），关一个后台标签
 * 不该把用户从正在看的会话里拽走。
 *
 * @param {object} view - `resolveTabView` 的结果
 * @param {string} closingId - 被关掉的会话 id
 * @returns {string | null} 要打开的会话 id；不需要导航时 null
 */
export function tabAfterClose(view, closingId) {
  if (view?.visible !== true || typeof closingId !== 'string') return null
  if (view.activeSessionId !== closingId) return null
  return view.leaderId
}
