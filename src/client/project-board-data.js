/**
 * 项目看板的数据通道：客户端读项目看板卡片。
 *
 * 看板是**项目**的看板：一个项目一个看板，跨会话聚合（leader 建的卡与 worker
 * 建的卡在同一处）。因此取数走宿主侧的项目通道，而不是会话事件流——
 *
 * - 事件流是会话维度的，一个项目下的卡片散在多个会话里，重放多个会话的事件
 *   窗口既慢又会漏（worker 会话被宿主回收后窗口就没了）；
 * - 卡片的真源本就在宿主的卡片库里，读它才是读事实。
 *
 * 卡片仍然随 `tool/result` 事件的 `meta` 投影进 session log（历史完整），但那
 * 是历史，不是看板的数据源。
 *
 * @module dsh-leader-agent/client/project-board-data
 */

/** 看板刷新间隔（毫秒）。 */
export const BOARD_REFRESH_MS = 2000

/**
 * 解析会话所属项目。
 *
 * @param {(method: string, args: unknown[]) => Promise<unknown>} callRemote - 远程调用
 * @param {string} sessionId - 会话 id
 * @returns {Promise<object | undefined>} 项目摘要；不归属任何项目时 undefined
 */
export async function resolveProject(callRemote, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const project = await callRemote('resolveProject', [sessionId])
  if (project === null || typeof project !== 'object') return undefined
  return project
}

/**
 * 这个会话是不是该项目的 leader。
 *
 * 项目归属按 cwd 判定，同一个项目目录里的普通会话与 worker 也会解析到项目；
 * 看板只给项目会话看（leader 与该项目派出的 worker），同目录的普通会话在项目里
 * 干活，但不拥有这个看板的呈现面。
 *
 * @param {object | undefined} project - 项目摘要（含 `leaderSessionId`）
 * @param {string} sessionId - 当前面板所属会话
 * @returns {boolean} 是否为该项目的 leader 会话
 */
export function isLeaderProject(project, sessionId) {
  const leader = project?.leaderSessionId
  return typeof leader === 'string' && leader !== '' && leader === sessionId
}

/**
 * 这个会话是不是该项目已经换下的 leader。
 *
 * 退役会话仍解析得到项目（历史留在项目下），也被并进 `sessionsByProject` 和
 * worker 同列，但它已经不是项目会话：换人之后它不再指挥这个项目，看板入口与
 * 面板都不该给它——那张表是「项目里有哪些会话」，不是「谁是 worker」。
 *
 * @param {object | undefined} project - 项目摘要（含 `retiredLeaderSessionIds`）
 * @param {string} sessionId - 当前面板所属会话
 * @returns {boolean} 是否为该项目的退役 leader
 */
export function isRetiredLeaderSession(project, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  const retired = project?.retiredLeaderSessionIds
  return Array.isArray(retired) && retired.includes(sessionId)
}

/**
 * 看板面板该显示什么。
 *
 * 把「归属、身份、leader 存活」三件事收敛成一个判定，面板的取卡条件与
 * 展示分支都读它，避免两处守卫各写一套。
 *
 * 看板属于**项目会话**：leader 与该项目派出的 worker 都能看，同一目录里的
 * 普通会话不能——它们在项目目录里干活，但不拥有这个项目的呈现面。
 *
 * - `no-project`：会话不属于任何项目；
 * - `pending`：项目在，但还没问出当前会话是不是 worker（身份未判定）；
 * - `leader-dead`：项目在，但绑定的 leader 会话已失效（归档或被替换）；
 * - `not-viewable`：项目里能解析到，但当前会话既不是 leader 也不是 worker
 *   （同目录的普通会话、已经换下的 leader）；
 * - `leader` / `worker`：当前会话是 leader 或该项目的 worker，可展示卡片。
 *
 * `leaderAlive` 为 `undefined`（不知道）时按「还在」处理，不误报失效。
 *
 * `isWorker` 传 `undefined` 表示「还没判定」：worker 身份要额外问一次宿主，
 * 未回来之前不能按普通会话下结论——那会让 worker 先闪一句「看板只在项目会话
 * 中打开」。判定出来之前走 `pending`，由调用方给骨架。
 *
 * @param {object | undefined} project - 项目摘要
 * @param {string} sessionId - 当前面板所属会话
 * @param {boolean | undefined} isWorker - 当前会话是否是该项目的 worker；`undefined` 表示未判定
 * @returns {'no-project' | 'pending' | 'leader-dead' | 'not-viewable' | 'leader' | 'worker'} 视图状态
 */
