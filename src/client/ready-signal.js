/**
 * 一次性的就绪信号。
 *
 * 浏览器侧的若干服务由别的 bundle 提供，取到时可能还不是 `undefined`——插件的
 * 加载顺序不保证。订阅这类服务时，一次判空放弃等于永久失联：之后服务就绪也不会
 * 有人回头再试。把「已就绪」做成可订阅事件，订阅者拿到通知时再做真正的订阅。
 *
 * 状态放在闭包里而不是模块顶层：每个持有者一份，测试之间不会互相污染。
 *
 * @module dsh-leader-agent/client/ready-signal
 */

/**
 * 造一个就绪信号。
 * @returns {object} 信号：`mark` / `subscribe`
 */
export function createReadySignal() {
  /** @type {Set<() => void>} 就绪订阅者 */
  const listeners = new Set()
  let ready = false

  /**
   * 通知一个订阅者。
   *
   * 单个订阅者抛错不能带走其余订阅者：`ready` 已置位，这一轮之后不会再有通知，
   * 中断循环等于让别人永久失联——正是本模块要消灭的那种失败。所以逐个隔离，
   * 同时把异常大声报出来，不静默吞掉。
   *
   * @param {() => void} listener - 订阅者
   * @returns {void}
   */
  const notify = (listener) => {
    try {
      listener()
    } catch (error) {
      console.error('dsh-leader-agent: 就绪订阅回调抛错', error)
    }
  }

  return {
    /** 标记就绪并通知订阅者。重复标记只通知一次。 */
    mark() {
      if (ready) return
      ready = true
      // 先快照再遍历：通知期间新增的订阅者不该被本轮顺带叫一次，它们自己会排
      // 一次微任务；`Set` 的迭代是活的，不拍快照就会重复。反过来，通知期间新增
      // 的订阅者也不能被压掉——那会让它们在已就绪之后再没人通知。
      for (const listener of [...listeners]) notify(listener)
    },

    /**
     * 订阅就绪。已就绪时用微任务补一次通知——调用方通常在同步代码里先判空再订阅，
     * 同步回调会在那次判空与订阅之间重入。
     *
     * 退订后不会再被调用，包括已经排队但尚未执行的那次通知。
     *
     * @param {() => void} listener - 回调
     * @returns {() => void} 退订函数
     */
    subscribe(listener) {
      let active = true
      const run = () => {
        if (!active) return
        notify(listener)
      }
      listeners.add(run)
      if (ready) queueMicrotask(run)
      return () => {
        active = false
        listeners.delete(run)
      }
    },
  }
}
