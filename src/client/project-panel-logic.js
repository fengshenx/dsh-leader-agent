/**
 * 左栏项目区块的纯逻辑。
 *
 * 浏览器侧没有 `node:path`，路径末段要自己取；两种分隔符都得认——宿主可能在
 * Windows 上把目录写成反斜杠形式。
 *
 * @module dsh-leader-kit/client/project-panel-logic
 */

import { MAX_PROJECT_NAME_LENGTH } from '../shared/projects.js'
import { isRetiredLeaderSession } from './project-board-data.js'

export { MAX_PROJECT_NAME_LENGTH }

/**
 * 取路径的末段名称。
 * @param {string} path - 目录路径
 * @returns {string} 末段名称
 */
export function basenameOf(path) {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

/**
 * 校验项目名。
 * @param {string} name - 候选项目名
 * @returns {{ ok: boolean, error: string }} 校验结果
 */
export function validateProjectName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: '项目名不能为空' }
  }
  if (name.trim().length > MAX_PROJECT_NAME_LENGTH) {
    return { ok: false, error: `项目名过长（上限 ${MAX_PROJECT_NAME_LENGTH} 字）` }
  }
  return { ok: true, error: '' }
}

/**
 * 行内重命名的提交判定。
 *
 * 校验失败时输入框要留在原地、原因就地显示：提示条五秒后就消失，用户再点
 * 「重命名」时既看不到失败原因，也丢了刚输入的名字。
 *
 * @param {string} currentName - 项目当前的名字
 * @param {string} nextName - 输入框里的名字
 * @returns {{ action: 'close' | 'keep' | 'commit', name?: string, error?: string }} 判定
 */
export function planProjectRename(currentName, nextName) {
  if (nextName === currentName) return { action: 'close' }
  const check = validateProjectName(nextName)
  if (!check.ok) return { action: 'keep', error: check.error }
  return { action: 'commit', name: nextName }
}

/**
 * 把目录末段当默认项目名，并判定它能不能直接用。
 *
 * 能用就直接建项目（用户挑完目录就看到建好的项目）；不能用就得让用户改名——
 * 直接提交只会换回一条没有出口的报错。
 *
 * @param {string} directory - 选中的目录
 * @returns {{ name: string, ok: boolean, error: string }} 默认名与判定
 */
export function defaultProjectName(directory) {
  const name = basenameOf(directory)
  const check = validateProjectName(name)
  return { name, ok: check.ok, error: check.error }
}

/**
 * 判定一个项目能否直接打开。
 *
 * leader 会话被删除后项目仍在注册表里，但点开没有去处——那种项目要提示换新
 * leader，而不是安静地不响应。
 *
 * @param {object} project - 项目记录
 * @returns {boolean} leader 会话是否可用
 */
export function isProjectOpenable(project) {
  if (typeof project?.leaderSessionId !== 'string' || project.leaderSessionId === '') {
    return false
  }
  return project.leaderAlive !== false
}

/**
 * 挑出项目下要列出的会话行。
 *
 * leader 不在其中——项目名就是它的入口，重复列出会让「点项目名打开 leader」这条
 * 路径变得含糊。已归档的会话也不列：归档是「从列表移除」这个动作的结果，宿主
 * 的会话索引按磁盘目录扫，归档后那条记录仍在索引里，不在这里滤掉就会原地复活。
 * 宿主侧暂时取不到的会话行（会话刚建、列表还没同步）直接略过。
 *
 * @param {object} options - 选项
 * @param {string[]} options.sessionIds - 该项目的会话 id 列表
 * @param {Record<string, object>} options.sessionRows - 会话 id 到会话行
 * @param {string | undefined} options.leaderSessionId - leader 会话 id
 * @param {Set<string>} [options.archivedSessionIds] - 已归档的会话 id
 * @returns {object[]} 要渲染的会话行
 */
export function selectProjectSessionRows({
  sessionIds,
  sessionRows,
  leaderSessionId,
  archivedSessionIds,
}) {
  const rows = []
  for (const sessionId of sessionIds ?? []) {
    if (sessionId === leaderSessionId) continue
    if (archivedSessionIds?.has(sessionId) === true) continue
    const row = sessionRows?.[sessionId]
    if (row === undefined) continue
    rows.push(row)
  }
  return rows
}

