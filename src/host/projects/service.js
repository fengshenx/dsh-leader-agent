/**
 * 项目服务：项目实体的领域操作。
 *
 * 服务层的核心语义：
 *
 * - **建项目 = 建实体 + 建协调者会话 + 绑定**，三步一体。协调者会话在项目目录里
 *   运行（`SessionHeader.cwd` 创建时定死），项目与会话之间是显式指针，不是「目录里
 *   最新的那个会话」这类软约定。
 * - **失败整体回滚**：协调者会话建不出来时项目不落盘；项目落盘失败时尽力撤销刚建
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
 * @param {(directory: string, sessionId: string) => Promise<string>} [options.createCoordinatorSession] - 建协调者会话。
 *   必须使用传入的 `sessionId`：协调者身份在建会话之前就登记了，换成别的 id 会让工具面裁成普通会话
 * @param {(sessionId: string) => Promise<boolean | undefined>} [options.sessionExists] - 判断会话是否仍存在
 * @param {(sessionId: string) => boolean} options.isWorkerSession - worker 会话判定。
 *   会话头看不出身份（worker 是普通根会话），列项目的会话树只能按登记表判。
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {object} 项目服务接口
 */
export function createProjectService({
  store,
  ctx,
  createCoordinatorSession,
  sessionExists,
  isWorkerSession,
  logger = () => {},
}) {
  if (typeof isWorkerSession !== 'function') {
    throw new Error('dsh-leader-kit: createProjectService 缺少 isWorkerSession，无法判定哪些会话属于项目')
  }
  const openCoordinatorSession = createCoordinatorSession
    ?? ((directory, sessionId) => createCoordinatorSessionWithCtx(ctx, directory, sessionId))
  const coordinatorExists = sessionExists
    ?? ((sessionId) => sessionExistsWithCtx(ctx, sessionId))

  /**
   * 协调者会话 id → 项目的内存镜像（值是 `{ directory }`，项目记录落盘后再补
   * `projectId`）。
   *
   * 项目注册表是异步落盘的，而提示词组装与派工都需要**同步**拿到「这个会话属于
   * 哪个项目」。卡片库用的是同一手法：落盘是真源，内存镜像是读路径。
   *
   * 建项目期间会有只有 `directory` 的占位条目——身份登记早于会话创建（见
   * `openRegisteredCoordinatorSession`），读 `projectId` 的地方必须容忍它缺席。
   */
  const coordinatorIndex = new Map()

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
   * 重建前内存镜像是空的，「这个会话是不是协调者」问不出真话；工具面分配要
   * 同步拿到答案，等不了 promise，只能靠这个标志区分「没有协调者」与「还不知道」。
   */
  let indexLoaded = false

  // 目录归一器在进程内共享：会话头里的 cwd 高度重复，重复 realpath 纯属浪费。

  /**
   * 撤销一个刚建成的协调者会话。
   *
   * dsh 没有「删除会话」的公开能力（`sessionController` 只提供创建与导航），因此
   * 这里只能尽力把 agent 停掉；残留的会话记录会落在左栏的「未分组」桶里，不影响
   * 项目数据。撤销失败必须记日志，不能静默吞掉。
   *
   * @param {string} sessionId - 会话 id
   * @returns {Promise<void>} 撤销完成
   */
  async function abandonCoordinatorSession(sessionId) {
    try {
      const agent = ctx.get('agents')?.get?.(sessionId)
      await agent?.dispose?.()
    } catch (error) {
      logger(
        `dsh-leader-kit: 撤销协调者会话 ${sessionId} 失败：`
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * 建一个协调者会话，并且在它被建出来之前就把身份登记进索引。
   *
   * 工具面在 `agent/created` 里按 `isCoordinatorSession()` 当场裁，而那个事件在
   * 建会话内部就发出来了。先建会话、后登记的话，协调者出生的那一刻注册表里还没
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
  async function openRegisteredCoordinatorSession(directory) {
    const sessionId = `session-${randomUUID()}`
    coordinatorIndex.set(sessionId, { directory })
    let created
    try {
      created = await openCoordinatorSession(directory, sessionId)
    } catch (error) {
      coordinatorIndex.delete(sessionId)
      throw error
    }
    if (created !== sessionId) {
      // 建会话的实现没按契约用传入的 id：占位登记在错的键上，工具面也已经裁错了
      // 一轮。这个契约由我们自己的 createCoordinatorSessionWithCtx 保证，破了说明
      // 宿主换了行为，必须当场停下而不是留一个工具面残缺的协调者。
      coordinatorIndex.delete(sessionId)
      await abandonCoordinatorSession(created)
      throw new Error(`协调者会话建成了 ${created}，预定的是 ${sessionId}：建会话的实现必须使用传入的 id`)
    }
    return sessionId
  }

  /**
   * 协调者会话是否已被归档。
   *
   * 归档只往工作区注册表的归档集合里加 id，不删会话记录；只看会话是否存在会把
   * 归档的协调者当成还活着。
   *
   * @param {string} sessionId - 会话 id
   * @returns {boolean} 已归档时 true
   */
  function isArchived(sessionId) {
    const archived = ctx.get('workspaceRegistry')?.archivedSessionIds
    return Array.isArray(archived) && archived.includes(sessionId)
  }

  /**
   * 协调者会话是否还在。
   *
   * 存活 = 会话记录存在且未被归档。`undefined` 表示宿主没有会话查询后端（不知道），
   * 调用方按「还在」处理，不把未知误报成失效。
   *
   * @param {string} sessionId - 会话 id
   * @returns {Promise<boolean | undefined>} 是否还在
   */
  async function coordinatorAliveOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    const exists = await coordinatorExists(sessionId)
    if (exists === undefined) return undefined
    if (!exists) return false
    return !isArchived(sessionId)
  }

  /**
   * 项目摘要：客户端拿它判定看板可见性，以及协调者会话是否还在。
   *
   * @param {object} project - 项目记录
   * @returns {Promise<object>} 项目摘要
   */
  async function summarizeProject(project) {
    return {
      id: project.id,
      name: project.name,
      directory: project.directory,
      coordinatorSessionId: project.coordinatorSessionId ?? '',
      coordinatorAlive: await coordinatorAliveOf(project.coordinatorSessionId),
    }
  }

  return {
    /**
     * 重建协调者索引。进程启动时调用：内存镜像是进程内的，崩溃后不会留下。
     * @returns {Promise<Map<string, string>>} 重建后的索引
     */
    async loadIndex() {
      const rebuilding = (async () => {
        const projects = await store.list()
        coordinatorIndex.clear()
        canonicalDirectoryIndex.clear()
        for (const project of projects) {
          if (typeof project.coordinatorSessionId === 'string' && project.coordinatorSessionId !== '') {
            coordinatorIndex.set(project.coordinatorSessionId, {
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
        return coordinatorIndex
      })()
      // 重建成功才算就绪：失败时索引仍是空的，`isCoordinatorSession()` 继续走
      // 保守放行，而不是把协调者的工具面判没。失败事实仍由返回值传播给调用方。
      indexReady = rebuilding.then(
        () => {
          indexLoaded = true
        },
        () => undefined,
      )
      return rebuilding
    },

    /**
     * 等协调者索引就绪，并报告它到底有没有读出来。
     *
     * `isCoordinatorSession()` 在索引未就绪时一律放行——那是为了保证协调者首轮
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
     * 同步判定某个会话是不是项目协调者。
     *
     * 协调者身份在建项目时就写进注册表（`coordinatorSessionId`），工具面据此
     * 分配——不必等会话跑起来再从会话内容里推断。
     *
     * 索引重建完成前一律返回 true：那时注册表还没读回内存，返回 false 会让
     * 协调者首轮看不到编排工具，活直接干不成。这个宽松只对读类工具安全——派工
     * 走 `awaitIndex()` 再判一次，不能靠这里兜。
     *
     * @param {string} sessionId - 会话 id
     * @returns {boolean} 是否项目协调者
     */
    isCoordinatorSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false
      if (!indexLoaded) return true
      return coordinatorIndex.has(sessionId)
    },

    /**
     * 同步取某个协调者会话所属的项目目录。
     * @param {string} sessionId - 会话 id
     * @returns {string | undefined} 项目目录；该会话不是协调者时 undefined
     */
    directoryOfCoordinator(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      return coordinatorIndex.get(sessionId)?.directory
    },

    /**
     * 取协调者会话所属项目的工作区。
     *
     * worker 与协调者跑在同一个项目目录里，二者都该归属同一个工作区——归属决定
     * 官方树把它们放在哪个分组（不归属就落「未分组」）。协调者由 `create` 时挂好，
     * worker 建完要用这条把它挂进去。
     *
     * @param {string} sessionId - 协调者会话 id
     * @returns {Promise<string | undefined>} 工作区 id；没有对应工作区时 undefined
     */
    async workspaceIdOfCoordinator(sessionId) {
      await indexReady
      const projectId = coordinatorIndex.get(sessionId)?.projectId
      if (projectId === undefined) return undefined
      const project = await store.get(projectId)
      return project === undefined ? undefined : recordedWorkspaceId(ctx, project)
    },

    /**
     * 解析某个会话所属的项目。
     *
     * 判据两条，先命中先用：
     *
     * - **协调者会话** → 项目注册表里的那条指针（`coordinatorSessionId`）；
     * - **其它会话** → 会话 cwd 的 canonical 路径与项目目录的 canonical 路径相等。
     *   worker 会话的 cwd 就是项目目录，用户在项目目录里手动开的会话也是——它们
     *   做的都是这个项目的事。
     *
     * 会话 cwd 从宿主的会话注册表读（`sessions.get(id).header.cwd`）。读不到就
     * 明确说「不归属任何项目」，不猜：把卡挂到猜出来的项目上，比不挂更难查。
     *
     * @param {string} sessionId - 会话 id
     * @returns {Promise<object | undefined>} 所属项目（`{ id, name, directory,
     *   coordinatorSessionId, coordinatorAlive }`）；不归属时 undefined
     */
    async resolveProjectOfSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      // 索引是进程内的镜像，启动时异步重建。重建完成前判定归属会得到「不归属
      // 任何项目」，卡片就会静悄悄地丢归属——等索引就绪再判。
      await indexReady
      const coordinator = coordinatorIndex.get(sessionId)
      // 建项目期间索引里先只有 directory 占位（登记早于会话创建，见
      // openRegisteredCoordinatorSession），那时 projectId 还没有值。
      if (coordinator?.projectId !== undefined) {
        const project = await store.get(coordinator.projectId)
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
     * 建项目：建实体 + 建协调者会话 + 绑定。
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

      // 只有插件自己注册的工作区才算项目的：复用来的可能是用户自己加的。
      // 必须在建会话之前问——建会话本身也会注册工作区，那时再问就只剩「已存在」。
      const ensured = await ensureWorkspace(ctx, normalizedDirectory, canonicalize)
      // 先建会话再建记录：会话建不出来时项目不落盘，失败路径没有半条记录。
      const coordinatorSessionId = await openRegisteredCoordinatorSession(normalizedDirectory)
      const draft = store.draft({
        name: displayName,
        directory: normalizedDirectory,
        coordinatorSessionId,
        ...ensured?.created === true ? { workspaceId: ensured.workspace.id } : {},
      })
      let inserted
      try {
        inserted = await store.insert(draft)
        coordinatorIndex.set(coordinatorSessionId, {
          projectId: inserted.id,
          directory: normalizedDirectory,
        })
        const canonical = await canonicalize(normalizedDirectory)
        if (!canonicalDirectoryIndex.has(canonical)) {
          canonicalDirectoryIndex.set(canonical, inserted.id)
        }
      } catch (error) {
        coordinatorIndex.delete(coordinatorSessionId)
        await abandonCoordinatorSession(coordinatorSessionId)
        throw error
      }
      return inserted
    },

    /**
     * 列项目，并标注协调者会话是否仍在、是否已挂到工作区。
     *
     * `coordinatorAttached` 决定浏览器侧能不能把协调者会话打开成主区域：只有
     * 归属工作区的会话才能被官方 UI 打开（见 `ensureWorkspace`）。
     *
     * @returns {Promise<object[]>} 项目列表
     */
    async list() {
      const projects = await store.list()
      return Promise.all(projects.map(async (project) => ({
        ...project,
        coordinatorAlive: await coordinatorAliveOf(project.coordinatorSessionId),
        coordinatorAttached: isSessionAttachedToWorkspace(ctx, project.coordinatorSessionId),
        workspaceId: recordedWorkspaceId(ctx, project),
      })))
    },

    /**
     * 确保协调者会话挂在项目目录对应的工作区上。
     *
     * 官方 UI 只能打开归属工作区的会话（宿主 `session.create` 传 `cwd` 建出的
     * 会话不归属任何工作区，见 `ensureWorkspace`）。目录还不是
     * 工作区时这里顺带注册一个——注册是幂等的，宿主侧已有同名工作区就直接复用。
     *
     * 工作区被用户删掉后再点项目行会走到这里：重建一个（`recreated`）并把协调者、
     * 退役协调者与本项目登记过的 worker 一起挂回去——工作区不在期间它们都是松散
     * 会话，落在官方树的「未分组」里。只恢复插件自己建的会话，用户在项目目录里
     * 手动开的会话不碰。
     *
     * @param {string} id - 项目 id
     * @returns {Promise<{attached: boolean, workspaceId?: string, recreated?: boolean,
     *   reconnected?: number, reason?: string}>} 挂载结果
     */
    async attachCoordinator(id) {
      const project = await store.get(id)
      if (project === undefined) throw new Error('项目不存在')
      if (ctx.get('workspaceRegistry') === undefined) {
        return { attached: false, reason: '当前宿主没有工作区服务，无法把协调者会话挂到工作区。' }
      }
      const ensured = await ensureWorkspace(ctx, project.directory, canonicalize)
      if (ensured === undefined) {
        return { attached: false, reason: '当前宿主的工作区服务不支持注册目录。' }
      }
      const workspace = ensured.workspace
      const recreated = ensured.created === true
      if (recreated) {
        // 只有插件自己注册的工作区才记进项目记录：复用的可能是用户自己加的
        // 工作区，那不是我们的，不该被隐藏。
        await store.update(project.id, { workspaceId: workspace.id })
      }
      // 归属可能刚写进记录（工作区是这次新建的），重读一遍再报给调用方。
      const recorded = await store.get(project.id) ?? project
      const targets = await this.coordinatorAttachTargets(recorded)
      const members = new Set(workspace.sessionIds ?? [])
      let reconnected = 0
      for (const sessionId of targets) {
        if (members.has(sessionId)) {
          reconnected += 1
          continue
        }
        if (!(await coordinatorExists(sessionId))) continue
        try {
          await workspace.attachSession(sessionId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // 协调者挂不上就真的打不开项目，必须回传；worker 挂不上只是它会留在
          // 「未分组」里，不该让整次打开失败。
          if (sessionId === recorded.coordinatorSessionId) {
            return { attached: false, reason: `协调者会话挂到工作区失败：${message}` }
          }
          logger(`dsh-leader-kit: worker 会话 ${sessionId} 挂回工作区失败：${message}`)
          continue
        }
        members.add(sessionId)
        reconnected += 1
      }
      return {
        attached: true,
        workspaceId: recordedWorkspaceId(ctx, recorded),
        recreated,
        reconnected,
      }
    },

    /**
     * 列出该挂进项目工作区的会话：协调者、退役协调者与登记过的 worker。
     *
     * 用途只有一个——工作区被删后重建时把它们挂回去。用户在同一目录里手动开的
     * 会话不在名单里：把别人的会话塞进一个被隐藏的工作区，等于让它们从界面上
     * 消失。
     *
     * @param {object} project - 项目记录
     * @returns {Promise<string[]>} 会话 id（去重，协调者在前）
     */
    async coordinatorAttachTargets(project) {
      const targets = []
      if (typeof project.coordinatorSessionId === 'string' && project.coordinatorSessionId !== '') {
        targets.push(project.coordinatorSessionId)
      }
      const retired = Array.isArray(project.retiredCoordinatorSessionIds)
        ? project.retiredCoordinatorSessionIds
        : []
      for (const sessionId of retired) {
        if (typeof sessionId === 'string' && !targets.includes(sessionId)) targets.push(sessionId)
      }
      for (const entry of await this.sessionsByProject()) {
        if (entry.projectId !== project.id) continue
        for (const sessionId of entry.sessionIds) {
          if (!targets.includes(sessionId)) targets.push(sessionId)
        }
      }
      return targets
    },

    /**
     * 移除项目在宿主里注册的工作区。
     *
     * 它是 `remove()` 的内部步骤：插件注册的工作区在官方左栏里是隐藏的，用户在
     * 官方界面里没法直接删它，删项目时要顺手摘掉。宿主的 `delete` 只删注册，目录
     * 与全部会话日志都留着（`packages/workspace/workspace/src/index.ts:302-312`），
     * 协调者会话仍然在，只是不再归属工作区。
     *
     * 「没有东西可摘」与「摘失败」必须分开：宿主没有工作区服务、记录里没有归属
     * （复用的用户工作区）、归属指向的工作区已不在宿主里，这三种都是 `skipped`，
     * 不是故障——调用方不该把它们报成「工作区未移除」。
     *
     * @param {string} id - 项目 id
     * @returns {Promise<{removed: boolean, skipped?: boolean, reason?: string}>} 移除结果；`skipped` 表示没有需要移除的工作区，`reason` 只出现在真失败上
     */
    async removeWorkspace(id) {
      const project = await store.get(id)
      if (project === undefined) throw new Error('项目不存在')
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.list !== 'function') {
        return { removed: false, skipped: true }
      }
      const workspaceId = project.workspaceId
      if (typeof workspaceId !== 'string' || workspaceId === '') {
        return { removed: false, skipped: true }
      }
      if (!registry.list().some((workspace) => workspace.id === workspaceId)) {
        await store.update(project.id, { workspaceId: undefined })
        return { removed: false, skipped: true }
      }
      if (typeof registry.delete !== 'function') {
        return { removed: false, reason: '当前宿主的工作区服务不支持删除。' }
      }
      // `delete` 报 false 说明工作区已经不在了（并发删同一个项目时另一个调用先
      // 摘掉了它），结果与成功等价，不该按失败回传。
      const deleted = (await registry.delete(workspaceId)) !== false
      await store.update(project.id, { workspaceId: undefined })
      return deleted ? { removed: true } : { removed: false, skipped: true }
    },

    /**
     * 列项目下的会话：worker，加上被换下的协调者。
     *
     * worker 的判据是会话跑的目录加上 worker 身份。worker 现在是普通根会话（由
     * `agents.create` 建），会话头没有 `origin: 'subagent'` 标记，身份由 worker
     * 登记表给（`isWorkerSession`）。当前协调者（入口在项目行上）与用户在项目目录
     * 里手动开的会话都不算。子目录里开的 worker 不算——那属于另一个目录。
     *
     * 退役协调者按记录里的 id 收，不按目录：它换下后就是项目里的普通会话（历史
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
        const retired = Array.isArray(project.retiredCoordinatorSessionIds)
          ? project.retiredCoordinatorSessionIds
          : []
        const extra = retired.filter((sessionId) => sessionId !== project.coordinatorSessionId
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
        coordinatorAlive: await coordinatorAliveOf(project.coordinatorSessionId),
        coordinatorAttached: isSessionAttachedToWorkspace(ctx, project.coordinatorSessionId),
        workspaceId: recordedWorkspaceId(ctx, project),
      }
    },

    /**
     * 按协调者会话 id 反查项目。
     *
     * 会话归属的判定真源就是这条指针——dsh 的会话头没有自由元数据槽，第三方插件
     * 无法给会话塞 `projectId`。
     *
     * @param {string} sessionId - 会话 id
     * @returns {Promise<object | undefined>} 项目，不存在时 undefined
     */
    async getByCoordinator(sessionId) {
      const project = await store.getByCoordinator(sessionId)
      if (project === undefined) return undefined
      return {
        ...project,
        coordinatorAlive: await coordinatorAliveOf(project.coordinatorSessionId),
        coordinatorAttached: isSessionAttachedToWorkspace(ctx, project.coordinatorSessionId),
        workspaceId: recordedWorkspaceId(ctx, project),
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
     * 换新协调者：建一个新会话并改绑，旧会话降级为项目里的普通会话。
     *
     * 旧会话 id 记进 `retiredCoordinatorSessionIds`：它换下后既不是当前协调者
     * （排除集不再覆盖它），也不是 worker（目录判据认不出插件建的会话），不记的话
     * 会掉回官方工作区树里当普通会话，项目下反而看不到它的历史。
     *
     * @param {string} id - 项目 id
     * @returns {Promise<object>} 更新后的项目
     */
    async replaceCoordinator(id) {
      const project = await store.get(id)
      if (project === undefined) throw new Error(`项目不存在：${id}`)
      // 建会话本身会注册工作区（会话要归属工作区才能被官方 UI 打开），这一步
      // 顺带把归属记进项目记录——工作区被删过再换协调者时，归属会重新落回。
      const ensured = await ensureWorkspace(ctx, project.directory, canonicalize)
      if (ensured?.created === true) {
        await store.update(id, { workspaceId: ensured.workspace.id })
      }
      const coordinatorSessionId = await openRegisteredCoordinatorSession(project.directory)
      const previous = project.coordinatorSessionId
      const retired = Array.isArray(project.retiredCoordinatorSessionIds)
        ? project.retiredCoordinatorSessionIds
        : []
      // 退役列表与改绑同一次写入：分开写的话，中途失败会留下一条「协调者已换、
      // 旧会话谁都不认」的记录。
      const retirePrevious = typeof previous === 'string' && previous !== ''
        && previous !== coordinatorSessionId && !retired.includes(previous)
      let updated
      try {
        updated = await store.update(id, retirePrevious
          ? { coordinatorSessionId, retiredCoordinatorSessionIds: [...retired, previous] }
          : { coordinatorSessionId })
        if (typeof previous === 'string') {
          coordinatorIndex.delete(previous)
        }
        coordinatorIndex.set(coordinatorSessionId, {
          projectId: id,
          directory: project.directory,
        })
      } catch (error) {
        coordinatorIndex.delete(coordinatorSessionId)
        await abandonCoordinatorSession(coordinatorSessionId)
        throw error
      }
      return updated
    },

    /**
     * 删项目，连同插件为它注册的工作区一起。
     *
     * 顺序是先移除工作区、再删记录：反过来时中途失败会留下一个谁都不记得的孤儿
     * 工作区——项目没了，菜单里的删除入口也没了。工作区删除只删注册，目录与全部
     * 会话日志保留，会话因此落到宿主工作区树的「未分组」下。
     *
     * 复用的用户工作区不记在项目记录里，不会被碰到；宿主工作区服务不支持删除时
     * 如实把原因带回给调用方，项目照删（与「项目仍在、工作区留在宿主里」的旧行为
     * 一致，用户仍可在官方面板里删掉它）。协调者会话本身也保留：它是用户的会话
     * 历史，删掉等于丢上下文。
     *
     * @param {string} id - 项目 id
     * @returns {Promise<{project: object, workspace: {removed: boolean, skipped?: boolean, reason?: string}} | undefined>} 删除结果，项目不存在时 undefined
     */
    async remove(id) {
      if (await store.get(id) === undefined) return undefined
      const workspace = await this.removeWorkspace(id)
      const removed = await store.remove(id)
      if (removed === undefined) return undefined
      if (typeof removed.coordinatorSessionId === 'string') {
        coordinatorIndex.delete(removed.coordinatorSessionId)
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
      return { project: removed, workspace }
    },
  }
}

/**
 * 拿到项目目录对应的工作区，没有就注册一个。
 *
 * dsh 的会话只有挂到工作区上，UI 才能把它显示到主区域——宿主 `session.create`
 * 传 `cwd` 建出来的会话不属于任何工作区（`packages/api/session-controller/src/commands.ts`
 * 的 create 只在传 `workspaceId` 时 attach），于是官方 UI 没有任何路径能打开它。
 * 因此建协调者会话前先确保目录已注册为工作区；注册是幂等的，目录已是工作区时
 * 直接复用。
 *
 * 「有没有是我们建的」由 `created` 区分：复用的工作区可能是用户自己加的，
 * 那不是插件的东西，不该被隐藏、不该被记进项目记录。
 *
 * @param {object} ctx - Cordis 上下文
 * @param {string} directory - 项目目录绝对路径
 * @param {(directory: string) => Promise<string>} canonicalize - 路径归一器
 * @returns {Promise<{workspace: object, canonical: string, created: boolean} | undefined>} 工作区
 */
async function ensureWorkspace(ctx, directory, canonicalize) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') return undefined
  const canonical = await canonicalize(directory)
  const existing = registry.list().find((workspace) => workspace.path === canonical)
  if (existing !== undefined) return { workspace: existing, canonical, created: false }
  if (typeof registry.create !== 'function') return undefined
  const created = await registry.create(canonical, canonical.split(/[\\/]/).pop() ?? canonical)
  if (created === undefined) return undefined
  return { workspace: created, canonical, created: true }
}

/**
 * 读项目记录里的工作区 id，只认仍然活着的。
 *
 * 返回的是「项目自己的」工作区，不是当前目录对应的那个：复用的用户工作区不在
 * 记录里，返回 undefined，删除项目时据此判断要不要动宿主的工作区。
 *
 * @param {object} ctx - Cordis 上下文
 * @param {object} project - 项目记录
 * @returns {string | undefined} 工作区 id；没有或已不在宿主里时 undefined
 */
export function recordedWorkspaceId(ctx, project) {
  return isWorkspaceAlive(ctx, project.workspaceId) ? project.workspaceId : undefined
}

/**
 * 判断工作区是否还在宿主里。
 *
 * 项目记录里的工作区 id 可能悬空——用户在工作区管理面板里删掉了它。悬空的 id
 * 不该再被当成「项目工作区」，否则客户端会拿着一张不存在的行去隐藏。
 *
 * @param {object} ctx - Cordis 上下文
 * @param {string} workspaceId - 记录里的工作区 id
 * @returns {boolean} 工作区仍在时 true
 */
export function isWorkspaceAlive(ctx, workspaceId) {
  if (typeof workspaceId !== 'string' || workspaceId === '') return false
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') return false
  return registry.list().some((workspace) => workspace.id === workspaceId)
}

/**
 * 判断会话是否已挂到某个工作区。
 *
 * @param {object} ctx - Cordis 上下文
 * @param {string} sessionId - 会话 id
 * @returns {boolean} 已挂到工作区时 true
 */
export function isSessionAttachedToWorkspace(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') return false
  return registry.list().some((workspace) => (workspace.sessionIds ?? []).includes(sessionId))
}

/**
 * 用宿主服务建一个协调者会话。
 *
 * 优先走 `sessionController`（官方完整路径：建 agent、带上默认模型），它只挂在
 * web-app bundle 上；缺失时退回 `agents` 注册表直接建 agent——`agents` 由 base
 * bundle 提供，所有 profile 都有。两个服务都走惰性获取：它们不在本插件的
 * `inject` 列表里，声明成必需依赖会让不含该服务的 profile 整个插件挂起。
 *
 * 走 `sessionController` 时优先按工作区建（见 `ensureWorkspace`）：
 * 只有归属工作区的会话才能被 UI 打开成主区域。
 *
 * `sessionId` 由调用方给定，两条路径都原样用它建会话——协调者身份在建会话之前
 * 就登记好了，换成别的 id 会让工具面裁成普通会话（见
 * `openRegisteredCoordinatorSession`）。
 *
 * @param {object} ctx - Cordis 上下文
 * @param {string} directory - 项目目录绝对路径
 * @param {string} sessionId - 会话 id，由调用方预生成
 * @returns {Promise<string>} 建成的会话 id
 */
export async function createCoordinatorSessionWithCtx(ctx, directory, sessionId) {
  const controller = ctx.get('sessionController')
  if (controller !== undefined && typeof controller.create === 'function') {
    const ensured = await ensureWorkspace(ctx, directory, canonicalize)
    const workspaceId = ensured?.workspace.id
    const created = await controller.create(workspaceId === undefined
      ? { cwd: directory, sessionId }
      : { workspaceId, sessionId })
    return created.sessionId
  }
  const agents = ctx.get('agents')
  if (agents === undefined || typeof agents.create !== 'function') {
    throw new Error('当前组合既没有 sessionController 也没有 agents 服务，无法建立协调者会话')
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
