/**
 * 项目服务：项目实体的领域操作。
 *
 * 服务层的核心语义：
 *
 * - **建项目 = 建实体 + 建 leader 会话 + 绑定**，三步一体。leader 会话在项目目录里
 *   运行（`SessionHeader.cwd` 创建时定死），项目与会话之间是显式指针，不是「目录里
 *   最新的那个会话」这类软约定。
 * - **项目不碰 dsh 工作区**：工作区管代码语境，项目管编排语境，两者互不挂接。项目
 *   会话建出来就只带 `cwd`，不建工作区、不归属工作区、也不在删项目时动用户的工作区。
 * - **失败整体回滚**：leader 会话建不出来时项目不落盘；项目落盘失败时尽力撤销刚建
 *   的会话，不留半条记录。
 * - **目录不可改**：项目目录是身份的一部分，改目录等于换项目。
 *
 * @module dsh-leader-kit/host/projects/service
 */

import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { agentPresetOptions } from '../agent-preset.js'
import { createCanonicalizer, groupSessionsByProject } from './session-index.js'
import { MAX_PROJECT_NAME_LENGTH } from '../../shared/projects.js'

/** 目录归一器在进程内共享：会话头里的 cwd 高度重复，重复 realpath 纯属浪费。 */
const canonicalize = createCanonicalizer(realpath)

/**
 * 校验项目目录。
 * @param {string} directory - 候选目录
 * @returns {Promise<string>} 归一化后的绝对路径
 */
export async function assertUsableDirectory(directory) {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new Error('项目目录不能为空')
  }
  const raw = directory.trim()
  if (!isAbsolute(raw)) {
    throw new Error(`项目目录必须是绝对路径：${raw}`)
  }
  const normalized = resolve(raw)
  let info
  try {
    info = await stat(normalized)
  } catch {
    throw new Error(`项目目录不存在或不可访问：${normalized}`)
  }
  if (!info.isDirectory()) {
    throw new Error(`项目目录不是目录：${normalized}`)
  }
  if (normalized === resolve(normalized, '..')) {
    throw new Error('项目目录不能是文件系统根目录')
  }
  return normalized
}

/**
 * 校验项目名。
 * @param {string} name - 候选名
 * @returns {string} 去掉首尾空白的项目名
 */
export function assertUsableName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('项目名不能为空')
  }
  const trimmed = name.trim()
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) {
    throw new Error(`项目名过长（上限 ${MAX_PROJECT_NAME_LENGTH} 字）`)
  }
  return trimmed
}

/**
 * 创建项目服务。
 *
 * @param {object} options - 选项
 * @param {object} options.store - 项目注册表存储
 * @param {object} options.ctx - Cordis 上下文
 * @param {(directory: string, sessionId: string) => Promise<string>} [options.createLeaderSession] - 建 leader 会话。
 *   必须使用传入的 `sessionId`：leader 身份在建会话之前就登记了，换成别的 id 会让工具面裁成普通会话
 * @param {(sessionId: string) => Promise<boolean | undefined>} [options.sessionExists] - 判断会话是否仍存在
 * @param {(sessionId: string) => boolean} options.isWorkerSession - worker 会话判定。
 *   会话头看不出身份（worker 是普通根会话），列项目的会话树只能按登记表判。
 * @param {(change: { projectId: string }) => Promise<void>} [options.onLeaderReplaced] -
 *   换 leader 成功后的接管动作（派工归属与未投递通知改投新会话）。参数只给项目 id：
 *   接管要按**当前落盘记录**算退役集与接手方，两次并发换人不至于各按自己那次写。
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {object} 项目服务接口
 */