/**
 * 项目行行首要不要显示加载圈。
 *
 * 两个来源合成一个判定：本组任一会话行在跑（只在收起时算），以及 leader 自己在跑
 * （任何展开状态都算）。收起后会话行不可见，行首是唯一的活动提示；展开后每条
 * 会话行自己带 spinner，其它会话在跑就不再画第二遍——但它没有自己的行，leader
 * 跑起来只能靠行首。
 *
 * 会话行那一半读**要渲染的会话行**（{@link selectProjectSessionRows} 的结果），
 * 不另行判一遍身份与归属。这样「目录行有加载器」与「至少一条会话行有 spinner」
 * 严格同源：归档会话、快照里还没有的会话、以及不在会话列表里的当前 leader 都不
 * 参与，也不会因为换 leader 留下的退役会话而误判。
 *
 * @param {object} options - 选项
 * @param {boolean} options.expanded - 项目的会话列表是否展开
 * @param {object[]} options.rows - 要渲染的会话行
 * @param {boolean} [options.leaderRunning] - leader 是否在运行
 * @returns {boolean} 是否显示加载圈
 */
export function showsProjectActivity({ expanded, rows, leaderRunning }) {
  if (leaderRunning === true) return true
  if (expanded === true) return false
  return (Array.isArray(rows) ? rows : []).some((row) => row?.running === true)
}

/**
 * 挑出要从官方工作区树里排除的会话 id。
 *
 * 项目的 leader 与 worker 都由项目区块呈现，官方树里再来一份就是重复。worker 是
 * 普通根会话（不是 subagent），官方树不会自己滤掉，所以按 id 显式排除。
 *
 * @param {object[]} projects - 项目记录
 * @param {Map<string, string[]>} sessionsByProject - 项目 id 到 worker 会话 id
 * @returns {Set<string>} 要排除的会话 id
 */
export function collectExcludedSessionIds(projects, sessionsByProject) {
  const excluded = new Set()
  for (const project of projects ?? []) {
    if (typeof project?.leaderSessionId === 'string' && project.leaderSessionId !== '') {
      excluded.add(project.leaderSessionId)
    }
  }
  for (const sessionIds of sessionsByProject?.values() ?? []) {
    for (const sessionId of sessionIds ?? []) excluded.add(sessionId)
  }
  return excluded
}

/**
 * 从会话快照里取主区域当前会话。
 *
 * 与宿主的 `mainSessionId`（`tree.ts`）同判据：`mainView` 持有数大于 0 的那条。
 * 宿主用它在官方树里高亮当前会话行、点亮它所在的工作区分组，另在右侧面板激活时
 * 把当前会话视作空（`panelActive`）——那一层属于宿主的视图 store，这里不跟。
 *
 * @param {Record<string, object> | undefined} byId - 会话快照（`sessions.list`）
 * @returns {string | undefined} 当前会话 id；主区域没有会话时 undefined
 */
export function currentSessionIdOf(byId) {
  for (const [id, row] of Object.entries(byId ?? {})) {
    if ((row?.retainedBy?.mainView ?? 0) > 0) return id
  }
  return undefined
}

/**
 * 判定项目行是否代表主区域里正在看的 leader 会话。
 *
 * leader 会话不在项目树下单独出行，项目行就是它的入口：点项目行打开 leader 之后
 * 主区域里放着那条会话，这一行必须跟着亮起来，否则「我现在在哪个项目里」只能
 * 靠会话标题猜。
 *
 * 只有 leader 算数：被打开的 worker 会话在列表里有自己的一行，选中态归它；项目
 * 行这时只点亮行首文件夹（`isProjectCurrent`）。两行同时铺整行底色会看成选了
 * 两个，而它们层级不同。
 *
 * 归档 leader 在项目树里没有可点的行，不算。
 *
 * @param {object} project - 项目记录
 * @param {string | undefined} currentSessionId - 主区域当前会话 id
 * @param {Set<string>} [archivedSessionIds] - 已归档的会话 id
 * @returns {boolean} 是否选中
 */
