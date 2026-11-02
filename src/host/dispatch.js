/**
 * 派工与完成唤醒。
 *
 * 派工建的是**普通根会话**（`src/host/worker-sessions.js` 的 `agents.create`），不是
 * subagent：worker 要常驻，也要能被人下钻对话，而宿主的 subagent 结算即销毁、界面
 * 上只读。本模块**不等待** worker 跑完——工具立即返回，父 turn 正常结束，worker 在
 * 后台继续。
 *
 * 完成信号由本模块从会话事件里认：订阅宿主的 `session/event`，在 `turn/end` 那一刻
 * 折叠这一轮的 `assistant/message` 文本与终态。worker 不调用任何工具回报——这与
 * Telov 的 `<subagent-notification>`、以及宿主 subagent 的 `captureLocalResult()`
 * （同样从会话事件折叠产出与 stopReason）是同一个机制：产出与终态都由机制侧取，
 * 模型漏写一句话不会让协调者卡在等待里。
 *
 * 唤醒走 dsh 自带的 agent 入口：`agent.followup()` 会「queue a follow-up turn and
 * wake the driver」，父会话空闲时由此开新 turn。这补上了 dsh 原生缺失的一环：
 * 「worker 结束 → 协调者自动被唤醒并继续」。
 *
 * 完成通知走 **next-turn** 边界（`followup`）：它是「下一个 turn 的一次输入」，
 * 语义上就该排进下一轮，而不是插进协调者当前这一步里。
 *
 * 投递时机是「父会话空闲时」：宿主输入框上方的「消息队列」面板显示的是 inbox 的
 * next-turn 未消费项（`ui-conversation` 的 QueueDock 读 `inbox['next-turn']`）。
 * 协调者正忙时把通知投进去，它就会以「一条待发消息」的形态挂在那里——那是用户的
 * 输入队列，不是后台通知该待的地方。改为忙时先不投（通知留在落盘队列），检测到
 * 空闲再投：投递即被消费，队列面板不会看到它，唤醒时机与排进 next-turn 也几乎
 * 一样（两者都要等当前 turn 结束）。
 *
 * 本模块不新增 session event 类型（仓外插件的硬约束），完成通知走自有落盘队列。
 *
 * 人下钻到 worker 会话直接对话时不经过本模块：那种轮次不会登记在飞记录，也就
 * 不会被结算，worker 不会因为人自己聊了几句去打扰协调者。
 *
 * @module dsh-leader-kit/host/dispatch
 */

import { createUserMessage, blocksToText } from './message.js'
import { workerReportSource } from '../shared/worker-report.js'

const DEFAULT_AUTO_RESUME_LIMIT = 8
/**
 * 未归档 worker 的数量上限。
 *
 * worker 是常驻根会话，不 dispose 就一直活着，所以名册按登记表算：它是续聊的
 * 唯一入口，也是「这个项目还留着多少条工」的唯一真源（宿主的 `sessions.list()`
 * 只反映进程内活着的会话，重启后归零）。到顶后先劝复用（`message_worker` 冷恢复），
 * 不是硬性禁止。
 */
const DEFAULT_ACTIVE_WORKER_LIMIT = 50
const NOTIFICATION_LIMIT = 4000
/** 空闲检测的轮询间隔（毫秒）。 */
const IDLE_POLL_MS = 500

/** 投递结果：已投出。 */
const DELIVERED = 'delivered'
/** 投递结果：可重试——父会话忙、暂时失败或别处正在投同一条。 */
const RETRYABLE = 'retryable'
/** 投递结果：不可重试——已达自动续行上限，再投也是同一个结果。 */
const EXHAUSTED = 'exhausted'

/**
 * 构造完成通知正文。
 * @param {object} record - 派工记录
 * @param {{ ok: boolean, result?: object, error?: unknown }} outcome - 终态
 * @returns {string} 通知正文
 */
export function buildNotificationText(record, outcome) {
  const lines = []
  const status = outcome.ok ? outcome.result?.stopReason ?? 'completed' : 'failed'
  // 正文不带「谁在说话」的前缀：说话人由消息的 source 标记，客户端渲染成
  // 带头像与身份的气泡。前缀写进正文会同时污染模型读的事实与用户看到的界面。
  lines.push(`任务「${record.name}」已结束。`)
  lines.push(`子会话：${record.childId}`)
  lines.push(`状态：${status}`)
  if (!outcome.ok) {
    const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
    lines.push(`失败原因：${reason}`)
  } else {
    const summary = blocksToText(outcome.result?.output ?? [])
    lines.push(summary === '' ? '产物摘要：（worker 未产出文本）' : `产物摘要：\n${summary}`)
  }
  lines.push('下一步：按协调者协议判断验收、返工或派新工。')
  return lines.join('\n').slice(0, NOTIFICATION_LIMIT)
}

