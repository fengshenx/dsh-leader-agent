/**
 * 完成通知的落盘队列。
 *
 * 通知在唤醒父会话**之前**先落盘：唤醒是「向父 agent 投一条消息并开新 turn」的
 * 动作，一旦进程在唤醒前崩溃，通知会丢，leader 将永远不知道 worker 完成了。落盘
 * 队列让这类通知在下次启动时被补投。
 *
 * 落盘位置在 dsh home 下的自有目录，不占用 session 事件流——仓外插件不得新增
 * session event 类型。
 *
 * @module dsh-leader-kit/host/notification-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const QUEUE_VERSION = 1

/**
 * 解析 dsh home 目录。dsh 允许用 `DSH_HOME` 覆盖默认位置。
 *
 * 默认位置必须与宿主一致（宿主走 `os.homedir()`）：Windows 桌面端由资源管理器
 * 启动，进程环境里没有 `HOME`，按 `process.env.HOME` 拼路径会让宿主半边在 apply
 * 里抛 `ERR_INVALID_ARG_TYPE`，浏览器侧只剩客户端产物，所有 `projects/*` 调用都
 * 变成 HTTP 404。
 *
 * @param {object} [env] - 环境变量映射（只读 `DSH_HOME`）
 * @param {() => string} [resolveHome] - 家目录解析器，默认 `os.homedir()`
 * @returns {string} dsh home 绝对路径
 */
export function resolveDshHome(env = process.env, resolveHome = homedir) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(resolveHome(), '.dsh')
}

/**
 * 创建通知落盘队列。
 *
 * @param {object} options - 队列选项
 * @param {string} [options.home] - dsh home 目录，默认按环境解析
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {object} 队列接口
 */
export function createNotificationStore({ home, logger = () => {} } = {}) {
  const directory = join(home ?? resolveDshHome(), 'dsh-leader-kit')
  const file = join(directory, 'notifications.json')
  const temporary = join(directory, 'notifications.json.tmp')

  /** 队列操作的串行链，保证读-改-写不交错。 */
  let tail = Promise.resolve()

  /**
   * 读取队列；文件缺失返回空队列。
   * @returns {Promise<{ version: number, pending: object[] }>} 队列快照
   */
  async function read() {
    const raw = await readFile(file, 'utf8').catch(() => undefined)
    if (raw === undefined) return { version: QUEUE_VERSION, pending: [] }
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.pending)) {
        throw new Error('通知队列结构非法：缺少 pending 数组')
      }
      return { version: QUEUE_VERSION, pending: parsed.pending }
    } catch (error) {
      const backup = `${file}.corrupt-${Date.now()}`
      await rename(file, backup).catch(() => undefined)
      logger(`通知队列损坏，已备份到 ${backup}：${error instanceof Error ? error.message : String(error)}`)
      return { version: QUEUE_VERSION, pending: [] }
    }
  }

  /**
   * 把队列快照原子写回磁盘。
   * @param {{ version: number, pending: object[] }} queue - 队列快照
   * @returns {Promise<void>} 写盘完成
   */
  async function write(queue) {
    await mkdir(directory, { recursive: true })
    await writeFile(temporary, `${JSON.stringify(queue, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  }

  /**
   * 串行执行队列操作。多个 worker 同时完成时，读-改-写必须排队，否则会互相
   * 覆盖对方的改动，也会争抢同一个临时文件。
   * @template T
   * @param {() => Promise<T>} operation - 队列操作
   * @returns {Promise<T>} 操作结果
   */
  function serialize(operation) {
    const run = tail.then(operation, operation)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  return {
    directory,
    file,

    /**
     * 读出全部未投递的通知。
     * @returns {Promise<object[]>} 未投递通知列表
     */
    listPending() {
      return serialize(async () => (await read()).pending)
    },

    /**
     * 追加一条待投递通知。
     *
     * 按 `id` 幂等：同一轮的通知在落盘失败重试、投递失败后重结算时都带同一个
     * `note-<child>-<startedAt>`，重复入队会让父会话被同一任务唤醒两次，第二条
     * 还可能是新一轮的内容被误标成这一轮。
     *
     * @param {object} notification - 通知记录
     * @returns {Promise<void>} 落盘完成
     */
    enqueue(notification) {
      return serialize(async () => {
        const queue = await read()
        if (queue.pending.some((item) => item.id === notification.id)) return
        queue.pending.push(notification)
        await write(queue)
      })
    },

    /**
     * 把未投递的通知改投另一个父会话（换 leader 后的接管）。
     *
     * 只动还在队列里的条目：已投出的通知已经进了旧会话的历史，改它等于篡改历史。
     * 队列按 `id` 去重、不按父会话分组，改绑不影响去重键，也不改排队顺序（旧会话
     * 没投出去的那些更早完成，仍排在接手会话已有条目前面）。
     *
     * @param {string} fromId - 退役的父会话 id
     * @param {string} toId - 接手的父会话 id
     * @returns {Promise<number>} 改绑的条数
     */
    reassignParent(fromId, toId) {
      if (typeof fromId !== 'string' || fromId === '' || typeof toId !== 'string' || toId === '') return Promise.resolve(0)
      if (fromId === toId) return Promise.resolve(0)
      return serialize(async () => {
        const queue = await read()
        let moved = 0
        for (const item of queue.pending) {
          if (item.parentSessionId !== fromId) continue
          item.parentSessionId = toId
          moved += 1
        }
        // 没改到任何一条时不写盘：串行链上的每次写都要读改写整表，白写一次只是噪声。
        if (moved > 0) await write(queue)
        return moved
      })
    },

    /**
     * 标记通知已投递并移出队列。
     * @param {string} id - 通知 id
     * @returns {Promise<void>} 落盘完成
     */
    markDelivered(id) {
      return serialize(async () => {
        const queue = await read()
        queue.pending = queue.pending.filter((item) => item.id !== id)
        await write(queue)
      })
    },

    /**
     * 记录一次投递失败，通知留在队列里等待补投。
     * @param {string} id - 通知 id
     * @param {string} reason - 失败原因
     * @returns {Promise<void>} 落盘完成
     */
    markUndelivered(id, reason) {
      return serialize(async () => {
        const queue = await read()
        const target = queue.pending.find((item) => item.id === id)
        if (target === undefined) return
        target.attempts = (target.attempts ?? 0) + 1
        target.lastError = reason
        await write(queue)
      })
    },
  }
}