export function isLeaderCurrent(project, currentSessionId, archivedSessionIds) {
  if (typeof currentSessionId !== 'string' || currentSessionId === '') return false
  if (project?.leaderSessionId !== currentSessionId) return false
  return archivedSessionIds?.has(currentSessionId) !== true
}

/**
 * 判定项目的 leader 会话是否在运行。
 *
 * 会话行有自己的运行状态位，项目行没有——leader 在项目树下不单独出行，它跑起来
 * 时唯一能看出「还在干活」的位置就是项目行的行首图标。行首加载圈的另一半是
 * 会话行的运行态（{@link showsProjectActivity}），两者在 `ProjectRow` 里合成。
 *
 * 只认现任 leader：worker 在跑各自的行上有自己的加载圈。归档的 leader 不算——与
 * {@link isLeaderCurrent} / {@link isProjectCurrent} 同一条口径，宿主会话
 * 索引里还留着它的记录。
 *
 * @param {object} project - 项目记录
 * @param {Record<string, {running?: boolean}>} [sessionRows] - 会话 id 到会话行
 * @param {Set<string>} [archivedSessionIds] - 已归档的会话 id
 * @returns {boolean} leader 是否在运行
 */
export function isLeaderRunning(project, sessionRows, archivedSessionIds) {
  const id = project?.leaderSessionId
  if (typeof id !== 'string' || id === '') return false
  if (archivedSessionIds?.has(id) === true) return false
  return sessionRows?.[id]?.running === true
}

/**
 * 判定主区域里的当前会话是否属于这个项目（leader 或 worker）。
 *
 * 这一层不画整行底色——那是 leader 会话的选中态（`isLeaderCurrent`），只
 * 点亮行首文件夹：整行底色的语义是「你现在看的就是这一行」，而被打开的 worker
 * 是列表里的另一行。
 *
 * 口径与看板的「项目会话」判定一致（`boardViewState` 的 `leader` / `worker`）：
 * 退役 leader 仍解析得到项目、也仍列在 `sessionsByProject` 里，归档会话的行还留在
 * 会话索引里——但它们都不是项目会话。算进来的话，点开退役会话或归档会话时项目
 * 行也会亮，而点这一行去的是现任 leader：这个点亮承诺的「你正在看的就是这一组」
 * 就成了谎。
 *
 * @param {object} project - 项目记录
 * @param {string[]} sessionIds - 宿主判定的该项目会话 id（含退役 leader）
 * @param {string | undefined} currentSessionId - 主区域当前会话 id
 * @param {Set<string>} [archivedSessionIds] - 已归档的会话 id
 * @returns {boolean} 是否选中
 */
export function isProjectCurrent(project, sessionIds, currentSessionId, archivedSessionIds) {
  if (typeof currentSessionId !== 'string' || currentSessionId === '') return false
  if (archivedSessionIds?.has(currentSessionId) === true) return false
  if (project?.leaderSessionId === currentSessionId) return true
  if (isRetiredLeaderSession(project, currentSessionId)) return false
  return (sessionIds ?? []).includes(currentSessionId)
}

/**
 * 找出要压掉激活态的工作区。
 *
 * 官方把「当前会话所在分组」的目录图标点亮。当前会话若是被排除的会话（项目的
 * leader 或 worker），点亮的分组里看不到它——分组像是开着的，却找不到对应的
 * 会话行。这时把承载它的工作区压回普通色；当前会话不是排除集里的，就不动。
 *
 * @param {string | undefined} currentSessionId - 主区域当前会话 id
 * @param {Set<string>} excludedSessionIds - 从官方树里排除的会话 id
 * @param {{workspaceId: string, sessionIds: readonly string[]}[]} workspaces - 工作区视图
 * @returns {string | undefined} 要压灰的工作区 id；不需要时 undefined
 */