/**
 * 构造 worker 最后一次回报的内容（界面渲染用）。
 *
 * 消息正文是给模型读的事实，含会话 id、状态、下一步这些协议字段；界面只渲染
 * worker 真正产出的内容——成功是产物摘要，失败是失败原因。
 *
 * @param {{ ok: boolean, result?: object, error?: unknown }} outcome - 终态
 * @returns {string} 最后一次回报的内容
 */
export function buildWorkerReport(outcome) {
  if (!outcome.ok) {
    const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
    return `失败：${reason}`.slice(0, NOTIFICATION_LIMIT)
  }
  const summary = blocksToText(outcome.result?.output ?? [])
  return (summary === '' ? '（worker 未产出文本）' : summary).slice(0, NOTIFICATION_LIMIT)
}

/**
 * 创建派工与唤醒器。
 *
 * @param {object} options - 选项
 * @param {object} options.ctx - Cordis 上下文
 * @param {object} options.store - 通知落盘队列
 * @param {object} options.workers - worker 登记表（见 `worker-registry.js`）
 * @param {object} options.workerSessions - worker 会话管理器（见 `worker-sessions.js`）
 * @param {object} options.coordinatorIndex - 项目注册表（提供 `awaitIndex` 与 `isCoordinatorSession`）
 * @param {number} [options.autoResumeLimit] - 连续自动续行上限
 * @param {number} [options.activeWorkerLimit] - 未归档 worker 数量上限
 * @param {(parentSessionId: string) => string | undefined} [options.resolveWorkerCwd] - 取 worker 的工作目录
 * @param {() => readonly string[]} [options.archivedSessionIds] - 宿主已归档的会话 id；缺省时不限派工数量
 * @param {(sessionId: string) => Promise<{ cardId: string, number: number, title: string, status: string, slot: string }[]>} [options.listCardBindings] - 会话挂到哪些卡上；缺省时不做投递卡门禁
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {object} 派工器接口
 */
