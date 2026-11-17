/**
 * worker 长时间无回报的巡查。
 *
 * leader 看到的「worker 在跑」来自派工记录，而记录只说「这一轮还没结束」，不说
 * 它跑了多久。worker 卡在一个轮次里反复打转时，leader 收不到任何信号，默认协议
 * 又要求它不轮询——死循环是静默的。
 *
 * 本模块只做两件事：算「多久没回报」，和在阈值上生成一条提醒。提醒怎么落盘、
 * 怎么投给 leader 由 `dispatch.js` 决定（复用完成通知的同一套队列与唤醒路径）。
 *
 * **单节拍而不是每个 worker 一个定时器**：正确性依赖每条 run 起点与终态路径都
 * 建/清句柄，漏建则永久静默、漏清则句柄泄漏，而这恰好都发生在异常与取消路径。
 * 60s 扫一遍在飞记录是无状态对账，漏了任何一个事件，下一拍自动纠正。
 *
 * @module dsh-leader-agent/host/worker-stall
 */

/** 多久没有回报算「可能卡住」。 */
export const STALL_THRESHOLD_MS = 15 * 60 * 1000

/**
 * 巡查节拍。
 *
 * 不与阈值同值：同值时首报最坏接近 30 分钟；60s 扫一次把精度收在阈值后一分钟内。
 */
export const STALL_TICK_MS = 60 * 1000

/**
 * 时长文案。
 *
 * 只给到分钟：巡查是「大概多久」的判断，精确到秒反而让人盯着读数。不足一分钟
 * 只说秒，跨小时后带小时。
 *
 * @param {number} ms - 时长（毫秒）
 * @returns {string} 时长文案
 */
export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
}

/**
 * 计算判定基线：这一轮从哪一刻起算「没有回报」。
 *
 * 取三者最大：
 * - `runStartedAt`：本轮开跑时刻。上一轮的旧回报不能把新一轮一开跑就判超时；
 * - `lastReportAt`：最后一次回报的时刻。跨进程冷恢复后内存里没有本轮起点时，
 *   它是唯一还存在的活性事实；
 * - `lastAlertAt`：上次提醒的时刻。提醒注入即重置计时，形成「每 15 分钟一条」的
 *   循环，而不是每一拍都发。
 *
 * @param {object} facts - 活性事实
 * @param {number} [facts.runStartedAt] - 本轮开跑时刻
 * @param {number} [facts.lastReportAt] - 最后一次回报时刻
 * @param {number} [facts.lastAlertAt] - 上次提醒时刻
 * @returns {number} 判定基线（毫秒时间戳）
 */
export function stallBaseline({ runStartedAt, lastReportAt, lastAlertAt }) {
  return Math.max(runStartedAt ?? 0, lastReportAt ?? 0, lastAlertAt ?? 0)
}

/**
 * 判断是否已到提醒阈值。
 *
 * @param {object} input - 判定输入
 * @param {number} input.baseline - 判定基线
 * @param {number} input.now - 当前时刻
 * @param {number} [input.thresholdMs] - 阈值
 * @returns {boolean} 是否该提醒
 */
export function isStalled({ baseline, now, thresholdMs = STALL_THRESHOLD_MS }) {
  return now - baseline >= thresholdMs
}

/**
 * 构造给模型读的提醒正文。
 *
 * 正文要让人能直接照着做：有卡号与标题（知道是哪条工作线）、有已连续时长与最后
 * 回报（判断是新卡住还是本来就慢）、有一条可照抄的回看调用（查明的手段），以及
 * 「本流程没有中止手段」这一事实——否则 leader 会去找一个不存在的停止工具。
 *
 * @param {object} input - 提醒内容
 * @param {string} input.name - worker 显示名
 * @param {string} input.childId - worker 会话 id
 * @param {number} input.elapsedMs - 已连续未回报的时长
 * @param {number} [input.lastReportAt] - 最后一次回报的时刻
 * @param {number} input.now - 当前时刻
 * @param {{ number: number|string, title: string, slot: string }[]} [input.cards] - 挂着的未完成卡
 * @returns {string} 提醒正文
 */