export function quietWorkspaceOf(currentSessionId, excludedSessionIds, workspaces) {
  if (typeof currentSessionId !== 'string') return undefined
  if (excludedSessionIds?.has(currentSessionId) !== true) return undefined
  const owner = (workspaces ?? []).find(
    (workspace) => (workspace?.sessionIds ?? []).includes(currentSessionId),
  )
  return typeof owner?.workspaceId === 'string' ? owner.workspaceId : undefined
}

/**
 * 判定归档失败是不是「会话还在跑」。
 *
 * 宿主对有心跳任务的会话默认拒绝归档（`workspace/session-active`），确认后才肯
 * 停掉任务再归档。其余失败（没有该会话、没有权限、通道断了）都不该问用户「要
 * 不要停」——那种提示只会把人引到一个同样失败的确认框。
 *
 * @param {unknown} reason - 宿主抛出的错误
 * @returns {boolean} 是否为「会话仍在执行」的拒绝
 */
export function isArchiveActiveRefusal(reason) {
  if (!(reason instanceof Error) || reason.name !== 'WorkspaceArchiveError') return false
  const code = reason.rpcError?.code
  return code === 'workspace/session-active'
}

/**
 * 打开项目的 leader 会话。
 *
 * 官方 UI 只能打开归属工作区的会话（宿主建会话时传 `cwd` 的话不归属任何工作
 * 区），因此先让宿主把 leader 会话挂到项目目录对应的工作区，挂不上就把原因报给
 * 用户，不静默失败。
 *
 * 挂上之后直接打开会话：leader 会话是空的，官方界面按空会话渲染，但插件会用
 * 一个会话视图目标把它顶进「输入框停靠底部」的对话形态（见 `leader-view.js`），
 * 不需要先跑一轮模型。
 *
 * `recreated` 表示宿主里已经没有这个项目的工作区（用户把它删了）——这次打开顺带
 * 重建了一个。用户点的是项目行，不会注意左栏工作区树里多回一行，所以要提示。
 *
 * @param {object} options - 选项
 * @param {object} options.project - 项目
 * @param {(method: string, args: unknown[]) => Promise<unknown>} options.callRemote - 调用宿主远程方法
 * @param {(sessionId: string) => void} options.openSession - 打开会话
 * @returns {Promise<{ok: boolean, message?: string, workspaceId?: string, recreated?: boolean,
 *   reconnected?: number}>} 打开结果
 */
export async function openLeaderSession({ project, callRemote, openSession }) {
  try {
    const result = await callRemote('attachLeader', [project.id])
    if (result?.attached !== true) {
      return { ok: false, message: result?.reason ?? 'leader 会话挂到工作区失败。' }
    }
    openSession(project.leaderSessionId)
    // 宿主可能刚为这个目录注册了工作区，把归属带回去给调用方更新列表。
    return {
      ok: true,
      workspaceId: result.workspaceId,
      recreated: result.recreated === true,
      reconnected: typeof result.reconnected === 'number' ? result.reconnected : 0,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `leader 会话挂到工作区失败：${message}` }
  }
}

/**
 * 构造项目行「更多」菜单的条目。
 *
 * 纯函数：菜单里只放行点击之外的动作——打开 leader 会话就是点项目行本身，不再
 * 重复一个入口。删除是唯一一个破坏性入口，永远出现——项目不管有没有插件注册
 * 的工作区都能删；工作区只在它是插件注册的（记在项目记录的 `workspaceId` 上）
 * 时才会被一并移除，复用的用户工作区不碰。
 *
 * @param {object} project - 项目
 * @param {{onRename: Function, onReplace: Function, onRemove: Function}} handlers - 各项的处理函数
 * @returns {object[]} 菜单条目
 */
export function buildProjectMenuItems(project, handlers) {
  const items = []
  items.push({ id: 'rename', label: '重命名', icon: 'edit-outline', onSelect: () => handlers.onRename(project) })
  items.push({ id: 'replace', label: '换新 Leader', icon: 'refresh-outline', onSelect: () => handlers.onReplace(project) })
  items.push({ id: 'remove', label: '删除', icon: 'trash-outline', danger: true, onSelect: () => handlers.onRemove(project) })
  return items
}

