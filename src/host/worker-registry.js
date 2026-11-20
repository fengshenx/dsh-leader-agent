/**
 * worker 登记表：leader 派过的工在这里留档。
 *
 * **为什么需要落盘**：给 worker 发消息（`message_worker`）必须知道会话 id 与它
 * 的父会话。进程内的活表随进程消失，进程重启更是全丢。登记表落盘，续聊与查工才
 * 跨得过去。
 *
 * **登记表不是派工真源**：派工真源是宿主的会话库（会话日志与它自己的元数据）——
 * 会话由本 bundle 用 `agents.create` 建、`agents.resume` 唤醒。这里存的是「这个
 * 会话是本 bundle 派出去的工」这一层归属，以及续聊需要的父会话 id；宿主那边不存
 * 这层，插件这边也不重复存会话内容。
 *
 * 落盘位置在 dsh home 下的自有目录，与通知队列同构（原子写 + 串行化读改写）。
 *
 * @module dsh-leader-agent/host/worker-registry
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const REGISTRY_VERSION = 1

/**
 * 登记表保留的最大条数。
 *
 * 记录永不主动删除，而每条都带任务正文——不设上限时文件随派工次数无界增长，
 * 每次登记又要整表读改写。子会话被宿主销毁后老记录本来也续不了，留最近一批够用。
 */
const DEFAULT_MAX_WORKERS = 500

/**
 * 读旧登记表时补出最后使用时刻。
 *
 * `lastUsedAt` 是后加的字段；旧文件里没有它时按 `registeredAt` 兜底，不能让
 * 老记录在 LRU 排序里落到 0。这里只在读快照上补值，下一次真实写盘时自然落盘。
 *
 * @param {object} worker - 登记记录
 * @returns {object} 带 lastUsedAt 的记录
 */
function withLastUsedAt(worker) {
  if (worker === null || typeof worker !== 'object' || Array.isArray(worker)) return worker
  if (typeof worker.lastUsedAt === 'number') return worker
  return {
    ...worker,
    lastUsedAt: typeof worker.registeredAt === 'number' ? worker.registeredAt : 0,
  }
}

/**
 * 创建 worker 登记表。
 *
 * @param {object} options - 选项
 * @param {string} [options.home] - dsh home 目录
 * @param {number} [options.maxWorkers] - 保留的最大条数
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {object} 登记表接口
 */
