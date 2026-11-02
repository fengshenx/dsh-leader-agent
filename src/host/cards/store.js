/**
 * 任务看板卡片的落盘存储。
 *
 * 卡片是任务管理单元（会话是执行单元）：标题、规格、状态、链接与槽位绑定都落盘；
 * 信号灯（等你/需注意/推进/停滞）不落盘，由看板按名下会话状态纯投影。
 *
 * 三条领域规则，任何改动都必须保持：
 *
 * - **编号不复用**：卡片编号全局递增，归档或删除都不回收，用户可用 `@#n` 引用。
 * - **乐观并发**：带 `expectedRevision` 时校验版本，版本不符即冲突，不落盘。
 * - **archived 是终态**：归档后不可再改；`active ⇄ done` 可逆。
 *
 * 卡片归属项目：一个项目一个看板，看板按项目取卡。归属由宿主按建卡会话判定
 * （协调者会话 → 它的项目；其它会话 → cwd 与项目目录相同者），模型不传参。
 * 存量卡片没有归属，不出现在任何项目看板里。
 *
 * 落盘位置在 dsh home 下的自有目录，不占用 session 事件流——仓外插件不得新增
 * session event 类型。
 *
 * @module dsh-leader-kit/host/cards/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const STORE_VERSION = 1

/**
 * 卡片状态的合法取值。
 * @type {readonly ['active', 'done', 'archived']}
 */
export const CARD_STATUSES = Object.freeze(['active', 'done', 'archived'])

/**
 * 落盘用的文件系统调用。
 *
 * 抽成可替换的依赖是为了让测试能构造确定的读写交错——索引重建与写卡同时发生时，
 * 谁先谁后靠真实文件系统是排不出来的。
 */
const defaultIo = Object.freeze({ mkdir, readFile, rename, writeFile })

/**
 * 读取卡片库；文件缺失返回空库。
 * @param {string} file - 卡片库文件路径
 * @param {() => Promise<void>} [onCorrupt] - 库损坏且已备份后的补救动作
 * @param {object} [io] - 文件系统调用
 * @returns {Promise<{ version: number, counter: number, cards: object[] }>} 卡片库快照
 */
async function readStore(file, onCorrupt, io = defaultIo) {
  const raw = await io.readFile(file, 'utf8').catch(() => undefined)
  if (raw === undefined) return { version: STORE_VERSION, counter: 0, cards: [] }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.cards)) {
      throw new Error('卡片库结构非法：缺少 cards 数组')
    }
    const counter = Math.max(
      Number.isInteger(parsed.counter) && parsed.counter >= 0 ? parsed.counter : 0,
      // counter 可能丢失或被外部改写而小于存量卡片的最大编号；此时必须以存量
      // 编号为准，否则新卡会与存量卡重号，违反「编号不复用」。
      parsed.cards.reduce(
        (highest, card) => (Number.isInteger(card?.number) && card.number > highest ? card.number : highest),
        0,
      ),
    )
    return { version: STORE_VERSION, counter, cards: parsed.cards }
  } catch (error) {
    const backup = `${file}.corrupt-${Date.now()}`
    await rename(file, backup).catch(() => undefined)
    // 备份后必须写回空库：否则存储文件就此消失，下次启动连"库是空的"都读不出来。
    await onCorrupt?.()
    return { version: STORE_VERSION, counter: 0, cards: [] }
  }
}

/**
 * 创建卡片存储。
 *
 * @param {object} options - 存储选项
 * @param {string} options.home - dsh home 目录
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @param {object} [options.io] - 文件读写实现（测试可替换）
 * @param {() => number} [options.clock] - 取当前时间的函数：排序依赖卡片更新时间戳，
 *   同一毫秒内的两次写入会退回插入序，测试可注入可控时钟避免这种巧合
 * @returns {object} 卡片存储接口
 */
