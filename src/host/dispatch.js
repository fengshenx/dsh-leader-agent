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
 * 外部编排工具的 `<subagent-notification>`、以及宿主 subagent 的 `captureLocalResult()`
 * （同样从会话事件折叠产出与 stopReason）是同一个机制：产出与终态都由机制侧取，
 * 模型漏写一句话不会让 leader 卡在等待里。
 *
 * 唤醒走 dsh 自带的 agent 入口：`agent.followup()` 会「queue a follow-up turn and
 * wake the driver」，父会话空闲时由此开新 turn。这补上了 dsh 原生缺失的一环：
 * 「worker 结束 → leader 自动被唤醒并继续」。
 *
 * 完成通知走 **next-turn** 边界（`followup`）：它是「下一个 turn 的一次输入」，
 * 语义上就该排进下一轮，而不是插进 leader 当前这一步里。
 *
 * 投递时机是「父会话空闲时」：宿主输入框上方的「消息队列」面板显示的是 inbox 的
 * next-turn 未消费项（`ui-conversation` 的 QueueDock 读 `inbox['next-turn']`）。
 * leader 正忙时把通知投进去，它就会以「一条待发消息」的形态挂在那里——那是用户的
 * 输入队列，不是后台通知该待的地方。改为忙时先不投（通知留在落盘队列），检测到
 * 空闲再投：投递即被消费，队列面板不会看到它，唤醒时机与排进 next-turn 也几乎
 * 一样（两者都要等当前 turn 结束）。
 *
 * 本模块不新增 session event 类型（仓外插件的硬约束），完成通知走自有落盘队列。
 *
 * 人下钻到 worker 会话直接对话时不经过本模块：那种轮次不会登记在飞记录，也就
 * 不会被结算，worker 不会因为人自己聊了几句去打扰 leader。
 *
 * @module dsh-leader-agent/host/dispatch
 */

import { createUserMessage } from './message.js'
import { messageText } from '../shared/message-text.js'
import { foldTurns, renderTranscript } from './worker-transcript.js'
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
    const summary = messageText(outcome.result?.output ?? [])
    lines.push(summary === '' ? '产物摘要：（worker 未产出文本）' : `产物摘要：\n${summary}`)
  }
  lines.push('下一步：按 leader 协议判断验收、返工或派新工。')
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
  // 气泡按 Markdown 渲染：块间要空行，单个 \n 是软换行，多块会被折成一段。
  const summary = messageText(outcome.result?.output ?? [], '\n\n')
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
 * @param {object} options.leaderIndex - 项目注册表（提供 `awaitIndex` 与 `isLeaderSession`）
 * @param {number} [options.autoResumeLimit] - 连续自动续行上限
 * @param {number} [options.activeWorkerLimit] - 未归档 worker 数量上限
 * @param {(parentSessionId: string) => string | undefined} [options.resolveWorkerCwd] - 取 worker 的工作目录
 * @param {() => readonly string[]} [options.archivedSessionIds] - 宿主已归档的会话 id；缺省时不限派工数量
 * @param {(sessionId: string) => Promise<{ cardId: string, number: number, title: string, status: string, slot: string }[]>} [options.listCardBindings] - 会话挂到哪些卡上；缺省时不做投递卡门禁
 * @param {() => Promise<Map<string, { cardId: string, number: number, title: string, status: string, slot: string }[]>>} [options.cardBindingsBySession] - 一次读盘取全部会话的绑定；名册用它避免逐 worker 读卡
 * @param {(input: { cardId: string, slot: string, sessionId: string }) => Promise<object>} [options.bindCardSlot] - 派工时把卡槽位绑到新会话；缺省时传了 cardId 就报错
 * @param {(sessionId: string | undefined) => Promise<object | undefined>} [options.resolveProject] - 调用方会话所属项目；与 `getCard` 一起校验绑卡归属
 * @param {(cardId: string) => Promise<object | undefined>} [options.getCard] - 按 id 读卡；派工绑卡前校验归属与状态
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {object} 派工器接口
 */