export function boardViewState(project, sessionId, isWorker) {
  if (project === undefined) return 'no-project'
  if (isLeaderProject(project, sessionId)) {
    return project.leaderAlive === false ? 'leader-dead' : 'leader'
  }
  // 退役身份来自项目摘要，不必等项目会话表问回来，也不看 isWorker 传了什么：
  // 它出现在项目的会话表里只是「历史留在项目下」，不是项目会话。
  if (isRetiredLeaderSession(project, sessionId)) return 'not-viewable'
  // 身份没问出来之前不下结论：每一步 await 之间都可能渲染一次。
  if (isWorker === undefined) return 'pending'
  // leader 失效时 worker 与同目录普通会话都归「失效出口」——面板对两者都给
  // 「去换新 leader」的引导（#19 的设计）；入口另按身份判，见 isBoardEntryVisible。
  if (project.leaderAlive === false) return 'leader-dead'
  return isWorker ? 'worker' : 'not-viewable'
}

/**
 * 这个会话当前能不能看项目看板。
 *
 * @param {object | undefined} project - 项目摘要
 * @param {string} sessionId - 当前面板所属会话
 * @param {boolean | undefined} isWorker - 当前会话是否是该项目的 worker；`undefined` 表示未判定，按不可看处理
 * @returns {boolean} 是否可展示看板
 */
export function isBoardViewable(project, sessionId, isWorker) {
  const view = boardViewState(project, sessionId, isWorker)
  return view === 'leader' || view === 'worker'
}

/**
 * 这个会话的右栏「看板」入口该不该出现。
 *
 * 入口跟着**身份**走，不跟面板的视图状态走：leader 与 worker 有，同目录的普通
 * 会话没有。leader 失效时项目会话的入口仍然保留——点开是「去左栏换新 leader」
 * 的引导，藏起来等于把出口一起藏掉；但普通会话在同一个「leader 失效」状态下
 * 也拿到入口，就是对不该看的会话撒谎（面板侧给它们失效引导是 #19 的有意设计，
 * 入口不该照抄那个出口）。
 *
 * 换下的 leader 按「没有」处理：它的历史还在项目下、也仍解析得到项目，但换人之
 * 后它不再指挥这个项目，看板不该跟着它走。
 *
 * @param {object | undefined} project - 项目摘要
 * @param {string} sessionId - 当前会话
 * @param {boolean | undefined} isWorker - 当前会话是否是该项目的 worker；`undefined` 表示未判定，不画
 * @returns {boolean} 是否显示入口
 */
export function isBoardEntryVisible(project, sessionId, isWorker) {
  if (project === undefined) return false
  if (isLeaderProject(project, sessionId)) return true
  if (isRetiredLeaderSession(project, sessionId)) return false
  return isWorker === true
}

/**
 * 解析当前会话对项目看板的访问权：所属项目 + 是不是该项目的 worker。
 *
 * 入口与面板共用这一个判定，口径只写一遍。worker 身份要另问一次宿主
 * （`sessionsByProject`）：leader 身份由项目摘要直接给出，其余会话只有登记表
 * 知道。worker 表取数失败按「不是 worker」处理（fail closed）——判错这一侧的
 * 代价是项目会话少看见板，比同目录的普通会话看见别人的看板小。
 *
 * 项目解析本身失败照常抛出：那是「有没有项目」都答不上来，调用方要自己决定是
 * 重试还是显示错误。
 *
 * @param {(method: string, args: unknown[]) => Promise<unknown>} callRemote - 远程调用
 * @param {string} sessionId - 当前会话
 * @returns {Promise<{ project: object | undefined, worker: boolean }>} 访问权
 */
export async function resolveBoardAccess(callRemote, sessionId) {
  const project = await resolveProject(callRemote, sessionId)
  if (project === undefined) return { project, worker: false }
  if (isLeaderProject(project, sessionId)) return { project, worker: false }
  // 退役会话与 worker 在同一个集合里（那张表列的是项目下的会话），身份要按
  // 项目摘要再分一次。
  if (isRetiredLeaderSession(project, sessionId)) return { project, worker: false }
  try {
    const sessions = await fetchProjectSessions(callRemote)
    return { project, worker: isProjectSession(project.id, sessionId, sessions) }
  } catch {
    // worker 表读不到时按「不是 worker」处理：入口与面板都不越权展示，下一轮
    // 复核或聚焦时会重问。
    return { project, worker: false }
  }
}

