/**
 * 槽位会话的保留生命周期。
 *
 * 保留（`ctx.sessions.retain`）的副作用正是让宿主不回收该会话，释放是它唯一
 * 的解除方式。配对必须严格：多释放一次会让宿主引用计数错位，少释放一次就永久
 * 持有会话（宿主侧表现为会话回收不掉）。
 *
 * 这里把生命周期从 React 里拆出来，是为了能对配对关系直接断言——面板组件只负责
 * 把状态读数交给宿主，保留与释放的账本由本模块记。
 *
 * 保留目标只接受宿主自己解析出的地址（`sessions.retain(id)` 或宿主给出的
 * 子代理地址）。本模块**不构造**父子地址：编出来的地址会被宿主当成子代理，
 * 之后每次读历史都按子代理校验，根会话一律被拒（`subagent/unauthorized`）。
 *
 * @module dsh-leader-agent/client/slot-retain
 */

/** 宿主对「客户端目录里还没有这个会话」的固定错误前缀。 */
const UNKNOWN_SESSION_PREFIX = 'sessions.retain: unknown session '

/** 冷启动时宿主会话目录可能比看板晚就绪，未知会话默认再等几拍。 */
const DEFAULT_RETRY_DELAY_MS = 2000
const DEFAULT_RETRY_ATTEMPTS = 3

/**
 * 宿主认不出会话 id 时的固定错误。
 *
 * 只吞这一类：已删除、从未存在或客户端目录尚未就绪的会话。其它错误照抛，
 * 保留器的同步调用在 React effect 里，吞掉全部异常会把真正的宿主故障藏成空心圈。
 *
 * @param {unknown} error - 捕获到的异常
 * @returns {boolean} 是否宿主「未知会话」错误
 */
export function isUnknownSessionError(error) {
  return error instanceof Error && error.message.startsWith(UNKNOWN_SESSION_PREFIX)
}

export class SlotRetention {
  /**
   * @param {object} options - 选项
   * @param {(sessionId: string) => object} options.retain - 保留一个会话，返回带
   *   `ready` 与 `release` 的引用
   * @param {(sessionId: string, state: object) => void} options.onState - 读到会话
   *   快照时的回调
   * @param {(sessionId: string) => void} options.onDrop - 会话不再被保留时的回调
   * @param {(message: string) => void} [options.onError] - 保留失败时的报告出口
   * @param {number} [options.retryDelayMs] - 未知会话的重试间隔
   * @param {number} [options.retryAttempts] - 未知会话的重试次数（不含首次）
   */
  constructor({
    retain,
    onState,
    onDrop,
    onError,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    retryAttempts = DEFAULT_RETRY_ATTEMPTS,
  }) {
    this.retain = retain
    this.onState = onState
    this.onDrop = onDrop
    this.onError = onError ?? ((message) => console.warn(message))
    this.retryDelayMs = retryDelayMs
    this.retryAttempts = retryAttempts
    /** @type {Map<string, { reference: object, unsubscribe?: () => void }>} */
    this.entries = new Map()
    /** 已报告过的失败：同一个槽位只报一次，不随每次同步重复刷。 */
    this.reported = new Set()
    /** @type {Map<string, ReturnType<typeof setTimeout>>} 待跑的未知会话重试。 */
    this.timers = new Map()
    /** @type {Map<string, number>} 每个会话已用掉的未知会话重试次数。 */
    this.retries = new Map()
    /** 卸载后即使迟到的 effect 再同步，也不能重新保留会话。 */
    this.disposed = false
  }

  /**
   * 同步保留集合：保留新出现的、释放不再需要的。
   *
   * 释放先于保留——顺序反了会在同一轮里短暂多持有一个会话。
   *
   * @param {Iterable<string>} needed - 当前需要的会话 id
   */
  sync(needed) {
    if (this.disposed) return
    for (const [sessionId, entry] of this.entries) {
      if (needed.has(sessionId)) continue
      this.drop(sessionId, entry)
    }
    for (const sessionId of this.timers.keys()) {
      if (!needed.has(sessionId)) this.cancelRetry(sessionId)
    }
    for (const sessionId of needed) {
      if (this.entries.has(sessionId) || this.timers.has(sessionId)) continue
      this.hold(sessionId)
    }
  }