export function createDispatcher({
  ctx,
  store,
  workers,
  workerSessions,
  leaderIndex,
  autoResumeLimit = DEFAULT_AUTO_RESUME_LIMIT,
  activeWorkerLimit = DEFAULT_ACTIVE_WORKER_LIMIT,
  resolveWorkerCwd,
  archivedSessionIds,
  listCardBindings,
  cardBindingsBySession,
  bindCardSlot,
  resolveProject,
  getCard,
  logger = () => {},
}) {
  // 派工校验依赖它，漏传就整段静默跳过——宁可装配时报错，也不要悄悄少一道闸。
  if (typeof leaderIndex?.awaitIndex !== 'function'
    || typeof leaderIndex?.isLeaderSession !== 'function') {
    throw new Error('dsh-leader-agent: createDispatcher 缺少 leaderIndex，无法校验 leader 身份')
  }
  // worker 会话是派工的唯一落点，漏传会让派工在运行到一半时炸。
  if (typeof workerSessions?.spawn !== 'function' || typeof workerSessions?.send !== 'function') {
    throw new Error('dsh-leader-agent: createDispatcher 缺少 workerSessions，无法创建或唤醒 worker 会话')
  }
  // 绑卡归属校验要同时读调用方项目与卡片；只给一半会静默少一道闸。
  if ((typeof resolveProject === 'function') !== (typeof getCard === 'function')) {
    throw new Error('dsh-leader-agent: createDispatcher 的 resolveProject 与 getCard 必须成对提供，否则跨项目绑卡校验会静默失效')
  }
  /** @type {Map<string, object>} 派工记录，key 为 worker 会话 id */
  const inflight = new Map()
  /**
   * 本进程派出的 worker 归属，key 为会话 id。
   *
   * 派工两段化后，第一条消息要过 `message` 的归属校验，而那条校验原本只读落盘
   * 登记表。登记失败（磁盘满等）时会话已经建好、同一轮里还要立刻投递，不能因为
   * 落盘失败就拒绝这次投递。登记表仍是跨进程的真源，这里只补本进程的窗口。
   *
   * @type {Map<string, { parentSessionId: string, name: string }>}
   */
  const owners = new Map()
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
      `dsh-leader-agent: 父会话 ${notification.parentSessionId} 的${reason}，`
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
          logger(`dsh-leader-agent: 空闲检测失败：${error instanceof Error ? error.message : String(error)}`)
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
   * 可能已经投过同一条，重复投会让 leader 收到两遍。
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
    // 绑定一次读盘取全量再分组：逐 worker 读 `cards.json` 会让一次派工付 O(N × 文件体积)。
    // 两个提供方都没有时不做分类，与投递门禁的降级口径一致。
    let bindingsFor
    if (typeof cardBindingsBySession === 'function') {
      const all = await cardBindingsBySession()
      bindingsFor = (sessionId) => all.get(sessionId) ?? []
    } else if (typeof listCardBindings === 'function') {
      bindingsFor = (sessionId) => listCardBindings(sessionId)
    }
    /** 空闲但挂着未完成卡的 worker：不能接新活，关闭卡后槽位才会释放。 */
    const bound = []
    const idle = []
    for (const item of active) {
      // 在跑的记录不算可复用：它这一轮还没回报完，再投一条只会排在后面。
      if (inflight.has(item.childId)) continue
      const cards = bindingsFor === undefined
        ? []
        : (await bindingsFor(item.childId)).filter((binding) => binding.status === 'active')
      if (cards.length > 0) {
        bound.push({ ...item, cards })
        continue
      }
      idle.push(item)
    }
    return { total: active.length, idle, bound }
  }

  /**
   * 投递卡门禁：worker 挂着未完成的卡时，只允许同卡续跑。
   *
   * 我们的槽位绑定是「卡 → 槽位 → 会话」的投影，同一个会话可能被多张卡绑到
   * 不同槽位上。挂 done / archived 卡、或者不挂卡时不拦——那时卡已经不是它
   * 当前在服务的工作。
   *
   * 同时挂多张 `active` 卡是必须拦下的坏状态：它意味着会话在并行服务多条
   * 工作线，产物无从归属，而角色槽位注入本来就只按一张卡算（`slotIndex` 后绑
   * 胜出），上下文与实际服务对象已经不一致。只有整卡替换 `slots` 才会造成这种
   * 状态，正常派工与关卡释放都不会。
   *
   * @param {string} sessionId - worker 会话 id
   * @param {string | undefined} cardId - 本次投递声明的卡
   * @returns {Promise<void>} 门禁通过
   */
  async function assertCardGateOpen(sessionId, cardId) {
    if (typeof listCardBindings !== 'function') return
    const active = (await listCardBindings(sessionId)).filter((item) => item.status === 'active')
    if (active.length === 0) return
    const refs = active
      .map((item) => `#${item.number} ${item.title}（cardId: ${item.cardId}，槽位 ${item.slot}）`)
      .join('、')
    if (active.length > 1) {
      throw new Error(`message_worker: worker ${sessionId} 同时挂着 ${active.length} 张未完成的卡（${refs}），无法判断这次产物属于哪一张，已拒绝投递：先用 update_card 关掉多余的卡（done / archived 会释放槽位上的执行者），只留一张 active 卡再派活。`)
    }
    if (cardId !== undefined && active[0].cardId === cardId) return
    const way = '同卡续跑：带 cardId 重发本消息；该卡已完成：先 update_card 标 done（会释放槽位上的执行者）再投递；新任务：spawn_worker 新建 worker 并把卡槽位绑到它。'
    if (cardId === undefined) {
      throw new Error(`message_worker: worker ${sessionId} 挂着未完成的卡 ${refs}，本次投递未声明同卡，已拒绝：挂未完成卡的 worker 不得接别的工作，否则会话同时服务两张卡、产物会落错卡。${way}`)
    }
    throw new Error(`message_worker: worker ${sessionId} 挂着的卡（${refs}）与本次声明的 cardId（${cardId}）不一致：一张卡一条会话，跨卡投递会把产物落错卡。${way}`)
  }

  /**
   * 校验调用方当前仍是项目 leader。
   *
   * 工具面在 `agent/created` 一次性裁，而换 leader 不会重建旧会话：退役的那个会话
   * 手里仍留着 `message_worker` / `list_cards`，直到进程重启才按普通会话重裁。
   * 所以「换下的 leader 不再能指挥」只能落在调用时再判一次身份。
   *
   * 判定先等一次索引重建结果：`isLeaderSession()` 在索引未就绪时一律放行
   * （那是为了 leader 首轮不至于没有工具），而放行意味着**任何**会话都被认成 leader。
   * 高危操作不能建立在这个宽松判定上，读不出来就拒绝。
   *
   * @param {object} parent - 调用方 agent
   * @param {object} messages - 报错正文
   * @param {string} messages.pending - 索引读不出时的报错正文
   * @param {string} messages.refused - 调用方不是 leader 时的报错正文
   * @returns {Promise<void>} 校验通过
   */
  async function assertLeader(parent, { pending, refused }) {
    const ready = await leaderIndex.awaitIndex()
    if (!ready) throw new Error(pending)
    if (!leaderIndex.isLeaderSession(parent?.id)) throw new Error(refused)
  }

  /**
   * 派工绑卡前的归属与状态校验。
   *
   * 与 `update_card` 同口径：卡有归属时，调用方所属项目必须与它一致；无归属的
   * 存量卡不拦（没有归属可冲突）。`bindSlot` 自己只看得见「卡在不在、是不是
   * 归档」，拿不到调用方是谁——跨项目写会作废对方持有的 `expectedRevision`，
   * 还会让 A 项目的 worker 每轮上下都带着 B 项目的 spec 全文。
   *
   * 已关闭（done）的卡同样拒绝：关闭即释放执行者，再把它绑到新会话会让门禁按
   * `active` 过滤时看不见这条绑定，worker 却能靠 `cardIndex` 继续读到卡的事实。
   * 归档是终态，另有一条更明确的报错。
   *
   * @param {string} cardId - 卡片 id
   * @param {object} parent - 发起派工的父 agent
   * @returns {Promise<void>} 校验通过
   */
  async function assertCardAssignable(cardId, parent) {
    if (typeof getCard !== 'function') return
    const card = await getCard(cardId)
    if (card === undefined) throw new Error(`spawn_worker: 卡片 ${cardId} 不存在`)
    if (card.status === 'archived') {
      throw new Error(`spawn_worker: 卡片 ${cardId} 已归档，归档是终态，不能再绑执行者`)
    }
    if (card.status === 'done') {
      throw new Error(`spawn_worker: 卡片 ${cardId} 已关闭（done），关闭即释放执行者，不能再绑新 worker；要重新指派请先 update_card 把状态改回 active`)
    }
    const project = await resolveProject?.(parent?.id)
    const owner = typeof card.projectId === 'string' ? card.projectId : ''
    const scope = typeof project?.id === 'string' ? project.id : ''
    if (owner !== '' && owner !== scope) {
      throw new Error(`spawn_worker: 卡片 ${cardId} 属于另一个项目，不能跨项目把它绑给 worker；请用本项目的卡片，或让那个项目的 leader 派工`)
    }
  }

  /**
   * 给已派出的 worker 发后续消息。
   *
   * 会话还在内存时消息直接投进它的当前轮次（下一步注入，空闲即开工）；进程重启后
   * 会话不在内存，先 `agents.resume` 冷恢复再投。两种形态对调用方是同一步，只是
   * 回执码不同。
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
    // 退役会话不能借「我是它的父会话」继续下指令：换人时登记表里的归属已经改投
    // 新 leader（见 `leader-handover`），这道身份校验挡的是「换人之前就在飞」
    // 的那个会话本身。
    await assertLeader(parent, {
      pending: 'message_worker: 项目注册表尚未读出，无法确认 leader 身份，暂不能给 worker 发消息',
      refused: 'message_worker: 只有项目 leader 能给 worker 发消息——这个会话已不是任何项目的 leader（换下的 leader 降级为项目里的普通会话）',
    })
    // 卡门禁：在跑的 worker 也不能被拉去干别的卡，否则同一条会话会把两卡的
    // 产物混在一起。
    await assertCardGateOpen(sessionId, cardId)
    // 登记表是跨进程真源；本进程刚派出、登记落盘失败的会话靠 `owners` 兜底，
    // 否则同一个 leader 在本轮里都投不进自己刚建的 worker。
    const worker = await workers.get(sessionId) ?? owners.get(sessionId)
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
    // 这一轮由 leader 发起：登记在飞记录，worker 的 `turn/end` 到来时据此结算。
    // 人自己下钻跟 worker 聊的轮次不走这里，也就不会打扰 leader。
    const previous = inflight.get(sessionId)
    const record = {
      childId: sessionId,
      parentSessionId: parent.id,
      parent,
      name: displayName,
      task: message,
      startedAt: Date.now(),
    }
    // 并入当前轮时承接本轮已产出的文本；旧记录若已冻结（summary 非空）说明
    // 那一轮已结束、正在结算，新消息属于下一轮，不能继承旧产物。
    if (previous?.summary === undefined && previous?.text !== undefined) record.text = previous.text
    inflight.set(sessionId, record)
    if (name !== undefined) {
      try {
        await workers.rename(sessionId, name)
      } catch (error) {
        // 消息已经投进 worker 了，改名落盘失败不该让调用方以为投递失败。
        logger(`dsh-leader-agent: worker ${sessionId} 登记表改名失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { code: form === 'resumed' ? 'sent' : 'merged', name: displayName }
  }

  /**
   * 读一个 worker 会话最近的回合内容。
   *
   * 与完成通知的分工：通知只说「这一轮结束了、产物是什么」；这里回看它是怎么做
   * 的——中间调了哪些工具、哪一步失败、失败原因是什么。读取走宿主的
   * `sessionQuery.readSession()`（完整事件数组，live 会话读内存快照），不唤醒
   * worker、不产生模型调用。
   *
   * 归属判据与 `message` 同一套：登记表是跨进程真源，本进程的 `owners` 补窗口。
   * 身份校验与派工同档——退役 leader 手里仍留着这个工具，不能在调用时放行。
   *
   * @param {object} options - 读取参数
   * @param {object} options.parent - 调用方 agent
   * @param {string} options.sessionId - worker 会话 id
   * @param {number} options.turns - 保留的最近回合数
   * @returns {Promise<{ sessionId: string, name: string, totalTurns: number, running: boolean, text: string }>} 回合视图
   */
  async function transcript({ parent, sessionId, turns }) {
    await assertLeader(parent, {
      pending: 'read_worker_session: 项目注册表尚未读出，无法确认 leader 身份，暂不能读 worker 的会话',
      refused: 'read_worker_session: 只有项目 leader 能读 worker 的会话——这个会话已不是任何项目的 leader（换下的 leader 降级为项目里的普通会话）',
    })
    const worker = await workers.get(sessionId) ?? owners.get(sessionId)
    if (worker === undefined) {
      throw new Error(`read_worker_session: 没有会话 ${sessionId} 的派工记录，它不是本协调体系派出的 worker`)
    }
    if (worker.parentSessionId !== parent.id) {
      throw new Error('read_worker_session: 该 worker 是别的会话派的，不能跨会话读它的会话内容')
    }
    const query = ctx.get('sessionQuery')
    if (query === undefined || typeof query.readSession !== 'function') {
      throw new Error('read_worker_session: 当前组合缺少会话查询后端（sessionQuery），读不了 worker 的会话日志')
    }
    let snapshot
    try {
      snapshot = await query.readSession(sessionId)
    } catch (error) {
      // 还没投过消息的 worker 没有落盘日志：这是预期状态，不是故障，要说清。
      throw new Error(`read_worker_session: 读不到 worker ${sessionId} 的会话日志（可能还没跑过任何回合，或日志不可读）：${error instanceof Error ? error.message : String(error)}`)
    }
    // 空会话也是合法日志（`events` 是空数组），但形状不对说明后端契约变了：
    // 静默当成空日志会让 leader 以为 worker「什么都没做」。
    if (!Array.isArray(snapshot?.events)) {
      throw new Error(`read_worker_session: 会话查询后端返回的日志形状不符（缺 events 数组），无法读 worker ${sessionId} 的会话`)
    }
    const { turns: list, running } = foldTurns(snapshot.events)
    const displayName = typeof worker.name === 'string' ? worker.name : sessionId
    return {
      sessionId,
      name: displayName,
      totalTurns: list.length,
      running,
      text: renderTranscript({ turns: list, sessionId, name: displayName, limit: turns, running }),
    }
  }

  /**
   * 建一个 worker 会话并登记，**不投递任务、不产生模型调用**。
   *
   * 开工由 leader 随后的 `message` 触发。分成两步是为了让槽位绑定先落盘：第一条
   * 任务请求组装时，角色槽位与卡片事实都能读到；否则首轮只能靠简报里的口头
   * 交代，role / card 上下文要晚一个请求才出现。
   *
   * 这里不建在飞记录：没有 turn 就不会有 `turn/end`，先挂一条在飞记录只会让
   * 结算路径等一个永远不来的事件。在飞记录由 `message` 首次投递时建立。
   *
   * @param {object} options - 派工参数
   * @param {object} options.parent - 发起派工的父 agent
   * @param {string} options.name - worker 显示名
   * @param {string} [options.cardId] - 要绑的卡片 id；与 `slot` 成对
   * @param {string} [options.slot] - 要绑的槽位名；与 `cardId` 成对
   * @param {string} [options.force] - 名册到顶时的逃逸理由；非空才放行新建
   * @param {AbortSignal} options.signal - 取消信号
   * @returns {Promise<object>} 派工记录
   */
  async function dispatch({ parent, name, cardId, slot, force, signal }) {
    // 绑定参数成对出现：只给一半会让调用方以为绑上了，实际什么都没发生。
    if ((cardId === undefined) !== (slot === undefined)) {
      throw new Error('spawn_worker: cardId 与 slot 必须成对传入（要绑卡就两者都给，不绑就都不给）')
    }
    // 派工是唯一会真的拉起一个会话的操作，身份判定必须比工具面严一档。
    await assertLeader(parent, {
      pending: 'spawn_worker: 项目注册表尚未读出，无法确认 leader 身份，暂不能派工',
      refused: 'spawn_worker: 只有项目 leader 能派工，请在左栏项目区块建项目并进入 leader 会话',
    })
    // 续聊是 worker 的既定能力：缺持久化后端（日志不落盘）或查询后端（冷恢复
    // 读不了日志）时 worker 只能跑一轮，拒绝派工而不是静默降级成一次性 worker。
    if (ctx.get('sessionPersistence') === undefined) {
      throw new Error('dsh-leader-agent: 当前组合缺少会话持久化后端，worker 无法续聊，拒绝派工')
    }
    if (ctx.get('sessionQuery') === undefined) {
      throw new Error('dsh-leader-agent: 当前组合缺少会话查询后端，worker 无法冷恢复续聊，拒绝派工')
    }
    // 绑卡前先校验归属与状态：跨项目写会污染对方的看板与上下文，已关闭的卡绑上去
    // 会绕过投递门禁。校验放在建会话之前，被拒时磁盘上连会话都不会留下。
    if (cardId !== undefined) await assertCardAssignable(cardId, parent)
    // 名册上限：到顶先劝复用——已派出的 worker 都能冷恢复，新建只在确实需要
    // 一条干净上下文时才值得。`force` 非空是明确的逃逸声明，理由随工具调用进
    // 会话历史，可审计。
    if (typeof force !== 'string' || force.trim() === '') {
      const roster = await describeRoster()
      if (roster !== null && roster.total >= activeWorkerLimit) {
        const candidates = roster.idle.slice(0, 10)
        const bound = roster.bound.slice(0, 10)
        throw new Error([
          `spawn_worker: 未归档的 worker 已达上限 ${activeWorkerLimit}，本次未新建。`,
          candidates.length === 0
            ? '当前没有可复用的 worker（都在跑，或都挂着未完成的卡）：等它们结算，或关闭手上的卡释放执行者。'
            : `可复用的 worker（当前不在跑、也没挂未完成的卡；用 message_worker 投递新简报即可，可带 rename 换角色）：\n${
              candidates.map((item) => `- ${item.childId} ${item.name ?? item.label ?? ''}`.trimEnd()).join('\n')
            }`,
          bound.length === 0
            ? ''
            : `挂着未完成卡、不能接新活的 worker（先 update_card 把卡标 done / archived，槽位会自动释放）：\n${
              bound.map((item) => `- ${item.childId} ${item.name ?? item.label ?? ''}：${
                item.cards.map((card) => `#${card.number} ${card.title}（cardId: ${card.cardId}，槽位 ${card.slot}）`).join('、')
              }`.trimEnd()).join('\n')
            }`,
          '确实要新建：传 force 说明为什么现有 worker 都不适合。',
        ].filter((line) => line !== '').join('\n'))
      }
    }
    // worker 的工作目录由项目决定：leader 不能指定 worker 跑在哪，也不该让
    // worker 跑到项目外面去。项目目录是绝对路径，worker 会话直接采用。
    const cwd = resolveWorkerCwd?.(parent.id)
    // 「呈现」（改名）推到绑定成功之后：改名会追加 `session/title` 事件、让会话
    // 在磁盘上 materialize，先做就没有东西可回滚了。
    //
    // 权限跟着会话一起交下去：宿主的默认 preset 不一定是 leader 当前那套，而
    // worker 在后台跑，需要审批的调用没人应答。
    const { sessionId: childId, permission } = await workerSessions.spawn({
      cwd,
      name,
      signal,
      permissionFrom: parent.session,
      deferPresentation: true,
    })
    // 绑卡必须在返回前完成：leader 接下来投递的第一条消息就该带着角色与卡片事实。
    // 绑不上就销毁刚建的会话——它还没 materialize，磁盘上不会留下半成品。
    if (cardId !== undefined && slot !== undefined) {
      if (typeof bindCardSlot !== 'function') {
        await workerSessions.dispose(childId)
        throw new Error('dsh-leader-agent: 当前装配没有提供 bindCardSlot，无法在派工时绑卡')
      }
      try {
        await bindCardSlot({ cardId, slot, sessionId: childId })
      } catch (error) {
        await workerSessions.dispose(childId)
        throw error
      }
    }
    workerSessions.present(childId, { name })
    const record = {
      childId,
      parentSessionId: parent.id,
      parent,
      name,
      startedAt: Date.now(),
      // worker 以什么权限跑要跟着派工结果回去：继承到完全权限时，用户在派工
      // 那一刻就该知道，而不是事后翻 worker 的会话日志。
      permission,
    }
    // 先记本进程归属，再落登记表：落盘失败时同轮投递仍然可用（见 `owners`）。
    owners.set(childId, { parentSessionId: parent.id, name })
    // 派工落登记表：leader 可能在任何时刻（含本进程重启后）续聊，归属与父会话
    // 映射不能只活在内存里。任务正文此时还没有，等 `message` 投递后才有。
    try {
      await workers.register({
        childId: record.childId,
        parentSessionId: parent.id,
        name,
      })
    } catch (error) {
      logger(`dsh-leader-agent: worker ${record.childId} 登记失败，续聊与归属查询会落空：${error instanceof Error ? error.message : String(error)}`)
    }
    return record
  }

  /**
   * 把宿主的轮次结束原因写成一句能读的失败原因。
   *
   * 失败时摘要用终态原因而不是产物：失败轮次里的 assistant 文本往往只写到一半，
   * 拿它当摘要会让 leader 以为这一轮做了不少事。
   *
   * @param {object} reason - `turn/end` 的 `reason`
   * @returns {string} 失败原因
   */
  function describeTurnFailure(reason) {
    switch (reason?.kind) {
      // `aborted.reason` 是对象（`{ kind: 'user' | 'parent' | 'hook' | … }`），
      // 直接插值会渲染成 `[object Object]`——给 leader 看的就是这句原因。
      case 'aborted': return `被取消：${reason.reason?.kind ?? '未说明原因'}`
      case 'blocked': return '被阻断：这一轮被宿主拦下，没有开始'
      case 'max-tokens': return '输出达到 token 上限，这一轮没有正常收尾'
      case 'error': return `失败：${reason.error?.message ?? '未知错误'}`
      default: return `这一轮没有正常结束（${reason?.kind ?? '未知原因'}）`
    }
  }

  /**
   * 结算一个 worker 的轮次：把这一轮的产物或失败原因交给 leader。
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
    if (record === undefined) return false
    // 摘要与终态在第一次结算时冻结进记录：落盘失败后下一轮结束时重试的必须是
    // **这一轮**的产物，不能被下一轮的 assistant 文本覆盖。
    if (record.summary === undefined) {
      record.outcome = reason?.kind === 'completed' ? 'completed' : 'failed'
      record.summary = record.outcome === 'completed'
        ? record.text ?? ''
        : describeTurnFailure(reason)
    }
    const judged = record.outcome === 'completed'
      ? { ok: true, result: { stopReason: 'completed', output: [{ type: 'text', text: record.summary }] } }
      : { ok: false, error: new Error(record.summary) }
    // 落盘即结算成功：通知进了队列就不会丢。落盘失败时记录（连同冻结的摘要）
    // 还在，这个 worker 下一轮结束时再结算同一份内容；`enqueue` 按 id 幂等，
    // 重试不会多出一条通知。
    const notification = await emitNotification(record, judged)
    // 落盘期间 leader 可能已经投出下一轮并登记了新记录：只清自己那一条，否则
    // 会把新记录一起删掉，那一轮结束时就漏结算。
    if (inflight.get(sessionId) === record) inflight.delete(sessionId)
    try {
      await deliver(notification, record.parent)
    } catch (error) {
      // 已经落盘：投递失败留给空闲检测与补投通道，一次 IO 抖动不能让这一轮
      // 重结算一遍（那会再唤醒父会话一次，且第二条正文是新一轮的产物）。
      logger(`dsh-leader-agent: 投递 worker ${sessionId} 的完成通知失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return true
  }

  /**
   * 观察会话事件，在 worker 的轮次边界上结算。
   *
   * 一个 turn 是 `agent.run()` 的一次调用（内部含多个 step），正好等于「leader 派的
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
      const record = inflight.get(sessionId)
      if (record === undefined) return undefined
      const text = messageText(event.data?.message?.content)
      // 空内容（宿主对空响应也会发这条）不能覆盖本轮已有的文本，但文本只记在
      // 当前记录上：新消息若已换了一条记录，旧轮文本不会漏到新轮。
      if (text !== '') record.text = text
      return undefined
    }
    if (event?.type !== 'turn/end') return undefined
    // 宿主会接住并记下观察者的异常，但那条日志混在宿主日志里查不出来源；自己接住，
    // 才能把「回报没送到」记成这条链上的失败。
    return settleTurn(sessionId, event.data?.reason).catch((error) => {
      logger(`dsh-leader-agent: 结算 worker ${sessionId} 的轮次失败：${error instanceof Error ? error.message : String(error)}`)
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
    transcript,

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
      // 不清等待表：补投期间可能有条目刚进去（会话转忙、额度用尽），整表删会把它们
      // 一起丢掉。已投出的那些在 flushWaiting 里对不上落盘队列，会自己掉出去。
      return delivered
    },

    /**
     * 补投队列里属于某个父会话的通知（换 leader 后的接管用）。
     *
     * 与 `redeliverPending` 同一套投递路径，区别是只持有会话 id：接管的通知是刚
     * 改投过来的，而新会话可能早过了 `agent/created`（那一刻队列里还没它的事），
     * 总得有人推一把。新会话可达就直接投，正忙就进等待表等空闲检测。
     *
     * @param {string} parentSessionId - 父会话 id
     * @returns {Promise<number>} 成功补投的条数
     */
    async redeliverPendingFor(parentSessionId) {
      if (typeof parentSessionId !== 'string' || parentSessionId === '') return 0
      const pending = await store.listPending()
      let delivered = 0
      for (const notification of pending) {
        if (notification.parentSessionId !== parentSessionId) continue
        if (await deliver(notification, undefined) === DELIVERED) delivered += 1
      }
      // 同 `redeliverPending`：不清等待表，这一轮新进去的条目要留在里面等空闲。
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
      if (idleTimer !== undefined) {
        clearInterval(idleTimer)
        idleTimer = undefined
      }
      waiting.clear()
    },

    /**
     * 换 leader：把按父会话归集的内存态改到接手的会话上。
     *
     * 三处都以父会话 id 为键，只改落盘归属的话，回报仍会投给退役会话：
     *
     * - 等待表（`waiting`）：退役会话没投出去的通知挪给接手会话，排在它已有条目
     *   之前——这些通知对应更早完成的工；条目里的通知跟着改父会话 id，否则续行
     *   计数与「会话已销毁」判定还查旧 id；
     * - 续行计数（`resumeCounts`）：取两者较大值。这批通知已经消耗过旧会话的自动
     *   续行额度，换人不清零，护栏不会因为换人而重置；人工在新会话里开口才复位。
     * - 在飞记录（`inflight`）：父会话改到接手会话，并丢掉 `parent` 活对象——那是
     *   退役会话的 agent，投递回退到它等于把回报送进一个已经不能动手的会话。
     *
     * 改绑是幂等的：没有对应键时什么都不动。
     *
     * @param {string} fromId - 退役的父会话 id
     * @param {string} toId - 接手的父会话 id
     * @returns {number} 改绑的在飞记录数
     */
    reassignParent(fromId, toId) {
      if (typeof fromId !== 'string' || fromId === '' || typeof toId !== 'string' || toId === '') return 0
      if (fromId === toId) return 0
      const list = waiting.get(fromId)
      if (list !== undefined && list.length > 0) {
        waiting.delete(fromId)
        // 条目里的通知要跟着改父会话 id：`deliverOnce` 按它取续行计数、`deliver`
        // 按它查「会话已销毁」。只挪表不改 id，这批通知就按 0 算额度，绕过了护栏。
        // 顺手丢掉条目里握着的旧 agent——那是退役会话的活对象，只能用来投错人。
        const adopted = list.map((item) => ({
          ...item,
          notification: { ...item.notification, parentSessionId: toId },
          agent: undefined,
        }))
        waiting.set(toId, [...adopted, ...(waiting.get(toId) ?? [])])
        ensureIdleTimer()
      }
      const used = resumeCounts.get(fromId)
      if (used !== undefined) {
        resumeCounts.delete(fromId)
        resumeCounts.set(toId, Math.max(used, resumeCounts.get(toId) ?? 0))
      }
      // 本进程派出的归属也要改投：只改落盘登记表的话，接手会话在同一轮里
      // 给原班 worker 投消息会被归属校验拒绝。
      for (const owner of owners.values()) {
        if (owner.parentSessionId === fromId) owner.parentSessionId = toId
      }
      let moved = 0
      for (const record of inflight.values()) {
        if (record.parentSessionId !== fromId) continue
        record.parentSessionId = toId
        record.parent = undefined
        moved += 1
      }
      return moved
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
      // 会话已经没了：本进程归属也一并摘掉，后续投递改走登记表判断，
      // 避免「认得出归属却投不进」的半死状态。
      owners.delete(sessionId)
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