export function createDispatcher({
  ctx,
  store,
  workers,
  workerSessions,
  coordinatorIndex,
  autoResumeLimit = DEFAULT_AUTO_RESUME_LIMIT,
  activeWorkerLimit = DEFAULT_ACTIVE_WORKER_LIMIT,
  resolveWorkerCwd,
  archivedSessionIds,
  listCardBindings,
  logger = () => {},
}) {
  // 派工校验依赖它，漏传就整段静默跳过——宁可装配时报错，也不要悄悄少一道闸。
  if (typeof coordinatorIndex?.awaitIndex !== 'function'
    || typeof coordinatorIndex?.isCoordinatorSession !== 'function') {
    throw new Error('dsh-leader-kit: createDispatcher 缺少 coordinatorIndex，无法校验协调者身份')
  }
  // worker 会话是派工的唯一落点，漏传会让派工在运行到一半时炸。
  if (typeof workerSessions?.spawn !== 'function' || typeof workerSessions?.send !== 'function') {
    throw new Error('dsh-leader-kit: createDispatcher 缺少 workerSessions，无法创建或唤醒 worker 会话')
  }
  /** @type {Map<string, object>} 派工记录，key 为 worker 会话 id */
  const inflight = new Map()
  /** @type {Map<string, string>} 各 worker 本轮的 assistant 文本（同一 turn 取最后一条非空），key 为会话 id */
  const turnText = new Map()
  /** @type {Map<string, number>} 每个父会话的连续自动续行次数 */
  const resumeCounts = new Map()
  /** @type {Set<string>} 本进程注入过的通知消息 id，用于区分外部输入 */
  const injected = new Set()
  /** @type {Set<string>} 已销毁的会话 id。失活的 agent 会静默接受投递，投递前必须排除。 */
  const disposed = new Set()
  /** @type {Map<string, object[]>} 等待父会话空闲的通知，按父会话分组 */
  const waiting = new Map()
  /** @type {ReturnType<typeof setInterval> | undefined} 空闲检测定时器 */
  let idleTimer = undefined
  /** @type {Set<string>} 正在投递的通知 id：同一条通知只投一次。 */
  const delivering = new Set()
  /** @type {boolean} 空闲检测是否正在跑：轮询重入会重复投递，用它当闸门。 */
  let flushing = false
  /** @type {boolean} 插件是否已卸载：卸载后不再起定时器、不再投递。 */
  let closed = false

  /**
   * 解析父会话的 agent。
   *
   * 优先走 `sessionController.resolveAgent()`：它给出活 agent 并确保会话的 inbox
   * 投影处于激活状态。缺失该服务时回退到派工时持有的父 agent 活对象——实测只要
   * 父 agent 尚未被销毁，对空闲 agent 调 `steer()` 就能唤醒它开新 turn。
   *
   * 真正让唤醒落空的是父 agent 已被销毁（headless 一次性 CLI 会在 turn 结束后
   * dispose 会话）。这类通知留在队列里，等父会话重新打开时补投。
   *
   * @param {string} parentSessionId - 父会话 id
   * @param {object} [fallbackAgent] - 派工时持有的父 agent 活对象
   * @returns {Promise<object | undefined>} agent 或 undefined
   */
  async function resolveParentAgent(parentSessionId, fallbackAgent) {
    try {
      const controller = ctx.get('sessionController')
      if (controller !== undefined) {
        const resolved = await controller.resolveAgent(parentSessionId)
        if (!('error' in resolved)) return resolved.agent
      }
    } catch {
      // 服务不可用或解析失败时落到派工时持有的活对象。
    }
    return fallbackAgent
  }

  /**
   * 把一条通知投进父会话的下一个 turn。
   *
   * 走 `followup`：通知是「下一个 turn 的一次输入」，语义上就该排进下一轮。
   *
   * @param {object} notification - 通知记录
   * @param {object} agent - 父会话的 agent 活对象
   * @returns {Promise<string>} 投递结果：`delivered` / `retryable` / `exhausted`
   */
  async function deliverNow(notification, agent) {
    // 幂等闸：轮询重入、补投与轮询并发时，同一条通知只投一次。
    if (delivering.has(notification.id)) return RETRYABLE
    delivering.add(notification.id)
    try {
      return await deliverOnce(notification, agent)
    } finally {
      delivering.delete(notification.id)
    }
  }

  /**
   * 真正投递一条通知（幂等闸之外的部分）。
   *
   * @param {object} notification - 通知记录
   * @param {object} agent - 父会话的 agent 活对象
   * @returns {Promise<string>} 投递结果：`delivered` / `retryable` / `exhausted`
   */
  async function deliverOnce(notification, agent) {
    const used = resumeCounts.get(notification.parentSessionId) ?? 0
    if (used >= autoResumeLimit) {
      // 不可重试：上限不会自己涨，再试一次也是同一个结果。写盘与日志交给调用方，
      // 那里知道还有多少条在等。
      return EXHAUSTED
    }
    const message = createUserMessage(
      [{ type: 'text', text: notification.text }],
      workerReportSource(
        // 本轮改名（label → name）之前落盘的通知只有 label，读旧队列时退回它。
        notification.name ?? notification.label,
        notification.childId,
        // 改造前落盘的记录没有 summary / report / outcome：摘要退回正文首行
        // （与当时的算法一致），回报正文与终态按缺省处理。
        notification.summary ?? notification.text.split('\n')[0] ?? '',
        notification.report ?? '',
        notification.outcome ?? 'completed',
      ),
    )
    injected.add(message.id)
    resumeCounts.set(notification.parentSessionId, used + 1)
    try {
      agent.followup(message)
    } catch (error) {
      // 失活的 agent 会静默接受或直接拒绝投递，通知必须留在队列里等待补投。
      await store.markUndelivered(
        notification.id,
        `投递失败：${error instanceof Error ? error.message : String(error)}`,
      )
      return RETRYABLE
    }
    await store.markDelivered(notification.id)
    return DELIVERED
  }

  /**
   * 记录一条不可重试的投递失败：已达自动续行上限。
   *
   * 原因里带上积压条数——积压本身在界面上没有任何提示，这条记录是唯一的线索。
   *
   * @param {object} notification - 通知记录
   * @param {number} pendingCount - 当前落盘队列里的待投条数
   * @returns {Promise<void>} 写盘完成
   */
  async function markExhausted(notification, pendingCount) {
    const reason = `连续自动续行已达上限 ${autoResumeLimit}，当前有 ${pendingCount} 条完成通知待投`
    await store.markUndelivered(notification.id, reason)
    logger(
      `dsh-leader-kit: 父会话 ${notification.parentSessionId} 的${reason}，`
      + `通知 ${notification.id} 留待人工处理`,
    )
  }

  /**
   * 向父会话投递完成通知。
   *
   * 父会话正忙时不投：通知排在 inbox 的 next-turn 队列里，会以「一条待发消息」的
   * 形态出现在宿主输入框上方的消息队列面板——那是用户的输入队列，不是后台通知
   * 该待的地方。改为留在落盘队列里等空闲，检测到空闲再投：投递即被消费。
   *
   * @param {object} notification - 通知记录
   * @param {object} [parentAgent] - 派工时持有的父 agent 活对象
   * @returns {Promise<string>} 投递结果：`delivered` / `retryable` / `exhausted`
   */
  async function deliver(notification, parentAgent) {
    if (closed) {
      await store.markUndelivered(notification.id, '插件已卸载，等待下次启动后补投')
      return RETRYABLE
    }
    if (disposed.has(notification.parentSessionId)) {
      await store.markUndelivered(notification.id, '父会话已销毁，等待重新打开后补投')
      return RETRYABLE
    }
    const agent = await resolveParentAgent(notification.parentSessionId, parentAgent)
    if (agent === undefined) {
      await store.markUndelivered(notification.id, '父会话当前不可达')
      return RETRYABLE
    }
    if (agent.status !== 'idle') {
      const list = waiting.get(notification.parentSessionId) ?? []
      // 记下当时的 agent 活对象：空闲检测里没有第二个入口能拿到它
      if (!list.some((item) => item.notification.id === notification.id)) {
        list.push({ notification, agent })
      }
      waiting.set(notification.parentSessionId, list)
      await store.markUndelivered(notification.id, '父会话正忙，等待空闲后投递')
      ensureIdleTimer()
      return RETRYABLE
    }
    const result = await deliverNow(notification, agent)
    if (result === EXHAUSTED) {
      await markExhausted(notification, (await store.listPending()).length)
      // 条目留在等待表里并打标记：上限复位后还能重新投，不能就此丢掉。
      const list = waiting.get(notification.parentSessionId) ?? []
      if (!list.some((item) => item.notification.id === notification.id)) {
        list.push({ notification, agent, exhausted: true })
      }
      waiting.set(notification.parentSessionId, list)
    }
    return result
  }

  /**
   * 启动空闲检测定时器。
   * @returns {void}
   */
  function ensureIdleTimer() {
    if (closed) return
    if (idleTimer !== undefined) return
    idleTimer = setInterval(() => {
      if (flushing) return
      flushing = true
      void flushWaiting()
        .catch((error) => {
          // 读盘失败等异常必须在这里兜住：宿主对未处理拒绝是致命退出（proc.exit(1)），
          // 一次磁盘抖动不该带走整个 dsh 进程。
          logger(`dsh-leader-kit: 空闲检测失败：${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => {
          flushing = false
        })
    }, IDLE_POLL_MS)
    // 空闲检测不该拖住进程退出：dsh 退出时通知仍在落盘队列里，重启后补投。
    idleTimer.unref?.()
  }

  /**
   * 把等待中的通知投给已经空闲的父会话。
   *
   * 投递前先看通知还在不在落盘队列里：父会话重新打开时补投通道（`redeliverPending`）
   * 可能已经投过同一条，重复投会让协调者收到两遍。
   *
   * @returns {Promise<void>} 处理完成
   */
  async function flushWaiting() {
    // 全是「已达上限、等人工介入复位」的条目时不必读盘：轮询只是等上限复位。
    const hasWork = [...waiting.values()].some((list) => list.some((item) => item.exhausted !== true))
    if (!hasWork) return
    const pending = await store.listPending()
    for (const [parentSessionId, list] of [...waiting]) {
      // 先摘后投：投递期间等待表里没有这些条目，轮询重入也拿不到同一条。
      waiting.delete(parentSessionId)
      /** 已达上限、等人工介入复位的条目：不投、不写盘、不记日志，但留在表里。 */
      const kept = []
      const remaining = []
      for (const item of list) {
        if (item.exhausted === true) {
          kept.push(item)
          continue
        }
        const { notification } = item
        if (!pending.some((entry) => entry.id === notification.id)) continue
        const agent = await resolveParentAgent(parentSessionId, item.agent)
        if (agent === undefined || agent.status !== 'idle') {
          remaining.push(item)
          continue
        }
        const result = await deliverNow(notification, agent)
        if (result === RETRYABLE) {
          remaining.push(item)
          continue
        }
        if (result === EXHAUSTED) {
          // 不可重试：再投一次也是同一个结果。条目留在等待表里并打标记——
          // 上限复位后（用户开口）还要能重新投出去，不能就此丢掉。
          await markExhausted(notification, pending.length)
          kept.push({ ...item, exhausted: true })
          continue
        }
      }
      if (kept.length > 0 || remaining.length > 0) {
        // 合并而不是覆盖：投递期间新到的通知也在这个等待表里。
        waiting.set(parentSessionId, [
          ...kept,
          ...remaining,
          ...(waiting.get(parentSessionId) ?? []),
        ])
      }
    }
    if (waiting.size === 0 && idleTimer !== undefined) {
      clearInterval(idleTimer)
      idleTimer = undefined
    }
  }

  /**
   * 落盘一条完成通知。首轮与续聊轮共用：通知形态、投递时机、护栏都一样。
   *
   * 落盘与投递分开：落盘是结算的判据（写进队列就再也不会丢），投递失败的通知
   * 留在队列里由空闲检测或补投通道处理。
   *
   * @param {object} record - 通知记录源（首轮派工记录或续聊登记）
   * @param {{ ok: boolean, result?: object, error?: unknown }} outcome - 终态
   * @returns {Promise<object>} 已落盘的通知记录
   */
  async function emitNotification(record, outcome) {
    const text = buildNotificationText(record, outcome)
    const notification = {
      id: `note-${record.childId}-${record.startedAt}`,
      childId: record.childId,
      parentSessionId: record.parentSessionId,
      name: record.name,
      text,
      summary: text.split('\n')[0] ?? '',
      report: buildWorkerReport(outcome),
      outcome: outcome.ok ? 'completed' : 'failed',
      createdAt: Date.now(),
      attempts: 0,
    }
    await store.enqueue(notification)
    return notification
  }

  /**
   * 未归档 worker 的名册概况。
   *
   * @returns {Promise<{ total: number, idle: object[] } | null>} 名册；拿不到归档集合时 null（此时不限数量）
   */
  async function describeRoster() {
    if (typeof archivedSessionIds !== 'function') return null
    const archived = new Set(archivedSessionIds())
    const active = (await workers.list()).filter((item) => !archived.has(item.childId))
    return {
      total: active.length,
      // 在跑的记录不算可复用：它这一轮还没回报完，再投一条只会排在后面。
      idle: active.filter((item) => !inflight.has(item.childId)),
    }
  }

  /**
   * 投递卡门禁：worker 挂着未完成的卡时，只允许同卡续跑。
   *
   * 我们的槽位绑定是「卡 → 槽位 → 会话」的投影，一个会话可能被多张卡绑到不同
   * 槽位上，所以按「任一 active 卡匹配」放行，而不是只看最新那张。挂 done /
   * archived 卡、或者不挂卡时不拦——那时卡已经不是它当前在服务的工作。
   *
   * @param {string} sessionId - worker 会话 id
   * @param {string | undefined} cardId - 本次投递声明的卡
   * @returns {Promise<void>} 门禁通过
   */
  async function assertCardGateOpen(sessionId, cardId) {
    if (typeof listCardBindings !== 'function') return
    const active = (await listCardBindings(sessionId)).filter((item) => item.status === 'active')
    if (active.length === 0) return
    if (cardId !== undefined && active.some((item) => item.cardId === cardId)) return
    const refs = active
      .map((item) => `#${item.number} ${item.title}（cardId: ${item.cardId}，槽位 ${item.slot}）`)
      .join('、')
    const way = '同卡续跑：带 cardId 重发本消息；该卡已完成：先 update_card 标 done 再投递；新任务：spawn_worker 新建 worker 并把卡槽位绑到它。'
    if (cardId === undefined) {
      throw new Error(`message_worker: worker ${sessionId} 挂着未完成的卡 ${refs}，本次投递未声明同卡，已拒绝：挂未完成卡的 worker 不得接别的工作，否则会话同时服务两张卡、产物会落错卡。${way}`)
    }
    throw new Error(`message_worker: worker ${sessionId} 挂着的卡（${refs}）与本次声明的 cardId（${cardId}）不一致：一张卡一条会话，跨卡投递会把产物落错卡。${way}`)
  }

  /**
   * 校验调用方当前仍是项目协调者。
   *
   * 工具面在 `agent/created` 一次性裁，而换协调者不会重建旧会话：退役的那个会话
   * 手里仍留着 `message_worker` / `list_cards`，直到进程重启才按普通会话重裁。
   * 所以「换下的协调者不再能指挥」只能落在调用时再判一次身份。
   *
   * 判定先等一次索引重建结果：`isCoordinatorSession()` 在索引未就绪时一律放行
   * （那是为了协调者首轮不至于没有工具），而放行意味着**任何**会话都被认成协调者。
   * 高危操作不能建立在这个宽松判定上，读不出来就拒绝。
   *
   * @param {object} parent - 调用方 agent
   * @param {object} messages - 报错正文
   * @param {string} messages.pending - 索引读不出时的报错正文
   * @param {string} messages.refused - 调用方不是协调者时的报错正文
   * @returns {Promise<void>} 校验通过
   */
  async function assertCoordinator(parent, { pending, refused }) {
    const ready = await coordinatorIndex.awaitIndex()
    if (!ready) throw new Error(pending)
    if (!coordinatorIndex.isCoordinatorSession(parent?.id)) throw new Error(refused)
  }

  /**
   * 给已派出的 worker 发后续消息。
   *
   * 会话还在内存时消息直接投进去（并入当前执行）；进程重启后会话不在内存，先
   * `agents.resume` 冷恢复再投。两种形态对调用方是同一步，只是回执码不同。
   *
   * @param {object} options - 续聊参数
   * @param {object} options.parent - 调用方 agent（宿主要求精确活对象）
   * @param {string} options.sessionId - worker 会话 id
   * @param {string} options.message - 消息正文
   * @param {string} [options.name] - 顺手改的 worker 显示名
   * @param {string} [options.cardId] - 本次投递声明的卡；worker 挂着未完成的卡时必填
   * @param {AbortSignal} options.signal - 取消信号
   * @returns {Promise<{ code: 'merged' | 'sent', name: string }>} 投递结果与 worker 显示名
   */
  async function message({ parent, sessionId, message, name, cardId, signal }) {
    // 换人之后原班 worker 归新协调者指挥：退役会话不能借「我是它的父会话」
    // 继续下指令。
    await assertCoordinator(parent, {
      pending: 'message_worker: 项目注册表尚未读出，无法确认协调者身份，暂不能给 worker 发消息',
      refused: 'message_worker: 只有项目协调者能给 worker 发消息——这个会话已不是任何项目的协调者（换下的协调者降级为项目里的普通会话）',
    })
    // 卡门禁：在跑的 worker 也不能被拉去干别的卡，否则同一条会话会把两卡的
    // 产物混在一起。
    await assertCardGateOpen(sessionId, cardId)
    const worker = await workers.get(sessionId)
    if (worker === undefined) {
      throw new Error(`message_worker: 没有会话 ${sessionId} 的派工记录，它不是本协调体系派出的 worker`)
    }
    if (worker.parentSessionId !== parent.id) {
      throw new Error('message_worker: 该 worker 是别的会话派的，不能跨会话给它发消息')
    }
    const displayName = name ?? (typeof worker.name === 'string' ? worker.name : sessionId)
    // worker 活着就直接投，不在内存就冷恢复后再投——两种形态对调用方是同一步。
    const form = await workerSessions.send({
      sessionId,
      text: message,
      name,
      parentSessionId: parent.id,
      signal,
    })
    // 这一轮由协调者发起：登记在飞记录，worker 的 `turn/end` 到来时据此结算。
    // 人自己下钻跟 worker 聊的轮次不走这里，也就不会打扰协调者。
    inflight.set(sessionId, {
      childId: sessionId,
      parentSessionId: parent.id,
      parent,
      name: displayName,
      startedAt: Date.now(),
    })
    if (name !== undefined) {
      try {
        await workers.rename(sessionId, name)
      } catch (error) {
        // 消息已经投进 worker 了，改名落盘失败不该让调用方以为投递失败。
        logger(`dsh-leader-kit: worker ${sessionId} 登记表改名失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { code: form === 'resumed' ? 'sent' : 'merged', name: displayName }
  }

  /**
   * 派一个 worker。立即返回，不等待 worker 完成。
   *
   * @param {object} options - 派工参数
   * @param {object} options.parent - 发起派工的父 agent
   * @param {string} options.initialMessage - 交给 worker 的任务正文
   * @param {string} options.name - worker 显示名
   * @param {string} [options.force] - 名册到顶时的逃逸理由；非空才放行新建
   * @param {AbortSignal} options.signal - 取消信号
   * @returns {Promise<object>} 派工记录
   */
  async function dispatch({ parent, initialMessage, name, force, signal }) {
    // 派工是唯一会真的拉起一个会话的操作，身份判定必须比工具面严一档。
    await assertCoordinator(parent, {
      pending: 'spawn_worker: 项目注册表尚未读出，无法确认协调者身份，暂不能派工',
      refused: 'spawn_worker: 只有项目协调者能派工，请在左栏项目区块建项目并进入协调者会话',
    })
    // 续聊是 worker 的既定能力：缺持久化后端（日志不落盘）或查询后端（冷恢复
    // 读不了日志）时 worker 只能跑一轮，拒绝派工而不是静默降级成一次性 worker。
    if (ctx.get('sessionPersistence') === undefined) {
      throw new Error('dsh-leader-kit: 当前组合缺少会话持久化后端，worker 无法续聊，拒绝派工')
    }
    if (ctx.get('sessionQuery') === undefined) {
      throw new Error('dsh-leader-kit: 当前组合缺少会话查询后端，worker 无法冷恢复续聊，拒绝派工')
    }
    // 名册上限：到顶先劝复用——已派出的 worker 都能冷恢复，新建只在确实需要
    // 一条干净上下文时才值得。`force` 非空是明确的逃逸声明，理由随工具调用进
    // 会话历史，可审计。
    if (typeof force !== 'string' || force.trim() === '') {
      const roster = await describeRoster()
      if (roster !== null && roster.total >= activeWorkerLimit) {
        const candidates = roster.idle.slice(0, 10)
        throw new Error([
          `spawn_worker: 未归档的 worker 已达上限 ${activeWorkerLimit}，本次未新建。`,
          candidates.length === 0
            ? '当前没有可复用的 worker（都在跑）：等它们结算后再派，或归档不再需要的会话。'
            : `可复用的 worker（当前不在跑，用 message_worker 投递新简报即可，可带 rename 换角色）：\n${
              candidates.map((item) => `- ${item.childId} ${item.name ?? item.label ?? ''}`.trimEnd()).join('\n')
            }`,
          '确实要新建：传 force 说明为什么现有 worker 都不适合。',
        ].join('\n'))
      }
    }
    // worker 的工作目录由项目决定：协调者不能指定 worker 跑在哪，也不该让
    // worker 跑到项目外面去。项目目录是绝对路径，worker 会话直接采用。
    const cwd = resolveWorkerCwd?.(parent.id)
    const childId = await workerSessions.spawn({
      cwd,
      name,
      initialMessage,
      parentSessionId: parent.id,
      signal,
    })
    const record = {
      childId,
      parentSessionId: parent.id,
      parent,
      name,
      task: initialMessage,
      startedAt: Date.now(),
    }
    inflight.set(record.childId, record)
    // 派工落登记表：协调者可能在任何时刻（含本进程重启后）续聊，归属与父会话
    // 映射不能只活在内存里。
    try {
      await workers.register({
        childId: record.childId,
        parentSessionId: parent.id,
        name,
        task: initialMessage,
      })
    } catch (error) {
      logger(`dsh-leader-kit: worker ${record.childId} 登记失败，续聊与归属查询会落空：${error instanceof Error ? error.message : String(error)}`)
    }
    return record
  }

  /**
   * 把宿主的轮次结束原因写成一句能读的失败原因。
   *
   * 失败时摘要用终态原因而不是产物：失败轮次里的 assistant 文本往往只写到一半，
   * 拿它当摘要会让协调者以为这一轮做了不少事。
   *
   * @param {object} reason - `turn/end` 的 `reason`
   * @returns {string} 失败原因
   */
  function describeTurnFailure(reason) {
    switch (reason?.kind) {
      // `aborted.reason` 是对象（`{ kind: 'user' | 'parent' | 'hook' | … }`），
      // 直接插值会渲染成 `[object Object]`——给协调者看的就是这句原因。
      case 'aborted': return `被取消：${reason.reason?.kind ?? '未说明原因'}`
      case 'blocked': return '被阻断：这一轮被宿主拦下，没有开始'
      case 'max-tokens': return '输出达到 token 上限，这一轮没有正常收尾'
      case 'error': return `失败：${reason.error?.message ?? '未知错误'}`
      default: return `这一轮没有正常结束（${reason?.kind ?? '未知原因'}）`
    }
  }

  /**
   * 结算一个 worker 的轮次：把这一轮的产物或失败原因交给协调者。
   *
   * 产出取这一轮的 `assistant/message`，终态取 `turn/end` 的 `reason`——与宿主
   * subagent 的 `captureLocalResult()` 同源，不依赖 worker 主动交付。
   *
   * @param {string} sessionId - worker 会话 id
   * @param {object} reason - `turn/end` 的 `reason`
   * @returns {Promise<boolean>} 是否确实结算了一条在飞的派工/续聊
   */
  async function settleTurn(sessionId, reason) {
    const record = inflight.get(sessionId)
    if (record === undefined) {
      turnText.delete(sessionId)
      return false
    }
    // 摘要与终态在第一次结算时冻结进记录：落盘失败后下一轮结束时重试的必须是
    // **这一轮**的产物，不能被下一轮的 assistant 文本覆盖。
    if (record.summary === undefined) {
      record.outcome = reason?.kind === 'completed' ? 'completed' : 'failed'
      record.summary = record.outcome === 'completed'
        ? turnText.get(sessionId) ?? ''
        : describeTurnFailure(reason)
    }
    const judged = record.outcome === 'completed'
      ? { ok: true, result: { stopReason: 'completed', output: [{ type: 'text', text: record.summary }] } }
      : { ok: false, error: new Error(record.summary) }
    // 落盘即结算成功：通知进了队列就不会丢。落盘失败时记录（连同冻结的摘要）
    // 还在，这个 worker 下一轮结束时再结算同一份内容；`enqueue` 按 id 幂等，
    // 重试不会多出一条通知。
    const notification = await emitNotification(record, judged)
    inflight.delete(sessionId)
    turnText.delete(sessionId)
    try {
      await deliver(notification, record.parent)
    } catch (error) {
      // 已经落盘：投递失败留给空闲检测与补投通道，一次 IO 抖动不能让这一轮
      // 重结算一遍（那会再唤醒父会话一次，且第二条正文是新一轮的产物）。
      logger(`dsh-leader-kit: 投递 worker ${sessionId} 的完成通知失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return true
  }

  /**
   * 观察会话事件，在 worker 的轮次边界上结算。
   *
   * 一个 turn 是 `agent.run()` 的一次调用（内部含多个 step），正好等于「协调者派的
   * 这一轮」。人直接跟 worker 聊的轮次不进 `inflight`，因此不会被结算。
   *
   * @param {object} session - 追加事件的会话
   * @param {object} event - 刚追加的会话事件
   * @returns {Promise<unknown> | undefined} 结算 promise（只有 `turn/end` 有），
   *   供测试等待；宿主的 `session/event` 是 fire-and-forget，会忽略返回值
   */
  function observeTurn(session, event) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return undefined
    if (event?.type === 'assistant/message') {
      if (!inflight.has(sessionId)) return undefined
      const text = blocksToText(event.data?.message?.content)
      if (text !== '') turnText.set(sessionId, text)
      return undefined
    }
    if (event?.type !== 'turn/end') return undefined
    // 宿主会接住并记下观察者的异常，但那条日志混在宿主日志里查不出来源；自己接住，
    // 才能把「回报没送到」记成这条链上的失败。
    return settleTurn(sessionId, event.data?.reason).catch((error) => {
      logger(`dsh-leader-kit: 结算 worker ${sessionId} 的轮次失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    })
  }

  // cordis 的 Context 永远有 `on`（返回 disposer），所以这里不做出厂能力探测：
  // 订阅不到事件只可能是宿主低于 `engines.dsh` 下限（rc.2 已提供 `session/event`
  // 与 `turn/end`），那是版本契约问题，不是装配期能判定的事。
  const stopTurns = ctx.on('session/event', (session, event) => observeTurn(session, event))

  return {
    dispatch,
    message,

    /**
     * 补投队列里属于某个父会话的通知。
     *
     * 父会话重新打开时由宿主把 agent 活对象交过来——这是补投唯一可靠的入口：
     * `agents` 注册表在根作用域不可见。
     *
     * @param {object} agent - 父会话的 agent 活对象
     * @returns {Promise<number>} 成功补投的条数
     */
    async redeliverPending(agent) {
      const pending = await store.listPending()
      let delivered = 0
      for (const notification of pending) {
        if (notification.parentSessionId !== agent.id) continue
        if (await deliver(notification, agent) === DELIVERED) delivered += 1
      }
      // 补投通道已经处理过这个父会话的待投通知，等待表里的同一批不要再留
      if (delivered > 0) waiting.delete(agent.id)
      return delivered
    },

    /**
     * 释放定时器。
     * @returns {void}
     */
    dispose() {
      closed = true
      // 卸载后不再有派工：留着订阅会继续替已死记录结算，也会让宿主持住这个模块。
      stopTurns()
      turnText.clear()
      if (idleTimer !== undefined) {
        clearInterval(idleTimer)
        idleTimer = undefined
      }
      waiting.clear()
    },

    /**
     * 外部输入抵达时重置该父会话的自动续行计数——人工介入后护栏应重新开始计数。
     * @param {string} parentSessionId - 父会话 id
     * @returns {void}
     */
    resetResumeCount(parentSessionId) {
      resumeCounts.delete(parentSessionId)
      // 上限复位了，此前被标记为「已达上限」的条目要能重新投：清掉标记，
      // 并让空闲检测重新跑起来。
      const list = waiting.get(parentSessionId)
      if (list === undefined) return
      let released = false
      const next = list.map((item) => {
        if (item.exhausted !== true) return item
        released = true
        return { ...item, exhausted: false }
      })
      if (!released) return
      waiting.set(parentSessionId, next)
      ensureIdleTimer()
    },

    /**
     * 记录本进程注入的通知 id，供外部输入识别使用。
     * @param {string} messageId - 消息 id
     * @returns {void}
     */
    markInjected(messageId) {
      injected.add(messageId)
    },

    /**
     * 判断一条注入消息是否来自本进程。
     * @param {string} messageId - 消息 id
     * @returns {boolean} 是否为本进程注入
     */
    isInjected(messageId) {
      return injected.has(messageId)
    },

    /**
     * 当前在飞的派工数。
     * @returns {number} 在飞数量
     */
    inflightCount() {
      return inflight.size
    },

    /**
     * 记录会话已销毁。
     * @param {string} sessionId - 会话 id
     * @returns {void}
     */
    markDisposed(sessionId) {
      disposed.add(sessionId)
    },

    /**
     * 记录会话已重新注册。
     * @param {string} sessionId - 会话 id
     * @returns {void}
     */
    markAlive(sessionId) {
      disposed.delete(sessionId)
    },
  }
}
