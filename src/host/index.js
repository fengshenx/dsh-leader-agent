/**
 * dsh-leader-kit 的宿主侧插件。
 *
 * 贡献九件事：bundle 内置 skill 的发现（协议层）、后台派工工具、worker 会话的
 * 创建与续聊（常驻根会话 + 登记表落盘 + `message_worker` 工具）、轮次结束时由
 * 会话事件自动结算回报并唤醒协调者、任务看板卡片存储与卡片工具、项目注册表、
 * 项目数据的 Typert 远程通道、角色槽位到系统提示词的注入，以及项目协调者手册
 * （`COORDINATOR.md`）的注入。
 *
 * 客户端侧（交付看板 UI 与左栏项目区块）在 `src/client/`，跑在浏览器进程，与本
 * 模块不共处。
 *
 * @module dsh-leader-kit/host
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createSkillProvider } from './skills.js'
import { createSpawnWorkerTool } from './tools/spawn-worker.js'
import { createMessageWorkerTool } from './tools/message-worker.js'
import { createCreateCardTool, createUpdateCardTool, createListCardsTool } from './tools/cards.js'
import { createNotificationStore, resolveDshHome } from './notification-store.js'
import { createWorkerRegistry } from './worker-registry.js'
import { createWorkerSessions } from './worker-sessions.js'
import { createCardStore } from './cards/store.js'
import { applyCardContext } from './cards/card-context.js'
import { createProjectStore } from './projects/store.js'
import { createProjectService } from './projects/service.js'
import { createProjectRemote } from './projects/remote.js'
import { createDispatcher } from './dispatch.js'
import { createCoordinatorHandover } from './coordinator-handover.js'
import { applyToolGate, HOST_SUBAGENT_TOOLS } from './tools/gate.js'
import { applyRoleContext } from './slots/index.js'
import { applyCoordinatorContext } from './coordinator-context.js'
import { applyTeamGuard } from './team-guard.js'

const here = dirname(fileURLToPath(import.meta.url))

/** bundle 根目录（src/host 的上两级）。 */
const bundleRoot = join(here, '..', '..')

/**
 * 协议层 skill 在包内的目录，相对 `bundleRoot`。
 * `package.json` 的 `files` 必须覆盖它，漏写时装机后 skill 全部失效且无报错——`tests/skills.test.js` 守着这一对。
 */
export const SKILLS_DIR = '.agents/skills'

export const name = 'dsh-leader-kit-host'
// `systemPrompt` 必须声明：角色槽位靠它注册运行时上下文，服务不在作用域内时
// 注入静默失效（实测：不声明时上下文不进组装结果）。该服务由 base bundle 提供，
// 官方各 profile 都有。
// `sessionQuery`、`sessionController`、`agents` 与 `workspaceRegistry` 都走
// `ctx.get()` 惰性获取：前者由 sqlite 引擎提供（引擎可能被部署替换），后几者只挂
// 在特定 bundle 上。声明成必需依赖会让不含该服务的 profile 整个插件挂起。
// 建 worker 会话要的 `agents` 也在这里——缺它时派工报错说清是哪个缺口。
export const inject = ['skills', 'tools', 'systemPrompt']

/**
 * 本 bundle 注册到宿主的工具定义。
 *
 * 装配与文档门禁（`scripts/verify-doc-tool-names.mjs`）都从这里取名字，工具名因此
 * 只有一处来源：工厂返回什么，门禁就比对什么。依赖只在 `call` 里用到，取名字时
 * 不传也能拿到完整的工具定义。
 *
 * @param {object} [options] - 工具依赖
 * @param {object} [options.dispatcher] - 派工器
 * @param {object} [options.cards] - 卡片存储
 * @param {(sessionId: string | undefined) => Promise<object | undefined>} [options.resolveProject] - 卡片归属解析
 * @param {(sessionId: string | undefined) => boolean} [options.canWriteCards] - 写卡身份判定
 * @returns {object[]} 工具定义
 */