export function createProjectService({
  store,
  ctx,
  createLeaderSession,
  sessionExists,
  isWorkerSession,
  onLeaderReplaced,
  logger = () => {},
}) {
  if (typeof isWorkerSession !== 'function') {
    throw new Error('dsh-leader-kit: createProjectService 缺少 isWorkerSession，无法判定哪些会话属于项目')
  }
  const openLeaderSession = createLeaderSession
    ?? ((directory, sessionId) => createLeaderSessionWithCtx(ctx, directory, sessionId))
  const leaderExists = sessionExists
    ?? ((sessionId) => sessionExistsWithCtx(ctx, sessionId))

  /**
   * leader 会话 id → 项目的内存镜像（值是 `{ directory }`，项目记录落盘后再补
   * `projectId`）。
   *
   * 项目注册表是异步落盘的，而提示词组装与派工都需要**同步**拿到「这个会话属于
   * 哪个项目」。卡片库用的是同一手法：落盘是真源，内存镜像是读路径。
   *
   * 建项目期间会有只有 `directory` 的占位条目——身份登记早于会话创建（见
   * `openRegisteredLeaderSession`），读 `projectId` 的地方必须容忍它缺席。
   */
  const leaderIndex = new Map()

  /**
   * 项目目录 canonical 路径 → 项目 id 的内存镜像。
   *
   * 项目目录建好后不再变（目录是身份的一部分），canonical 路径算一次就够：
   * 判断会话归属时每次都要 realpath，重复算纯属浪费。反向索引（目录找项目）
   * 是「会话按 cwd 归属项目」这条判据的读路径。canonical 化本身由共享的
   * 归一器缓存（`createCanonicalizer`），这里不再重复缓存一份。
   */
  const canonicalDirectoryIndex = new Map()

  /**
   * 索引重建的 promise。
   *
   * 卡片归属要等索引就绪才能判：启动瞬间（`loadIndex()` 还没把项目读回内存）
   * 就建卡的话，卡片会静悄悄地归不到任何项目——那既丢数据又查不出原因。
   * 判定前先等这个 promise。
   */
  let indexReady = Promise.resolve()

  /**
   * 索引是否已从注册表重建完成。
   *
   * 重建前内存镜像是空的，「这个会话是不是 leader」问不出真话；工具面分配要
   * 同步拿到答案，等不了 promise，只能靠这个标志区分「没有 leader」与「还不知道」。
   */
  let indexLoaded = false

  // 目录归一器在进程内共享：会话头里的 cwd 高度重复，重复 realpath 纯属浪费。

  /**
   * 撤销一个刚建成的 leader 会话。
   *
   * dsh 没有「删除会话」的公开能力（`sessionController` 只提供创建与导航），因此
   * 这里只能尽力把 agent 停掉；残留的会话记录会落在左栏的「未分组」桶里，不影响
   * 项目数据。撤销失败必须记日志，不能静默吞掉。
   *
   * @param {string} sessionId - 会话 id
   * @returns {Promise<void>} 撤销完成
   */
  async function abandonLeaderSession(sessionId) {
    try {
      const agent = ctx.get('agents')?.get?.(sessionId)
      await agent?.dispose?.()
    } catch (error) {
      logger(
        `dsh-leader-kit: 撤销 leader 会话 ${sessionId} 失败：`
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * 建一个 leader 会话，并且在它被建出来之前就把身份登记进索引。
   *
   * 工具面在 `agent/created` 里按 `isLeaderSession()` 当场裁，而那个事件在
   * 建会话内部就发出来了。先建会话、后登记的话，leader 出生的那一刻注册表里还没
   * 有它，于是被裁成普通会话——`spawn_worker` / `message_worker` / `list_cards`
   * 全没。裁错的限制不会自己松开，要等这个会话下次冷恢复重算。
   *
   * 所以 id 由这里预生成、先登记，再让宿主用它建会话。两条建会话路径都接受传入
   * 的 id（`sessionController.create({ sessionId })` 与 `agents.create({ sessionId })`）。
   *
   * 登记时只写 `directory`：`projectId` 要等项目记录落盘才有，调用方补。
   *
   * @param {string} directory - 项目目录绝对路径
   * @returns {Promise<string>} 建成的会话 id
   * @throws {Error} 建会话失败，或建成后的 id 与预定的不同
   */
  async function openRegisteredLeaderSession(directory) {
    const sessionId = `session-${randomUUID()}`
    leaderIndex.set(sessionId, { directory })
    let created
    try {
      created = await openLeaderSession(directory, sessionId)
    } catch (error) {
      leaderIndex.delete(sessionId)
      throw error
    }
    if (created !== sessionId) {
      // 建会话的实现没按契约用传入的 id：占位登记在错的键上，工具面也已经裁错了
      // 一轮。这个契约由我们自己的 createLeaderSessionWithCtx 保证，破了说明
      // 宿主换了行为，必须当场停下而不是留一个工具面残缺的 leader。
      leaderIndex.delete(sessionId)
      await abandonLeaderSession(created)
      throw new Error(`leader 会话建成了 ${created}，预定的是 ${sessionId}：建会话的实现必须使用传入的 id`)
    }
    return sessionId
  }

  /**
   * leader 会话是否已被归档。
   *
   * 归档只往工作区注册表的归档集合里加 id，不删会话记录；只看会话是否存在会把
   * 归档的 leader 当成还活着。
   *
   * @param {string} sessionId - 会话 id
   * @returns {boolean} 已归档时 true
   */
  function isArchived(sessionId) {
    const archived = ctx.get('workspaceRegistry')?.archivedSessionIds
    return Array.isArray(archived) && archived.includes(sessionId)
  }

  /**
   * leader 会话是否还在。
   *
   * 存活 = 会话记录存在且未被归档。`undefined` 表示宿主没有会话查询后端（不知道），
   * 调用方按「还在」处理，不把未知误报成失效。
   *
   * @param {string} sessionId - 会话 id
   * @returns {Promise<boolean | undefined>} 是否还在
   */
  async function leaderAliveOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    const exists = await leaderExists(sessionId)
    if (exists === undefined) return undefined
    if (!exists) return false
    return !isArchived(sessionId)
  }

  /**
   * 项目摘要：客户端拿它判定看板可见性，以及 leader 会话是否还在。
   *
   * `retiredLeaderSessionIds` 要带出来：这些会话现在和 worker 一起列在
   * `sessionsByProject` 里，但身份不同——它们已经被换下，不再是项目会话
   * （看板入口与派工都不该给它们）。
   *
   * @param {object} project - 项目记录
   * @returns {Promise<object>} 项目摘要
   */
  async function summarizeProject(project) {
    return {
      id: project.id,
      name: project.name,
      directory: project.directory,
      leaderSessionId: project.leaderSessionId ?? '',
      leaderAlive: await leaderAliveOf(project.leaderSessionId),
      retiredLeaderSessionIds: Array.isArray(project.retiredLeaderSessionIds)
        ? [...project.retiredLeaderSessionIds]
        : [],
    }
  }

  /**
   * 让 leader 索引与当前的落盘记录对齐。
   *
   * 判据是**重新读出来的记录**，不是那次 `store.update` 的返回值：返回值是「这一次
   * 写下的状态」，两次并发换 leader 时有两次写入，按各自的返回值对齐就等于认定
   * 「后完成的那次同步一定对」——那只在「两次 update 的续体按写入顺序兑现」时成立，
   * 是把正确性押在微任务顺序上。落选的那次同步晚到一步，就会把已被退役的会话重新
   * 写成 leader，落盘的 leader 和索引对不上。重读记录则每次同步都朝最新值收敛，与
   * 完成顺序无关。
   *
   * @param {string} id - 项目 id
   * @returns {Promise<void>} 索引已对齐
   */
  async function syncLeaderIndex(id) {
    const project = await store.get(id)
    // 项目在并发里被删掉了：没有 leader 可登记，索引项由 remove() 清。
    if (project === undefined) return
    for (const sessionId of Array.isArray(project.retiredLeaderSessionIds)
      ? project.retiredLeaderSessionIds
      : []) {
      leaderIndex.delete(sessionId)
    }
    if (typeof project.leaderSessionId === 'string' && project.leaderSessionId !== '') {
      leaderIndex.set(project.leaderSessionId, {
        projectId: project.id,
        directory: project.directory,
      })
    }
  }

  return {
    /**
     * 重建 leader 索引。进程启动时调用：内存镜像是进程内的，崩溃后不会留下。
     * @returns {Promise<Map<string, string>>} 重建后的索引
     */
    async loadIndex() {
      const rebuilding = (async () => {
        const projects = await store.list()
        leaderIndex.clear()
        canonicalDirectoryIndex.clear()
        for (const project of projects) {
          if (typeof project.leaderSessionId === 'string' && project.leaderSessionId !== '') {
            leaderIndex.set(project.leaderSessionId, {
              projectId: project.id,
              directory: project.directory,
            })
          }
          const canonical = await canonicalize(project.directory)
          // 两个项目指向同一目录时先注册的那个保留归属，与项目会话归组同一口径：
          // 重叠是用户的误操作，不该让后注册的项目悄悄接管前者的卡片。
          if (!canonicalDirectoryIndex.has(canonical)) {
            canonicalDirectoryIndex.set(canonical, project.id)
          }
        }
        return leaderIndex
      })()
      // 重建成功才算就绪：失败时索引仍是空的，`isLeaderSession()` 继续走
      // 保守放行，而不是把 leader 的工具面判没。失败事实仍由返回值传播给调用方。
      indexReady = rebuilding.then(
        () => {
          indexLoaded = true
        },
        () => undefined,
      )
      return rebuilding
    },

    /**
     * 等 leader 索引就绪，并报告它到底有没有读出来。
     *
     * `isLeaderSession()` 在索引未就绪时一律放行——那是为了保证 leader 首轮
     * 不至于没有工具，但放行意味着**任何**会话都拿到编排工具。派工这类高危操作
     * 不能建立在这个宽松判定上：执行前等一次重建结果，读不出来就拒绝。
     *
     * @returns {Promise<boolean>} 索引是否可用
     */
    async awaitIndex() {
      await indexReady
      return indexLoaded
    },

    /**
     * 同步判定某个会话是不是项目 leader。
     *
     * leader 身份在建项目时就写进注册表（`leaderSessionId`），工具面据此
     * 分配——不必等会话跑起来再从会话内容里推断。
     *
     * 索引重建完成前一律返回 true：那时注册表还没读回内存，返回 false 会让
     * leader 首轮看不到编排工具，活直接干不成。这个宽松只对读类工具安全——派工
     * 走 `awaitIndex()` 再判一次，不能靠这里兜。
     *
     * @param {string} sessionId - 会话 id
     * @returns {boolean} 是否项目 leader
     */
    isLeaderSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      if (!indexLoaded) return true
      return leaderIndex.has(sessionId)
    },

    /**
     * 同步取某个 leader 会话所属的项目目录。
     * @param {string} sessionId - 会话 id
     * @returns {string | undefined} 项目目录；该会话不是 leader 时 undefined
     */
    directoryOfLeader(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      return leaderIndex.get(sessionId)?.directory
    },

    /**
     * 解析某个会话所属的项目。
     *
     * 判据两条，先命中先用：
     *
     * - **leader 会话** → 项目注册表里的那条指针（`leaderSessionId`）；
     * - **其它会话** → 会话 cwd 的 canonical 路径与项目目录的 canonical 路径相等。
     *   worker 会话的 cwd 就是项目目录，用户在项目目录里手动开的会话也是——它们
     *   做的都是这个项目的事。
     *
     * 会话 cwd 从宿主的会话注册表读（`sessions.get(id).header.cwd`）。读不到就
     * 明确说「不归属任何项目」，不猜：把卡挂到猜出来的项目上，比不挂更难查。
     *
     * @param {string} sessionId - 会话 id
     * @returns {Promise<object | undefined>} 所属项目（`{ id, name, directory,
     *   leaderSessionId, leaderAlive, retiredLeaderSessionIds }`）；
     *   不归属时 undefined
     */
    async resolveProjectOfSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      // 索引是进程内的镜像，启动时异步重建。重建完成前判定归属会得到「不归属
      // 任何项目」，卡片就会静悄悄地丢归属——等索引就绪再判。
      await indexReady
      const leader = leaderIndex.get(sessionId)
      // 建项目期间索引里先只有 directory 占位（登记早于会话创建，见
      // openRegisteredLeaderSession），那时 projectId 还没有值。
      if (leader?.projectId !== undefined) {
        const project = await store.get(leader.projectId)
        if (project !== undefined) return summarizeProject(project)
      }
      const cwd = ctx.get('sessions')?.get?.(sessionId)?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') return undefined
      const projectId = canonicalDirectoryIndex.get(await canonicalize(cwd))
      if (projectId === undefined) return undefined
      const project = await store.get(projectId)
      if (project === undefined) return undefined
      // 项目里的普通会话与 worker 也能解析到项目（卡片归属要用），但看板只对
      // 项目会话开放——客户端拿这条指针与 worker 表判断。
      return summarizeProject(project)
    },

    /**
     * 建项目：建实体 + 建 leader 会话 + 绑定。
     *
     * @param {object} input - 建项输入
     * @param {string} input.directory - 项目目录绝对路径
     * @param {string} [input.name] - 项目名，缺省用目录末段
     * @returns {Promise<object>} 建成的项目
     */
    async create({ directory, name }) {
      const normalizedDirectory = await assertUsableDirectory(directory)
      const fallbackName = normalizedDirectory.split(/[\\/]/).pop() ?? normalizedDirectory
      const displayName = assertUsableName(name ?? fallbackName)

      // 先建会话再建记录：会话建不出来时项目不落盘，失败路径没有半条记录。
      const leaderSessionId = await openRegisteredLeaderSession(normalizedDirectory)
      const draft = store.draft({
        name: displayName,
        directory: normalizedDirectory,
        leaderSessionId,
      })
      // 只包 `insert`：它成功之后再撤会话，就成了「记录已写、东西没了」的半回滚。
      let inserted
      try {
        inserted = await store.insert(draft)
      } catch (error) {
        leaderIndex.delete(leaderSessionId)
        await abandonLeaderSession(leaderSessionId)
        throw error
      }
      leaderIndex.set(leaderSessionId, {
        projectId: inserted.id,
        directory: normalizedDirectory,
      })
      const canonical = await canonicalize(normalizedDirectory)
      if (!canonicalDirectoryIndex.has(canonical)) {
        canonicalDirectoryIndex.set(canonical, inserted.id)
      }
      return inserted
    },

    /**
     * 列项目，并标注 leader 会话是否仍在。
     *
     * @returns {Promise<object[]>} 项目列表
     */
    async list() {
      const projects = await store.list()
      return Promise.all(projects.map(async (project) => ({
        ...project,
        leaderAlive: await leaderAliveOf(project.leaderSessionId),
      })))
    },

    /**
     * 把项目会话从宿主的 dsh 工作区里摘掉。
     *
     * 旧版本把 leader 与 worker 挂进项目目录对应的工作区，图的是官方树里的分组；
     * 代价是宿主把「工作区里第一个空白会话」当作可复用的新建草稿
     * （`ui-workspace` 的 `createInWorkspace`），而 leader 恰好一直空着——用户在
     * 工作区里新建会话会打开 leader 本身。项目与会话不再使用工作区之后，这里把
     * 历史挂载一次性摘掉：`detachSession` 幂等，重跑是空操作。
     *
     * 不遍历工作区的 `sessionIds`：那个 getter 只列已进会话 cwd 索引的会话，刚重启
     * 时可能还没索引到——偏偏要摘的就是这类历史记录。直接对每个已知的项目会话调
     * `detachSession`，包含与否由宿主在工作区写入链里判。
     *
     * 只摘项目自己的会话（现任/退役 leader 与登记过的 worker），用户在项目目录里
     * 手动开的会话不碰。
     *
     * @param {object} [options] - 选项
     * @param {Iterable<string>} [options.workerIds] - 登记的 worker 会话 id
     * @param {object} [options.registry] - 工作区注册表；插件装配早期还取不到服务，由调用方传入
     * @returns {Promise<number>} 摘掉的会话数
     */
    async detachFromWorkspaces({
      workerIds = [],
      registry = ctx.get('workspaceRegistry'),
    } = {}) {
      if (registry === undefined || typeof registry.list !== 'function') return 0
      const projects = await store.list()
      const targets = new Set(workerIds)
      for (const project of projects) {
        if (typeof project.leaderSessionId === 'string' && project.leaderSessionId !== '') {
          targets.add(project.leaderSessionId)
        }
        for (const sessionId of Array.isArray(project.retiredLeaderSessionIds)
          ? project.retiredLeaderSessionIds
          : []) {
          if (typeof sessionId === 'string' && sessionId !== '') targets.add(sessionId)
        }
      }
      const workspaces = registry.list()
        .map((info) => (typeof registry.get === 'function' ? registry.get(info.id) : undefined) ?? info)
        .filter((workspace) => typeof workspace.detachSession === 'function')
      let removed = 0
      for (const workspace of workspaces) {
        for (const sessionId of targets) {
          try {
            await workspace.detachSession(sessionId)
            removed += 1
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            logger(`dsh-leader-kit: 会话 ${sessionId} 从工作区摘除失败：${message}`)
          }
        }
      }
      return removed
    },

    /**
     * 列项目下的会话：worker，加上被换下的 leader。
     *
     * worker 的判据是会话跑的目录加上 worker 身份。worker 现在是普通根会话（由
     * `agents.create` 建），会话头没有 `origin: 'subagent'` 标记，身份由 worker
     * 登记表给（`isWorkerSession`）。当前 leader（入口在项目行上）与用户在项目目录
     * 里手动开的会话都不算。子目录里开的 worker 不算——那属于另一个目录。
     *
     * 退役 leader 按记录里的 id 收，不按目录：它换下后就是项目里的普通会话（历史
     * 还归项目），但目录判据认不出它——这条会话是本插件建的，用户手开的不该跟着
     * 进来。不列它的话，它会既不在项目下、也不在（被排除的）官方工作区树里。
     *
     * `sessionQuery` 缺失时返回空映射：会话索引是增强能力，缺了不该让项目列表
     * 整体不可用。
     *
     * @returns {Promise<{projectId: string, sessionIds: string[]}[]>} 每个项目的会话 id 列表
     */
    async sessionsByProject() {
      const query = ctx.get('sessionQuery')
      if (query === undefined || typeof query.listSessions !== 'function') return []
      const projects = await store.list()
      const records = await query.listSessions()
      const sessions = records
        .map((record) => ({
          id: record?.header?.id,
          cwd: record?.header?.cwd,
          origin: record?.header?.origin,
        }))
        .filter((session) => typeof session.id === 'string' && session.id !== '')
      const grouped = await groupSessionsByProject({
        projects,
        sessions,
        canonicalize,
        isWorkerSession,
      })
      // 退役会话已从会话库消失时不再列出：留下来只会得到一条点不开的行。
      const known = new Set(sessions.map((session) => session.id))
      for (const project of projects) {
        const retired = Array.isArray(project.retiredLeaderSessionIds)
          ? project.retiredLeaderSessionIds
          : []
        const extra = retired.filter((sessionId) => sessionId !== project.leaderSessionId
          && known.has(sessionId))
        if (extra.length === 0) continue
        const bucket = grouped.get(project.id)
        if (bucket === undefined) {
          grouped.set(project.id, [...extra])
          continue
        }
        for (const sessionId of extra) {
          if (!bucket.includes(sessionId)) bucket.push(sessionId)
        }
      }
      return [...grouped.entries()].map(([projectId, sessionIds]) => ({ projectId, sessionIds }))
    },

    /**
     * 读单个项目。
     * @param {string} id - 项目 id
     * @returns {Promise<object | undefined>} 项目，不存在时 undefined
     */
    async get(id) {
      const project = await store.get(id)
      if (project === undefined) return undefined
      return {
        ...project,
        leaderAlive: await leaderAliveOf(project.leaderSessionId),
      }
    },

    /**
     * 按 leader 会话 id 反查项目。
     *
     * 会话归属的判定真源就是这条指针——dsh 的会话头没有自由元数据槽，第三方插件
     * 无法给会话塞 `projectId`。
     *
     * @param {string} sessionId - 会话 id
     * @returns {Promise<object | undefined>} 项目，不存在时 undefined
     */
    async getByLeader(sessionId) {
      const project = await store.getByLeader(sessionId)
      if (project === undefined) return undefined
      return {
        ...project,
        leaderAlive: await leaderAliveOf(project.leaderSessionId),
      }
    },

    /**
     * 改项目名。
     * @param {string} id - 项目 id
     * @param {string} name - 新项目名
     * @returns {Promise<object>} 更新后的项目
     */
    async rename(id, name) {
      return store.update(id, { name: assertUsableName(name) })
    },

    /**
     * 调整项目在列表里的位置：移到 `beforeId` 之前，空串表示末尾。
     *
     * 顺序就是用户拖拽出来的显示顺序，与建项时间无关。
     *
     * @param {string} id - 项目 id
     * @param {string} beforeId - 落点项目 id；空串表示末尾
     * @returns {Promise<void>} 完成
     */
    async reorder(id, beforeId) {
      await store.move(id, beforeId)
    },

    /**
     * 换新 leader：建一个新会话并改绑，旧会话降级为项目里的普通会话。
     *
     * 旧会话 id 记进 `retiredLeaderSessionIds`：它换下后既不是当前 leader
     * （排除集不再覆盖它），也不是 worker（目录判据认不出插件建的会话），不记的话
     * 会掉回官方工作区树里当普通会话，项目下反而看不到它的历史。
     *
     * 改绑之后跑 `onLeaderReplaced`：派工归属与未投递的完成通知要从旧会话改投
     * 新会话，否则新 leader 对着原班 worker 什么都做不了（见 `leader-handover`）。
     *
     * @param {string} id - 项目 id
     * @returns {Promise<object>} 更新后的项目
     */
    async replaceLeader(id) {
      const project = await store.get(id)
      if (project === undefined) throw new Error(`项目不存在：${id}`)
      // 目录没了先给可读的中文原因：宿主建会话时会 mkdir 目录，但这里先停下更清楚。
      await assertUsableDirectory(project.directory)
      const leaderSessionId = await openRegisteredLeaderSession(project.directory)
      let updated
      try {
        // 退役列表与改绑同一次写入：分开写的话，中途失败会留下一条「leader 已换、
        // 旧会话谁都不认」的记录。要退役的是**落盘记录里的**当前 leader，不是进
        // 函数时读到的那个：两个客户端并发点击时，各读同一份快照、各建一个会话，
        // 按快照算的话先建的那个既不在退役列表、又留在 leader 索引里。函数形态的
        // update 把读-改-写放进存储的串行链，后写的那次能看见前一次的落盘值。
        updated = await store.update(id, (current) => {
          const previous = current.leaderSessionId
          const retired = Array.isArray(current.retiredLeaderSessionIds)
            ? current.retiredLeaderSessionIds
            : []
          const retirePrevious = typeof previous === 'string' && previous !== ''
            && previous !== leaderSessionId && !retired.includes(previous)
          return retirePrevious
            ? { leaderSessionId, retiredLeaderSessionIds: [...retired, previous] }
            : { leaderSessionId }
        })
      } catch (error) {
        leaderIndex.delete(leaderSessionId)
        await abandonLeaderSession(leaderSessionId)
        throw error
      }
      // 对齐放在失败路径之外：这次写已经落盘、新会话就是记录里的 leader，重读失败
      // 不该把它连带撤销（那会留下「记录指向一条被停掉的会话」）。
      await syncLeaderIndex(id)
      // 接管：新会话要接过原班 worker 与未投递的回报，否则「新会话立刻接手项目」
      // 只成立在项目记录上。每次都跑一遍而不是只在本轮真退役时跑——它按记录里的
      // 退役集幂等推进，顺带补上早先漏迁的记录。
      await onLeaderReplaced?.({ projectId: id })
      return updated
    },

    /**
     * 删项目。
     *
     * 只删项目记录：项目不拥有工作区、也不拥有会话，用户的目录、会话日志与工作区
     * 都原样保留。leader 会话同样是用户的会话历史，删掉等于丢上下文。
     *
     * @param {string} id - 项目 id
     * @returns {Promise<{project: object} | undefined>} 删除结果，项目不存在时 undefined
     */
    async remove(id) {
      const removed = await store.remove(id)
      if (removed === undefined) return undefined
      if (typeof removed.leaderSessionId === 'string') {
        leaderIndex.delete(removed.leaderSessionId)
      }
      // 目录索引要重建而不是直接删：两个项目可能指向同一目录，删掉其中一个时
      // 另一个仍占着这个目录，它的卡片还得能归到它名下。
      const canonical = await canonicalize(removed.directory)
      canonicalDirectoryIndex.delete(canonical)
      for (const project of await store.list()) {
        const other = await canonicalize(project.directory)
        if (other === canonical && !canonicalDirectoryIndex.has(canonical)) {
          canonicalDirectoryIndex.set(canonical, project.id)
        }
      }
      return { project: removed }
    },
  }
}