export function buildStallNoticeText({
  name,
  childId,
  elapsedMs,
  lastReportAt,
  now,
  cards = [],
}) {
  const lines = [`【后台巡查】例行检查：worker「${name}」已连续 ${formatElapsed(elapsedMs)}没有回报。这不一定是卡住，也不代表任务失败；这是提醒，不是中止。`]
  lines.push(`子会话 sessionId：${childId}`)
  if (cards.length > 0) {
    const refs = cards
      .map((card) => `#${card.number} ${card.title}（槽位 ${card.slot}）`)
      .join('、')
    lines.push(`挂着的卡：${refs}`)
  }
  lines.push(`最后回报：${lastReportAt === undefined
    ? '无记录（这一轮还没有结束过）'
    : `${formatElapsed(now - lastReportAt)}前`}`)
  lines.push(`下一步：先查明再决定继续等待或停止——调 read_worker_session({ sessionId: "${childId}", turns: 3 }) 回看它这一轮卡在哪一步。`)
  lines.push('本流程没有中止 worker 的手段；确认卡死时请人在项目树里打开它的会话处理，或 message_worker 投一条纠偏指令。')
  return lines.join('\n')
}

/**
 * 造一个巡查节拍。
 *
 * `listRunning` 与 `alert` 都由调用方给：在飞记录、卡片绑定、通知队列与投递都在
 * `dispatch.js` 里，这里只负责「到点没有、要不要提醒」。提醒的幂等（盘上已有未
 * 消费的提醒就跳过）也在 `alert` 里判——它才看得见队列。
 *
 * @param {object} options - 选项
 * @param {() => Promise<object[]>} options.listRunning - 取当前在跑、值得巡查的 worker
 * @param {(item: object) => Promise<boolean>} options.alert - 注入一条提醒；返回是否真的注入了
 * @param {number} [options.thresholdMs] - 阈值
 * @param {number} [options.tickMs] - 节拍间隔
 * @param {() => number} [options.now] - 当前时刻（测试注入）
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {{ scan: (at?: number) => Promise<number>, dispose: () => void }} 节拍接口
 */
export function createStallWatch({
  listRunning,
  alert,
  thresholdMs = STALL_THRESHOLD_MS,
  tickMs = STALL_TICK_MS,
  now = Date.now,
  logger = () => {},
}) {
  // 漏传任一项都是装配错误：静默跳过就等于这个功能不存在，而 leader 仍以为有人
  // 在盯。装配期直接报错，别等到第一次该提醒的时候。
  if (typeof listRunning !== 'function' || typeof alert !== 'function') {
    throw new Error('dsh-leader-agent: createStallWatch 需要 listRunning 与 alert')
  }
  let timer
  let closed = false
  /** 上一拍还没跑完时跳过这一拍：重入会重复注入同一条提醒。 */
  let scanning = false

  /**
   * 扫一遍当前在跑的 worker，对超阈值的注入提醒。
   *
   * @param {number} [at] - 判定时刻
   * @returns {Promise<number>} 实际注入的提醒条数
   */
  async function scan(at = now()) {
    const running = await listRunning()
    let alerted = 0
    for (const item of running) {
      const baseline = stallBaseline(item)
      if (!isStalled({ baseline, now: at, thresholdMs })) continue
      try {
        const injected = await alert({ ...item, baseline, now: at, elapsedMs: at - baseline })
        if (injected === true) alerted += 1
      } catch (error) {
        // 单个 worker 的提醒失败不能拖垮整拍：其余 worker 还等着被查。
        logger(`dsh-leader-agent: worker ${item.sessionId} 的巡查提醒注入失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return alerted
  }

  /**
   * 一拍。异常在这里兜住：宿主对未处理拒绝是致命退出，一次 IO 抖动不该带走整个
   * dsh 进程。
   * @returns {void}
   */
  function tick() {
    if (closed || scanning) return
    scanning = true
    void scan()
      .catch((error) => {
        logger(`dsh-leader-agent: 巡查节拍失败：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        scanning = false
      })
  }

  timer = setInterval(tick, tickMs)
  // 巡查不该拖住进程退出：提醒丢了不可怕，重启后没有正在跑的轮次，本来也不补。
  timer.unref?.()

  return {
    scan,
    dispose() {
      closed = true
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
  }
}