export function createBundleTools({ dispatcher, cards, resolveProject, canWriteCards } = {}) {
  return [
    createSpawnWorkerTool({ dispatcher }),
    createMessageWorkerTool({ dispatcher }),
    createCreateCardTool({ store: cards, resolveProject, canWrite: canWriteCards }),
    createUpdateCardTool({ store: cards, resolveProject, canWrite: canWriteCards }),
    createListCardsTool({ store: cards, resolveProject }),
  ]
}

/**
 * 文档里可以引用的工具名：本 bundle 注册的，加上宿主 subagent 组合提供的三件。
 *
 * 门禁（`scripts/verify-doc-tool-names.mjs`）按它比对。宿主三件不进本 bundle 的
 * 注册面，但文档会写它们——所以从 `HOST_SUBAGENT_TOOLS` 这个语义来源取，而不是
 * 借用 deny 名单：那份名单的变化理由是「协调者能不能用」，与「文档能不能写」不同。
 *
 * @returns {string[]} 工具名
 */
export function documentedToolNames() {
  return [...createBundleTools().map((tool) => tool.name), ...HOST_SUBAGENT_TOOLS]
}

/**
 * 挂载本 bundle 的能力。
 * @param {object} ctx - Cordis 上下文
 * @returns {void}
 */
export function apply(ctx) {
  const logger = (message) => {
    ctx.logger?.warn?.(message)
  }

  ctx.skills.registerProvider(() =>
    createSkillProvider({
      skillsRoot: join(bundleRoot, SKILLS_DIR),
      providerName: 'dsh-leader-kit',
      logger,
    }),
  )

  // 项目注册表：编排语境的容器。目录是代码语境，项目是编排语境，二者不合并。
  const projects = createProjectStore({ home: resolveDshHome(), logger })
  // worker 会话管理器要先建：项目服务列 worker 时要用它的同步判定（会话头没有
  // subagent 标记了，只有登记知道谁是 worker）。
  const workerSessions = createWorkerSessions({ ctx, logger })
  // 换协调者后的接管要同时改登记表、通知队列与派工器内存态，而派工器依赖项目
  // 服务（身份判定、worker 目录），只能晚绑定：先占位，装配完再换成真动作。
  /** @type {(change: { projectId: string }) => Promise<void>} */
  let handover = async () => {}
  const projectService = createProjectService({
    store: projects,
    ctx,
    isWorkerSession: workerSessions.isWorkerSession,
    onCoordinatorReplaced: (change) => handover(change),
    logger,
  })

  // 工具面按角色分配：协调者拿到编排与全库查询，worker 与普通会话都没有。
  // 裁剪在 `agent/created` 时对 agent 作用域做（见 `applyToolGate`）。
  const isCoordinatorSession = (sessionId) => projectService.isCoordinatorSession(sessionId)
  // 卡片写入只给协调者与 worker。工具面已经按角色裁过，这里再判一次是因为换协调
  // 者不重建旧会话：退役者手里的写入工具要到进程重启才收走。
  const canWriteCards = (sessionId) => isCoordinatorSession(sessionId)
    || workerSessions.isWorkerSession(sessionId) === true

  const cards = createCardStore({ home: resolveDshHome(), logger })
  // 卡片按项目归属：归属由宿主按调用方会话判定，模型不传项目参数。
  const resolveProject = (sessionId) => projectService.resolveProjectOfSession(sessionId)

  // 浏览器侧要读项目、也要建项目，走 dsh 官方的 Typert 远程调用（`/api`
  // 共享通道），与工作区控制器同构。
  const store = createNotificationStore({ logger })
  const workers = createWorkerRegistry({ home: resolveDshHome(), logger })
  // 启动时按登记表收编既有 worker 会话 id：工具面裁剪是同步判定，登记表是异步的，
  // 需要一份内存集合；不灌入的话重启后老 worker 会被当成普通会话，拿到协调者工具。
  void workers.list().then((records) => {
    for (const record of records) workerSessions.adopt(record.childId)
  }).catch((error) => {
    logger(`dsh-leader-kit: 读取 worker 登记表失败，重启后的老 worker 工具面可能偏宽：${error instanceof Error ? error.message : String(error)}`)
  })
  // 归档会话后的收尾（摘卡 + 摘派工登记）也走这条通道：归档本身由宿主的
  // `workspaces` 服务执行，浏览器侧只负责按顺序调用。
  createProjectRemote({ service: projectService, cards, workers, workerSessions, ctx })

  const dispatcher = createDispatcher({
    ctx,
    store,
    workers,
    // worker 是普通根会话（不是 subagent）：常驻、可被人下钻对话、进程重启后能
    // 用 `agents.resume` 接着跑。会话的创建与销毁都归它管。
    workerSessions,
    // worker 跑在项目目录里：协调者不能指定 worker 的工作目录。
    resolveWorkerCwd: (sessionId) => projectService.directoryOfCoordinator(sessionId),
    // worker 与协调者同属项目工作区：不挂就落官方树的「未分组」。
    resolveWorkerWorkspaceId: (sessionId) => projectService.workspaceIdOfCoordinator(sessionId),
    // 派工前要确认调用方是协调者，且索引真的读出来了，不能靠工具面的宽松放行。
    coordinatorIndex: projectService,
    // 名册上限与投递卡门禁都读宿主现状：归档集合来自工作区注册表，卡绑定来自
    // 卡片库。两者缺失时各自降级（不限数量 / 不做门禁），不阻塞派工。
    archivedSessionIds: () => ctx.get('workspaceRegistry')?.archivedSessionIds ?? [],
    listCardBindings: (sessionId) => cards.bindingsOf(sessionId),
    // 名册一次读盘取全量绑定再分组：逐 worker 读 cards.json 会让一次派工付
    // O(N × 文件体积)。
    cardBindingsBySession: () => cards.bindingsBySession(),
    // 派工时绑卡：会话 id 是预生成的，绑好之后协调者投递的第一条消息就带着
    // 角色槽位与卡片事实。
    bindCardSlot: (input) => cards.bindSlot(input),
    // 绑卡前校验归属与状态：与 update_card 同口径，跨项目、已关闭或已归档的卡
    // 都不能拿来绑 worker。
    resolveProject,
    getCard: (cardId) => cards.get(cardId),
    logger,
  })

  // 装配收尾：接管动作依赖上面全部组件，现在才成形。
  handover = createCoordinatorHandover({ projects, workers, notifications: store, dispatcher, logger })

  // 卡片写入只给协调者与 worker（见 `applyToolGate`）：普通会话不在项目编排里，
  // 建出来的卡没有槽位、没人认领，改别人的卡更没有依据。查全库卡片、派工与续聊
  // 同样只给协调者。
  for (const tool of createBundleTools({ dispatcher, cards, resolveProject, canWriteCards })) ctx.tools.register(tool)

  // 角色槽位注入：会话被卡片绑到某个槽位时，每轮请求组装时求值该槽位在项目
  // `SLOTS.md` 里的正文，正文变化才追加一份新快照。槽位不注册工具、不改工具可见性。
  applyRoleContext({
    ctx,
    slotIndex: cards.slotIndex,
    // 手册属于项目：协调者会话按项目注册表反查项目目录，worker 的会话 cwd 就是
    // 项目目录。都不是时回落会话自己的目录。
    resolveDirectory: (sessionId) => projectService.directoryOfCoordinator(sessionId)
      ?? ctx.get('sessions')?.get(sessionId)?.header?.cwd,
    logger,
  })

  // 任务卡注入：会话被卡片绑到某个槽位后，每轮请求组装时渲染该卡的事实
  // （编号、状态、规格、链接、revision），文本变化才追加新快照。卡片是会被改
  // 的事实，因此不拼进派工消息；worker 自己挂链接后下一轮就能看到。
  applyCardContext({
    ctx,
    cardIndex: cards.cardIndex,
    logger,
  })

  // 协调者手册注入：项目的协调者会话每轮请求组装时求值项目根 `COORDINATOR.md`
  // 的正文，内容变化才追加。它按身份决定，不需要卡片绑定——协调者天然属于这个项目。
  applyCoordinatorContext({
    ctx,
    // 只有协调者会话在这里有值；索引还没重建完时同样为空，那一轮不注入、
    // 下一轮补上（上下文每轮重新求值）。
    resolveDirectory: (sessionId) => projectService.directoryOfCoordinator(sessionId),
    logger,
  })

  // agent-team（experimental）并存时的护栏：检测到 `agentTeams` 服务时告警一次，
  // 并给协调者与 worker 注入「团队工具对本流程无效」的运行时上下文。工具面挡不住
  // 团队工具（它们注册在 Agent scope），原因见 `team-guard.js` 头注释。
  const teamGuard = applyTeamGuard({
    ctx,
    isCoordinatorSession,
    isWorkerSession: workerSessions.isWorkerSession,
    logger,
  })

  // 两份反查索引都是进程内的，崩溃后不会留下：启动时从卡片库重建（槽位与卡片事实）。
  void cards.loadIndexes().catch((error) => {
    logger(`dsh-leader-kit: 重建卡片索引失败：${error instanceof Error ? error.message : String(error)}`)
  })
  // 项目索引失败会永久停在「未就绪」，而那个状态下所有会话都被当作协调者。
  // 重启进程代价太大，退避重试几次；最终失败则由派工路径上的 awaitIndex 拒绝。
  /** @type {ReturnType<typeof setTimeout> | undefined} 重试定时器，卸载时清掉 */
  let indexRetryTimer
  /** @type {boolean} 插件是否已卸载：卸载后不再排新的重试 */
  let disposed = false
  const loadProjectIndex = async (attempt) => {
    try {
      await projectService.loadIndex()
    } catch (error) {
      logger(`dsh-leader-kit: 重建项目索引失败（第 ${attempt} 次）：${error instanceof Error ? error.message : String(error)}`)
      if (attempt >= 3 || disposed) return
      indexRetryTimer = setTimeout(() => { void loadProjectIndex(attempt + 1) }, 2000 * attempt)
    }
  }
  void loadProjectIndex(1)

  // 父会话注册后补投此前未送达的完成通知（进程崩溃窗口）。
  //
  // 工具面也在这里裁：`agent/created` 早于首轮请求组装，作用域是新建的，每次
  // 会话创建（含冷恢复）都重算一遍，不会带着上一次的限制。
  ctx.on('agent/created', ({ agent }) => {
    applyToolGate({ agent, isCoordinatorSession, isWorkerSession: workerSessions.isWorkerSession })
    // agent-team 服务可能在本次装配之后才注册（bundle 顺序不保证），所以检测放在
    // 第一次会话创建时，而不是 apply 里。
    teamGuard.warnOnce()
    dispatcher.markAlive(agent.id)
    void dispatcher.redeliverPending(agent).catch((error) => {
      logger(`dsh-leader-kit: 补投完成通知失败：${error instanceof Error ? error.message : String(error)}`)
    })
  })

  // 失活的 agent 会静默接受 followup，投递前必须知道会话已销毁。worker 会话还要
  // 从活表里摘掉：否则后续 `message_worker` 会投给一个死会话，回执成功而 worker
  // 一动不动。
  ctx.on('agent/disposed', ({ agent }) => {
    dispatcher.markDisposed(agent.id)
    workerSessions.forget(agent.id)
  })

  // 外部输入抵达即重置该会话的自动续行计数——人工介入后护栏应重新开始计数。
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!dispatcher.isInjected(message.id)) {
      dispatcher.resetResumeCount(agent.id)
    }
  })

  // 空闲检测的定时器随插件卸载一起停掉；活着的 worker 会话也一并销毁，否则插件
  // 卸载后它们仍在跑、仍在写会话日志。
  ctx.on('dispose', () => {
    disposed = true
    clearTimeout(indexRetryTimer)
    dispatcher.dispose()
    void workerSessions.disposeAll()
  })
}