/**
 * 用宿主服务建一个 leader 会话。
 *
 * 优先走 `sessionController`（官方完整路径：建 agent、带上默认模型），它只挂在
 * web-app bundle 上；缺失时退回 `agents` 注册表直接建 agent——`agents` 由 base
 * bundle 提供，所有 profile 都有。两个服务都走惰性获取：它们不在本插件的
 * `inject` 列表里，声明成必需依赖会让不含该服务的 profile 整个插件挂起。
 *
 * 走 `sessionController` 时只带 `cwd`：项目不创建也不挂接 dsh 工作区，会话因此不
 * 归属任何分组。
 *
 * `sessionId` 由调用方给定，两条路径都原样用它建会话——leader 身份在建会话之前
 * 就登记好了，换成别的 id 会让工具面裁成普通会话（见
 * `openRegisteredLeaderSession`）。
 *
 * @param {object} ctx - Cordis 上下文
 * @param {string} directory - 项目目录绝对路径
 * @param {string} sessionId - 会话 id，由调用方预生成
 * @returns {Promise<string>} 建成的会话 id
 */
export async function createLeaderSessionWithCtx(ctx, directory, sessionId) {
  const controller = ctx.get('sessionController')
  if (controller !== undefined && typeof controller.create === 'function') {
    const created = await controller.create({ cwd: directory, sessionId })
    return created.sessionId
  }
  const agents = ctx.get('agents')
  if (agents === undefined || typeof agents.create !== 'function') {
    throw new Error('当前组合既没有 sessionController 也没有 agents 服务，无法建立 leader 会话')
  }
  const defaults = ctx.get('agentDefaultModel')
  // 和 worker 同理：`agents.create` 不挂 preset，不挂就没有 bash / read。
  const preset = await agentPresetOptions(ctx)
  const handle = await agents.create({
    sessionId,
    ...defaults === undefined
      ? {}
      : {
          agentOptions: {
            get provider() { return defaults.currentSelection().provider },
            get model() { return defaults.currentSelection().model },
            get reasoningEffort() { return defaults.currentSelection().reasoningEffort },
          },
        },
    ...preset.setup === undefined ? {} : { setup: preset.setup },
    meta: {
      cwd: directory,
      ...preset.agentPreset === undefined ? {} : { agentPreset: preset.agentPreset },
    },
  })
  return handle?.agent?.id ?? sessionId
}

/**
 * 判断会话是否仍存在。
 *
 * `sessionQuery` 由 sqlite 引擎提供，引擎可能被部署替换，因此走惰性获取；缺失时
 * 返回 undefined，语义是「不知道」而不是「不存在」。
 *
 * @param {object} ctx - Cordis 上下文
 * @param {string} sessionId - 会话 id
 * @returns {Promise<boolean | undefined>} 会话是否存在
 */
export async function sessionExistsWithCtx(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query === undefined || typeof query.listSessions !== 'function') return undefined
  const records = await query.listSessions()
  return records.some((record) => record?.header?.id === sessionId)
}