  /**
   * 保留一个会话。
   *
   * 宿主还不认识这个会话 id 时不放弃：冷启动时宿主会话目录常比看板晚一拍，
   * 按 `retryDelayMs` 重试有限次，用尽才报「状态未知」。宿主明确拒绝的其它错误
   * 同步抛出。
   *
   * @param {string} sessionId - 会话 id
   */
  hold(sessionId) {
    if (this.disposed || this.entries.has(sessionId) || this.timers.has(sessionId)) return
    let reference
    try {
      reference = this.retain(sessionId)
    } catch (error) {
      // 单个槽位的保留失败不能把整块看板从 React effect 里抛掉：宿主拒一条
      // 地址（例如热更前残留的旧子代理地址）会让所有卡片一起消失。真实故障
      // 仍经 onError 报出来，不静默。未知会话是宿主目录还没就绪，按次重试。
      if (isUnknownSessionError(error)) {
        this.scheduleRetry(sessionId, error)
        return
      }
      this.report(sessionId, `看板无法保留会话 ${sessionId}，槽位状态未知：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.retries.delete(sessionId)
    const entry = { reference, unsubscribe: undefined }
    this.entries.set(sessionId, entry)
    reference.ready
      .then((binding) => {
        // 保留期间该槽位被撤掉：会话已被释放，不再订阅它的快照
        if (this.entries.get(sessionId) !== entry) return
        const read = () => {
          const snapshot = binding.session.getSnapshot()
          this.onState(sessionId, {
            running: snapshot.running === true,
            failed: typeof snapshot.lastAgentError === 'string' && snapshot.lastAgentError !== '',
          })
        }
        read()
        entry.unsubscribe = binding.session.subscribe(read)
      })
      .catch((error) => {
        // 保留失败：状态表里不出现这一项，槽位显示为未知
        this.report(sessionId, `看板打开会话 ${sessionId} 失败，槽位状态未知：${error instanceof Error ? error.message : String(error)}`)
      })
  }

  /**
   * 安排一次未知会话重试；次数用尽时报告一次并放弃。
   *
   * @param {string} sessionId - 会话 id
   * @param {Error} error - 宿主抛出的未知会话错误
   */
  scheduleRetry(sessionId, error) {
    const used = this.retries.get(sessionId) ?? 0
    if (used >= this.retryAttempts) {
      this.retries.delete(sessionId)
      // 宿主不认识这个会话（已删、从未存在、或地址解析不出）：状态保持未知，
      // 不谎称空闲。这条要说出来——槽位上只表现为一个空心圈，没有日志就查不到。
      this.report(sessionId, `看板无法保留会话 ${sessionId}，槽位状态未知：${error.message}`)
      return
    }
    this.retries.set(sessionId, used + 1)
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      if (this.disposed) return
      this.hold(sessionId)
    }, this.retryDelayMs)
    // 定时器不应该单独把宿主进程吊住（Node 侧单测与 headless 场景）。
    timer.unref?.()
    this.timers.set(sessionId, timer)
  }

  /**
   * 取消一个会话待跑的重试并清掉计数。
   *
   * @param {string} sessionId - 会话 id
   */
  cancelRetry(sessionId) {
    const timer = this.timers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(sessionId)
    }
    this.retries.delete(sessionId)
  }

  /**
   * 报告一次保留失败，同一个会话只报一次。
   * @param {string} sessionId - 会话 id
   * @param {string} message - 报告内容
   */
  report(sessionId, message) {
    if (this.reported.has(sessionId)) return
    this.reported.add(sessionId)
    this.onError(message)
  }

  /**
   * 释放一个会话。
   *
   * @param {string} sessionId - 会话 id
   * @param {object} [entry] - 该会话的记录，缺省时取当前记录
   */
  drop(sessionId, entry = this.entries.get(sessionId)) {
    this.cancelRetry(sessionId)
    if (entry === undefined) return
    if (this.entries.get(sessionId) === entry) this.entries.delete(sessionId)
    entry.unsubscribe?.()
    entry.reference.release()
    this.onDrop(sessionId)
  }

  /**
   * 释放全部保留的会话。
   *
   * 不回调 `onDrop`：面板卸载后没有状态可更新，回调只会徒增一次无用的渲染。
   */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const sessionId of this.timers.keys()) this.cancelRetry(sessionId)
    this.retries.clear()
    for (const entry of this.entries.values()) {
      entry.unsubscribe?.()
      entry.reference.release()
    }
    this.entries.clear()
  }
}