export function createCardStore({ home, logger = () => {}, io = defaultIo, clock = Date.now } = {}) {
  const directory = join(home, 'dsh-leader-kit')
  const file = join(directory, 'cards.json')
  const temporary = join(directory, 'cards.json.tmp')

  /** 所有写操作的串行链，保证读-改-写不交错。 */
  let tail = Promise.resolve()

  /**
   * 会话 id 到槽位名的反查索引。
   *
   * 槽位绑定只存在于卡片库（异步落盘），而提示词组装是同步的——组装函数里
   * `await` 不了。因此这里维护一份内存镜像。卡片库仍是真源，进程启动时用
   * `loadSlotIndex` 重建。
   */
  const slotIndex = new Map()

  /**
   * 原子写回卡片库。
   * @param {{ version: number, counter: number, cards: object[] }} store - 卡片库快照
   * @returns {Promise<void>} 写盘完成
   */
  async function writeStore(store) {
    await io.mkdir(directory, { recursive: true })
    await io.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await io.rename(temporary, file)
  }

  /**
   * 库损坏后的补救：写回空库，避免存储文件就此消失。
   * @returns {Promise<void>} 写盘完成
   */
  async function recoverFromCorruption() {
    await writeStore({ version: STORE_VERSION, counter: 0, cards: [] })
  }

  /**
   * 串行执行写操作。
   * @template T
   * @param {() => Promise<T>} operation - 写操作
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

    slotIndex,

    /**
     * 建卡。编号在此分配，之后永不复用。
     * @param {object} input - 建卡输入
     * @param {string} input.title - 任务标题
     * @param {string} [input.spec] - 任务规格
     * @param {object[]} [input.links] - 链接条目
     * @param {object} [input.slots] - 槽位绑定
     * @param {string} [input.projectId] - 所属项目 id；宿主按调用方会话判定
     * @param {string} [input.createdBy] - 建卡会话 id
     * @returns {Promise<object>} 新建的卡片
     */
    async create({ title, spec, links, slots, projectId, createdBy }) {
      return serialize(async () => {
        const store = await readStore(file, recoverFromCorruption, io)
        const now = clock()
        const card = {
          id: randomUUID(),
          number: store.counter + 1,
          revision: 0,
          title,
          ...spec === undefined ? {} : { spec },
          status: 'active',
          ...links === undefined ? {} : { links },
          ...slots === undefined ? {} : { slots },
          ...projectId === undefined ? {} : { projectId },
          ...createdBy === undefined ? {} : { createdBy },
          createdAt: now,
          updatedAt: now,
        }
        store.counter = card.number
        store.cards.push(card)
        await writeStore(store)
        rebuildSlotIndex(store.cards, slotIndex)
        return card
      })
    },

    /**
     * 改卡。带 `expectedRevision` 时做乐观并发校验。
     * @param {object} input - 改卡输入
     * @param {string} input.id - 卡片 id
     * @param {number} [input.expectedRevision] - 期望的内容版本
     * @param {string} [input.title] - 新标题
     * @param {string} [input.spec] - 新规格
     * @param {string} [input.status] - 新状态
     * @param {object[]} [input.links] - 新链接条目
     * @param {object} [input.slots] - 新槽位绑定
     * @param {number} [input.sortOrder] - 手动排序序号
     * @returns {Promise<object>} 更新后的卡片
     */
    async update({
      id,
      expectedRevision,
      title,
      spec,
      status,
      links,
      slots,
      sortOrder,
    }) {
      return serialize(async () => {
        const store = await readStore(file, recoverFromCorruption, io)
        const card = store.cards.find((item) => item.id === id)
        if (card === undefined) throw new Error(`卡片不存在：${id}`)
        const current = card.revision ?? 0
        if (expectedRevision !== undefined && expectedRevision !== current) {
          throw new Error(
            `卡片版本冲突：期望 ${expectedRevision}，当前 ${current}；请重新读取卡片后判断`,
          )
        }
        if (card.status === 'archived') {
          throw new Error(`卡片 ${id} 已归档，归档是终态，不可再改`)
        }
        if (status !== undefined && !CARD_STATUSES.includes(status)) {
          throw new Error(`卡片状态非法：${String(status)}`)
        }
        const now = clock()
        const next = { ...card }
        if (title !== undefined) next.title = title
        if (spec !== undefined) next.spec = spec
        if (links !== undefined) next.links = links
        if (slots !== undefined) next.slots = slots
        if (sortOrder !== undefined) next.sortOrder = sortOrder
        if (status !== undefined && status !== card.status) {
          next.status = status
          if (status === 'done') next.doneAt = now
          if (status === 'active') delete next.doneAt
        }
        // 内容没有实质变化时不 bump revision、不落盘：零字段调用不是内容更新，
        // 无谓的版本递增会作废其他会话持有的 expectedRevision，人为制造冲突。
        if (isSameContent(card, next)) return card
        // checkpoint 已废弃：旧记录里的字段在下一次实质更新时顺带清掉，不为它
        // 单独 bump revision。
        delete next.checkpoint
        next.revision = current + 1
        next.updatedAt = now
        store.cards[store.cards.indexOf(card)] = next
        await writeStore(store)
        // 改卡后必须同步索引：否则「槽位改绑后下一轮 turn 仍注入旧角色」，
        // 恰好破坏「变更在下一轮生效」这条结构性保证。
        rebuildSlotIndex(store.cards, slotIndex)
        return next
      })
    },

    /**
     * 摘掉所有卡片上指向某个会话的槽位绑定。
     *
     * 会话归档后它的绑定就是死引用：卡片还在看板上挂着「执行者」，点开却没有去处；
     * 槽位索引也仍会把这个会话的角色注入下一轮 turn。归档是「这个会话收工了」的
     * 声明，绑定理应一起失效。
     *
     * 已归档的卡片一起摘：它们不再出现在看板上，槽位索引却不区分卡片状态，留着
     * 就是留一条继续注入的残留。
     *
     * @param {string} sessionId - 会话 id
     * @returns {Promise<{cards: string[], slots: number}>} 被改的卡片 id 与摘掉的槽位数
     */
    async detachSession(sessionId) {
      return serialize(async () => {
        const store = await readStore(file, recoverFromCorruption, io)
        const touched = []
        let removed = 0
        const now = clock()
        store.cards = store.cards.map((card) => {
          const slots = card?.slots
          if (slots === null || typeof slots !== 'object' || Array.isArray(slots)) return card
          const kept = {}
          let changed = false
          for (const [name, binding] of Object.entries(slots)) {
            if (binding?.sessionId === sessionId) {
              changed = true
              removed += 1
              continue
            }
            kept[name] = binding
          }
          if (!changed) return card
          touched.push(card.id)
          return {
            ...card,
            slots: kept,
            revision: (card.revision ?? 0) + 1,
            updatedAt: now,
          }
        })
        if (touched.length === 0) return { cards: [], slots: 0 }
        await writeStore(store)
        rebuildSlotIndex(store.cards, slotIndex)
        return { cards: touched, slots: removed }
      })
    },

    /**
     * 读单张卡片。
     * @param {string} id - 卡片 id
     * @returns {Promise<object | undefined>} 卡片，不存在时 undefined
     */
    async get(id) {
      const store = await readStore(file, recoverFromCorruption, io)
      return store.cards.find((item) => item.id === id)
    },

    /**
     * 重建槽位反查索引。
     *
     * 进程启动时调用：内存索引是进程内的，崩溃后不会留下，索引必须从卡片库恢复。
     *
     * 必须排在写链上：读盘与重建之间若插进一次写卡，重建会用旧快照覆盖索引，
     * 丢掉刚落盘的槽位绑定，直到下一次改卡才恢复。
     *
     * @returns {Promise<Map<string, string>>} 重建后的索引
     */
    async loadSlotIndex() {
      return serialize(async () => {
        const store = await readStore(file, recoverFromCorruption, io)
        rebuildSlotIndex(store.cards, slotIndex)
        return slotIndex
      })
    },

    /**
     * 列出卡片，按编号升序。
     * @param {object} [filter] - 过滤条件
     * @param {string} [filter.status] - 只返回该状态的卡片
     * @param {string} [filter.projectId] - 只返回该项目的卡片；空串表示无归属的卡片
     * @returns {Promise<object[]>} 卡片列表
     */
    async list({ status, projectId } = {}) {
      const store = await readStore(file, recoverFromCorruption, io)
      const cards = [...store.cards].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
      return cards
        .filter((card) => status === undefined || card.status === status)
        .filter((card) => projectId === undefined || projectIdOf(card) === projectId)
    },

    /**
     * 列出某个会话挂在哪些卡片的哪些槽位上。
     *
     * 一个会话可以被多张卡同时绑定（槽位是投影，不是排他归属），所以这里返回
     * 全部匹配项而不是挑一个——投递门禁要按「任一 active 卡」判断，只看最新的
     * 那张会漏判。
     *
     * @param {string} sessionId - 会话 id
     * @returns {Promise<{ cardId: string, number: number, title: string, status: string, slot: string }[]>} 绑定列表
     */
    async bindingsOf(sessionId) {
      const store = await readStore(file, recoverFromCorruption, io)
      const bindings = []
      for (const card of [...store.cards].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))) {
        const slots = card?.slots
        if (slots === null || typeof slots !== 'object' || Array.isArray(slots)) continue
        for (const [slot, binding] of Object.entries(slots)) {
          if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) continue
          if (binding.sessionId !== sessionId) continue
          bindings.push({
            cardId: String(card.id),
            number: typeof card.number === 'number' ? card.number : 0,
            title: String(card.title ?? ''),
            status: String(card.status ?? 'active'),
            slot,
          })
        }
      }
      return bindings
    },
  }
}