/**
 * 说清「删除」会发生什么。
 *
 * 删除 = 删项目记录 + 移除插件为它注册的工作区（宿主 `workspaceRegistry.delete`
 * 只删注册）。用户最担心的是「会话被删了」，这句必须把会话与文件夹都讲明白；
 * 没有插件工作区时不要提工作区——那会让用户以为自己的工作区也被删了。
 *
 * @param {object} project - 项目
 * @returns {string} 确认弹窗的说明文字
 */
export function describeProjectRemoval(project) {
  const hasWorkspace = typeof project.workspaceId === 'string' && project.workspaceId !== ''
  return hasWorkspace
    ? `将把项目「${project.name}」删除，并把它的工作区从 dsh 工作区列表移除。文件夹与会话记录都会保留，其会话将显示在“未分组”下。`
    : `将把项目「${project.name}」删除。文件夹与会话记录都会保留。`
}

/**
 * 删除成功后给哪一句提示。
 *
 * 成功固定一句回执，走 4 秒就消失的提示条——常驻才算噪音，一次性回执不是。
 * `notFound` 走幂等成功，回执一样：它的 `reason` 是「项目不存在」，不能拿来当
 * 工作区告警。
 *
 * 工作区真摘除失败要在回执后面带上原因：项目记录已经没了，用户再也看不到这个
 * 工作区属于谁，只能去官方面板手动删。
 *
 * @param {object} project - 被删的项目
 * @param {{notFound?: boolean, reason?: string}} result - 宿主返回的删除结果
 * @returns {string} 提示文字
 */
export function describeDeletionNotice(project, result) {
  const reason = result?.reason
  if (result?.notFound !== true && typeof reason === 'string' && reason !== '') {
    return `已删除项目「${project.name}」。工作区未移除：${reason}`
  }
  return `已删除项目「${project.name}」。`
}

/**
 * 判定删除请求该怎么收尾。
 *
 * 删除是幂等的：项目已经不在了（`notFound`）说明目标已经达成，不能报成失败——
 * 否则弹窗卡在「删除失败：项目不存在。」里出不来，行也不消失，用户只能取消再
 * 手动刷新。
 *
 * @param {{removed?: boolean, notFound?: boolean, reason?: string}} result - 宿主返回的删除结果
 * @returns {'removed' | 'alreadyGone' | 'failed'} 收尾方式
 */
export function classifyDeletionResult(result) {
  if (result?.removed === true) return 'removed'
  if (result?.notFound === true) return 'alreadyGone'
  return 'failed'
}

/**
 * 项目区块要渲染哪几块。
 *
 * 「项目通道未就绪」是持续状态，不跟列表折叠走：收起只是把项目行藏起来，通道
 * 坏着这件事仍然成立。列表内容（空态或项目行）与状态行互斥——通道没就绪时
 * 「还没有项目」会误导成「真的一个都没有」。
 *
 * @param {object} options - 选项
 * @param {string} options.remoteStatus - 通道状态文案；就绪时为空串
 * @param {boolean} options.listExpanded - 项目列表是否展开
 * @param {number} options.projectCount - 项目数
 * @returns {{ status: string, showList: boolean, showEmpty: boolean }} 渲染判定
 */
export function projectSectionLayout({ remoteStatus, listExpanded, projectCount }) {
  const status = typeof remoteStatus === 'string' ? remoteStatus : ''
  const list = listExpanded === true && status === ''
  return {
    status,
    showList: list && projectCount > 0,
    showEmpty: list && projectCount === 0,
  }
}

/**
 * 拖拽落点的锚点：把拖起来的项目插到哪一项之前。
 *
 * 判据与宿主工作区的拖拽一致：落在目标行上半插到它之前，下半插到它之后（也就是
 * 下一项之前），最后一行下半即末尾。空串代表末尾——远程协议里的 `beforeId` 是
 * 字符串，空串就是「没有下一项」。
 *
 * 顺序不会变的落点返回 null：拖回原处是常见动作，客户端不该为它发远程调用。
 *
 * @param {string[]} projectIds - 当前显示顺序
 * @param {string} activeId - 被拖起的项目 id
 * @param {string} overId - 悬停其上的项目 id
 * @param {'before' | 'after'} half - 落点在目标行的哪一半
 * @returns {string | null} 锚点项目 id（空串表示末尾）；null 表示顺序不变
 */