export function createWorkerRegistry({
  home,
  maxWorkers = DEFAULT_MAX_WORKERS,
  logger = () => {},
} = {}) {
  const directory = join(home, 'dsh-leader-agent')
  const file = join(directory, 'workers.json')
  const temporary = join(directory, 'workers.json.tmp')

  /** 读改写串行链：多个 worker 同时登记或更新时不能互相覆盖。 */
  let tail = Promise.resolve()

  /**
   * 读取登记表；文件缺失或损坏返回空表。
   * @returns {Promise<{ version: number, workers: object[] }>} 登记表快照
   */
  async function read() {
    const raw = await readFile(file, 'utf8').catch(() => undefined)
    if (raw === undefined) return { version: REGISTRY_VERSION, workers: [] }
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.workers)) {
        throw new Error('worker 登记表结构非法：缺少 workers 数组')
      }
      return { version: REGISTRY_VERSION, workers: parsed.workers.map(withLastUsedAt) }
    } catch (error) {
      const backup = `${file}.corrupt-${Date.now()}`
      await rename(file, backup).catch(() => undefined)
      logger(`worker 登记表损坏，已备份到 ${backup}：${error instanceof Error ? error.message : String(error)}`)
      return { version: REGISTRY_VERSION, workers: [] }
    }
  }

  /**
   * 原子写回登记表。
   * @param {{ version: number, workers: object[] }} registry - 登记表快照
   * @returns {Promise<void>} 写盘完成
   */
  async function write(registry) {
    await mkdir(directory, { recursive: true })
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  }

  /**
   * 串行执行一次读改写。
   * @template T
   * @param {(registry: { version: number, workers: object[] }) => Promise<T> | T} mutate - 变更函数
   * @returns {Promise<T>} 变更结果
   */
  function serialize(mutate) {
    const result = tail.then(async () => {
      const registry = await read()
      const value = await mutate(registry)
      await write(registry)
      return value
    })
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * 串行执行一次读改写，写不写由变更函数自己决定。
   *
   * 没改到任何一条时跳过整表写盘：换 leader 会对每个退役 id 调一次改绑，退役列表
   * 只增不删，每次换人都是 N 次空读改写。`write` 传进来而不是让调用方自己写——
   * 同一条串行链上的写必须在这里发生，否则会与别的读改写抢同一个临时文件。
   * @template T
   * @param {(registry: { version: number, workers: object[] }, write: () => Promise<void>) => Promise<T> | T} mutate - 变更函数
   * @returns {Promise<T>} 变更结果
   */
  function serializeDeferredWrite(mutate) {
    const result = tail.then(async () => {
      const registry = await read()
      return await mutate(registry, () => write(registry))
    })
    tail = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    /**
     * 登记一个派出去的 worker。
     *
     * @param {object} worker - worker 记录
     * @param {string} worker.childId - 子会话 id
     * @param {string} worker.parentSessionId - 父会话 id
     * @param {string} worker.name - worker 显示名
     * @param {number} [worker.lastUsedAt] - 最后使用时刻；省略时用登记时刻
     * @returns {Promise<object>} 登记后的记录
     */
    async register(worker) {
      return serialize((registry) => {
        const existing = registry.workers.find((item) => item.childId === worker.childId)
        // 同一子会话重复登记时更新而非追加：续聊会再次登记，不更新就会出现两条
        // 同 id 的记录，查工时不知道该用哪条。
        if (existing !== undefined) {
          Object.assign(existing, worker)
          return existing
        }
        const now = Date.now()
        const record = {
          ...worker,
          registeredAt: now,
          lastUsedAt: typeof worker.lastUsedAt === 'number' ? worker.lastUsedAt : now,
        }
        registry.workers.push(record)
        if (registry.workers.length > maxWorkers) {
          // 按登记时间留最近的一批。`sort` 是稳定的，同毫秒登记时保持原顺序，
          // 淘汰的仍是更早那条。
          registry.workers.sort((left, right) => (left.registeredAt ?? 0) - (right.registeredAt ?? 0))
          registry.workers.splice(0, registry.workers.length - maxWorkers)
        }
        return record
      })
    },

    /**
     * 取一个 worker 记录。
     *
     * @param {string} childId - 子会话 id
     * @returns {Promise<object | undefined>} 记录；没有时 undefined
     */
    async get(childId) {
      const registry = await read()
      return registry.workers.find((item) => item.childId === childId)
    },

    /**
     * 列出登记表里的全部 worker，按登记时间倒序（最近的在前）。
     *
     * @returns {Promise<object[]>} 记录列表
     */
    async list() {
      const registry = await read()
      return [...registry.workers].sort((left, right) => (right.registeredAt ?? 0) - (left.registeredAt ?? 0))
    },

    /**
     * 改一个 worker 的显示名。
     *
     * 只动登记表里的名字：会话标题由调用方另行改写，两者可能不同步（会话已不在
     * 内存时宿主拒绝标题改写），登记表这边照样要落到新名字，否则完成通知还喊旧名。
     *
     * @param {string} childId - 子会话 id
     * @param {string} name - 新显示名
     * @returns {Promise<object | undefined>} 改名后的记录；没有这条时 undefined
     */
    async rename(childId, name) {
      return serialize((registry) => {
        const existing = registry.workers.find((item) => item.childId === childId)
        if (existing === undefined) return undefined
        existing.name = name
        return existing
      })
    },

    /**
     * 把一个父会话派出的工改绑到另一个父会话（换 leader 后的接管）。
     *
     * 只改「现在还归它」的记录：`parentSessionId` 等于 `fromId` 的那些。改过的
     * 记录追加一条 `reassignedFrom`（按顺序记历史父会话 id），不抹掉「谁派的工」。
     * 已在别处的记录不动——改绑是幂等的，重复调用不会叠记录。
     *
     * @param {string} fromId - 退役的父会话 id
     * @param {string} toId - 接手的父会话 id
     * @returns {Promise<string[]>} 改绑的 worker 会话 id
     */
    async reassignParent(fromId, toId) {
      if (typeof fromId !== 'string' || fromId === '' || typeof toId !== 'string' || toId === '') return []
      if (fromId === toId) return []
      return serializeDeferredWrite(async (registry, flush) => {
        const moved = []
        for (const record of registry.workers) {
          if (record.parentSessionId !== fromId) continue
          record.reassignedFrom = Array.isArray(record.reassignedFrom)
            ? [...record.reassignedFrom, fromId]
            : [fromId]
          record.parentSessionId = toId
          moved.push(record.childId)
        }
        // 一条都没改到就不写盘（见 serializeDeferredWrite）
        if (moved.length > 0) await flush()
        return moved
      })
    },

    /**
     * 记录一次回合结算。
     *
     * 回报时间是执行者的活性事实：巡查按它判断「多久没动静」，`list_cards` 的
     * 槽位行按它告诉 leader「最后回报在多久前」。结算也是 worker 最近一次被使用，
     * 所以同时更新 `lastUsedAt`。不碰 `registeredAt`（那是登记顺序，不是活跃度）
     * 与父会话归属。
     *
     * 没有这条记录时返回 undefined 且不写盘：派工登记失败是另一条路径上的故障，
     * 不在这里补登记（补出来的记录没有父会话，续聊反而会找错人）。
     *
     * @param {string} childId - worker 会话 id
     * @param {number} [at] - 回报时刻（毫秒）
     * @returns {Promise<object | undefined>} 更新后的记录；没有这条时 undefined
     */
    async markReported(childId, at = Date.now()) {
      return serializeDeferredWrite(async (registry, flush) => {
        const existing = registry.workers.find((item) => item.childId === childId)
        if (existing === undefined) return undefined
        existing.lastReportAt = at
        existing.lastUsedAt = at
        await flush()
        return existing
      })
    },

    /**
     * 记录一次成功投递。
     *
     * LRU 的判据是「最近被 leader 使用」，不是「最近创建」：新会话可能几个月前
     * 建的、一直没再用；刚投过新简报的会话则显然还热。投递成功后再写，失败投递
     * 不改变顺序。没有登记记录时返回 undefined 且不写盘。
     *
     * @param {string} childId - worker 会话 id
     * @param {number} [at] - 使用时刻（毫秒）
     * @returns {Promise<object | undefined>} 更新后的记录；没有这条时 undefined
     */
    async markUsed(childId, at = Date.now()) {
      return serializeDeferredWrite(async (registry, flush) => {
        const existing = registry.workers.find((item) => item.childId === childId)
        if (existing === undefined) return undefined
        existing.lastUsedAt = at
        await flush()
        return existing
      })
    },

    /**
     * 删掉一个 worker 记录。
     *
     * 归档的会话不再能被续聊——宿主的归档闸门会拒绝对它的模型步——记录留着只会
     * 让 `message_worker` 走进一条注定失败的路径。
     *
     * @param {string} childId - 子会话 id
     * @returns {Promise<boolean>} 是否确实删掉了一条
     */
    async remove(childId) {
      return serialize((registry) => {
        const index = registry.workers.findIndex((item) => item.childId === childId)
        if (index === -1) return false
        registry.workers.splice(index, 1)
        return true
      })
    },
  }
}