/**
 * 取每个项目下的会话。
 *
 * worker 是普通根会话，会话头里没有身份标记；谁是 worker 只有宿主侧的登记表
 * 知道。这张表列的是**项目下的会话**：worker，加上换下的 leader（历史留在
 * 项目下、和 worker 同列）。两者身份不同，worker 判定要再过一道
 * {@link isRetiredLeaderSession}。
 *
 * 走项目通道一次问全量，比按会话逐个问省往返。
 *
 * @param {(method: string, args: unknown[]) => Promise<unknown>} callRemote - 远程调用
 * @returns {Promise<Map<string, Set<string>>>} 项目 id 到会话 id
 */
export async function fetchProjectSessions(callRemote) {
  const groups = await callRemote('sessionsByProject', [])
  const table = new Map()
  if (!Array.isArray(groups)) return table
  for (const group of groups) {
    // 空项目 id 永远匹配不上任何项目，进表只会让人以为有归属。
    if (typeof group?.projectId !== 'string' || group.projectId === '' || !Array.isArray(group.sessionIds)) continue
    const ids = group.sessionIds.filter((id) => typeof id === 'string' && id !== '')
    table.set(group.projectId, new Set(ids))
  }
  return table
}

/**
 * 这个会话是不是列在某个项目下的会话。
 *
 * 只回答「属不属于这个项目的会话表」，不代表它是 worker——退役的 leader 也在表里。
 *
 * @param {string} projectId - 项目 id
 * @param {string} sessionId - 会话 id
 * @param {Map<string, Set<string>>} sessions - {@link fetchProjectSessions} 的结果
 * @returns {boolean} 是否列在该项目下
 */
export function isProjectSession(projectId, sessionId, sessions) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  const ids = sessions?.get?.(projectId)
  return ids instanceof Set && ids.has(sessionId)
}

/**
 * 两份项目摘要是否描述同一个可展示状态。
 *
 * 面板每 30 秒复核一次项目：内容没变时保持旧对象引用，否则卡片取数的
 * effect 会跟着重启轮询。名字、leader 或存活状态变了才算变化——项目重命名后
 * 看板空态与提示文案要跟着换。
 *
 * @param {object | undefined} left - 旧摘要
 * @param {object | undefined} right - 新摘要
 * @returns {boolean} 是否等价
 */
export function sameProjectSummary(left, right) {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  return left.id === right.id
    && left.name === right.name
    && left.leaderSessionId === right.leaderSessionId
    && left.leaderAlive === right.leaderAlive
}

/**
 * 取项目的看板卡片。
 *
 * @param {(method: string, args: unknown[]) => Promise<unknown>} callRemote - 远程调用
 * @param {string} projectId - 项目 id
 * @returns {Promise<object[]>} 卡片数组
 */
export async function fetchBoardCards(callRemote, projectId) {
  if (typeof projectId !== 'string' || projectId === '') return []
  const cards = await callRemote('boardCards', [projectId])
  return Array.isArray(cards) ? cards : []
}

/**
 * 取项目的槽位显示名字典。
 *
 * 显示名由项目 `SLOTS.md` 的 `label:` 声明，宿主解析后经远程通道下发。形状不对
 * 的条目逐条丢弃：标签是卡面装饰信息，脏数据不该让看板报错。
 *
 * @param {(method: string, args: unknown[]) => Promise<unknown>} callRemote - 远程调用
 * @param {string} projectId - 项目 id
 * @returns {Promise<Record<string, string>>} 槽位名到显示名
 */
export async function fetchSlotLabels(callRemote, projectId) {
  if (typeof projectId !== 'string' || projectId === '') return {}
  const labels = await callRemote('projectSlots', [projectId])
  if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) return {}
  /** @type {Record<string, string>} */
  const clean = {}
  for (const [name, label] of Object.entries(labels)) {
    if (typeof label === 'string' && label !== '') clean[name] = label
  }
  return clean
}

/**
 * 两组卡片的 id 集合差：后出现的前者没有的 id。
 *
 * 判据是**新增**而不是内容变化：改卡不该把看板弹出来，只有项目里多了一张卡
 * 才值得打断用户。
 *
 * @param {readonly object[]} previous - 上一轮的卡片
 * @param {readonly object[]} next - 这一轮的卡片
 * @returns {string[]} 新增的卡片 id
 */
export function newCardIds(previous, next) {
  const known = new Set()
  for (const card of previous) {
    if (typeof card?.id === 'string') known.add(card.id)
  }
  const added = []
  for (const card of next) {
    if (typeof card?.id !== 'string' || known.has(card.id)) continue
    known.add(card.id)
    added.push(card.id)
  }
  return added
}