export function projectDropAnchor(projectIds, activeId, overId, half) {
  const ids = Array.isArray(projectIds) ? projectIds : []
  const from = ids.indexOf(activeId)
  const over = ids.indexOf(overId)
  // 落在自己身上一定不变：上半会得到「插到自己之前」，下半是「插到自己之后」。
  if (from === -1 || over === -1 || over === from) return null
  const anchor = half === 'after' ? (ids[over + 1] ?? '') : overId
  // 锚点是自己（插到自身之前）或紧邻的下一项（本来就排在那里）都等于没动。
  return anchor === activeId || ids[from + 1] === anchor ? null : anchor
}

/**
 * 一次拖拽悬停的完整判定：落到哪、以及要不要画插入线。
 *
 * 落在源行本身不画线：拖拽开始后指针从行上划过就会经过自己，线亮着而松手什么
 * 都不发生，看起来像上一次的落点没清掉。顺序本来就对但落点在别的行上时线照画
 * ——落点是真的，只是不发请求。
 *
 * @param {string[]} projectIds - 当前显示顺序
 * @param {string} activeId - 被拖起的项目 id
 * @param {string} overId - 悬停其上的项目 id
 * @param {'before' | 'after'} half - 落点在目标行的哪一半
 * @returns {{anchor: string | null, indicator: {id: string, half: 'before' | 'after'} | null}} 判定
 */
export function projectDropPlan(projectIds, activeId, overId, half) {
  const ids = Array.isArray(projectIds) ? projectIds : []
  if (ids.indexOf(overId) === -1) return { anchor: null, indicator: null }
  const side = half === 'after' ? 'after' : 'before'
  return {
    anchor: projectDropAnchor(ids, activeId, overId, side),
    indicator: overId === activeId ? null : { id: overId, half: side },
  }
}

/**
 * 连续写入的串行队列。
 *
 * 同一份真源上连续发起的写（如拖拽排序）并发发出时，服务端收到的先后不一定等于
 * 用户操作的先后，收尾刷新也可能倒序到达——界面最后停在哪一份快照上就成了碰运气。
 * 队列让每一笔等前一笔的请求与收尾都完成再发出，并把「我还是不是最后一笔」交给
 * 执行体：不是最后一笔就别再改界面，后一笔的收尾刷新才是最终顺序。
 *
 * 一笔失败不堵住队列（执行体自己负责报错），链条照常前进。
 *
 * @returns {{push: (task: (isLatest: () => boolean) => Promise<void>) => Promise<void>}} 队列
 */
export function createWriteQueue() {
  let tail = Promise.resolve()
  let issued = 0
  return {
    /**
     * 排一笔写入。
     * @param {(isLatest: () => boolean) => Promise<void>} task - 执行体
     * @returns {Promise<void>} 这一笔完成
     */
    push(task) {
      issued += 1
      const mine = issued
      const next = tail.then(() => task(() => mine === issued))
      tail = next.then(() => {}, () => {})
      return next
    },
  }
}

/**
 * 按锚点重排项目列表，供拖拽落地后的本地乐观更新。
 *
 * 与服务端的 `move` 同语义（DOM insertBefore + 空串表示末尾），锚点找不到时落到
 * 末尾。
 *
 * @param {object[]} projects - 项目列表
 * @param {string} activeId - 被拖动的项目 id
 * @param {string} anchorId - 锚点项目 id；空串表示末尾
 * @returns {object[]} 重排后的新列表
 */
export function moveProjectBefore(projects, activeId, anchorId) {
  const list = Array.isArray(projects) ? [...projects] : []
  const from = list.findIndex((item) => item?.id === activeId)
  if (from === -1) return list
  const [record] = list.splice(from, 1)
  const to = anchorId === '' ? -1 : list.findIndex((item) => item?.id === anchorId)
  list.splice(to === -1 ? list.length : to, 0, record)
  return list
}