/**
 * 按卡片库重建「会话 id → 槽位名」的反查索引。
 *
 * 一个会话可能同时被多张卡片绑到不同槽位上。按编号升序遍历、后者覆盖前者，
 * 使编号更大的卡片（更新的意图）胜出，规则确定且与卡片新旧顺序一致。
 *
 * @param {object[]} cards - 卡片数组
 * @param {Map<string, string>} target - 待写入的索引
 * @returns {void}
 */
function rebuildSlotIndex(cards, target) {
  target.clear()
  const ordered = [...cards].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
  for (const card of ordered) {
    const slots = card?.slots
    if (slots === null || typeof slots !== 'object' || Array.isArray(slots)) continue
    for (const [name, binding] of Object.entries(slots)) {
      if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) continue
      const sessionId = binding.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') continue
      target.set(sessionId, name)
    }
  }
}

/**
 * 取卡片的项目归属。
 *
 * 存量卡片没有 `projectId` 字段，一律算无归属（空串）——它们的创建会话没被
 * 记下来，无法可靠反推是哪个项目的。
 *
 * @param {object} card - 卡片
 * @returns {string} 项目 id；无归属时是空串
 */
function projectIdOf(card) {
  return typeof card?.projectId === 'string' ? card.projectId : ''
}

/**
 * 判断两次更新之间卡片内容是否相同。版本与时间戳不参与比较。
 * @param {object} current - 更新前的卡片
 * @param {object} next - 待落盘的卡片
 * @returns {boolean} 内容是否相同
 */
function isSameContent(current, next) {
  const { revision: _currentRevision, updatedAt: _currentUpdatedAt, ...currentRest } = current
  const { revision: _nextRevision, updatedAt: _nextUpdatedAt, ...nextRest } = next
  return JSON.stringify(currentRest) === JSON.stringify(nextRest)
}

