/**
 * 项目注册表的落盘存储。
 *
 * **项目是显式注册的实体**，不是从会话反查出来的目录。dsh 自带的 workspace 是
 * 「目录列表 + 按目录归组会话」，对应的是代码语境（目录、文件、git）；项目是编排
 * 语境（协调者会话、卡片、worker、手册），同一个目录可以挂多个项目，二者不合并。
 * 因此注册表独立于会话存储存在。
 *
 * 两条领域规则：
 *
 * - **目录不可改**：项目目录是项目身份的一部分，改目录等于换项目。存储层只接受
 *   `name`、`coordinatorSessionId`、`retiredCoordinatorSessionIds` 与 `workspaceId`
 *   四个可变字段，其余字段原样保留。`workspaceId` 是插件自己注册的工作区 id——它
 *   标明了「这个工作区是我们的」，用户自己加的同目录工作区不会写进来。
 *   `retiredCoordinatorSessionIds` 是被换下的协调者会话，换下后它们作为项目里的
 *   普通会话保留，项目列表按它把它们和 worker 列在一起。
 * - **协调者会话硬绑定**：项目与它的协调者会话是显式指针，不是「目录里最新的那个
 *   会话」这类软约定。
 *
 * 落盘位置在 dsh home 下的自有目录，与卡片库同域；不占用 session 事件流——仓外
 * 插件不得新增 session event 类型。
 *
 * @module dsh-coordinator/host/projects/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MAX_PROJECT_NAME_LENGTH } from '../../shared/projects.js'

const STORE_VERSION = 1

/**
 * 项目记录里允许被修改的字段。
 *
 * 白名单而非黑名单：展开 `updates` 会让 `{id}`、`{directory}` 之类字段绕过校验
 * 直接改写身份字段。
 */
const MUTABLE_FIELDS = Object.freeze([
  'name',
  'coordinatorSessionId',
  'retiredCoordinatorSessionIds',
  'workspaceId',
])

/**
 * 为项目名找一个没被占用的写法。
 *
 * 项目名默认取目录末段，两个不同目录末段同名是常事（`/work/a/repo` 与
 * `/work/b/repo`）。重名本身不破坏数据——id 与目录都不同——但列表里两个一模一样
 * 的名字没法指认。追加 `-2`、`-3` 保持默认名字可用，要改随时用行上的「重命名」。
 *
 * 查重与写入在同一个串行链里完成：先查后写分成两步时，并发建项会双双通过查重。
 *
 * @param {object[]} existingProjects - 注册表里已有的项目
 * @param {string} name - 期望的项目名
 * @returns {string} 未被占用的项目名
 */
export function uniqueProjectName(existingProjects, name) {
  const taken = new Set(
    (Array.isArray(existingProjects) ? existingProjects : [])
      .map((project) => project?.name)
      .filter((value) => typeof value === 'string'),
  )
  if (!taken.has(name)) return name
  // 序号也算进长度上限，否则超长名字加上后缀会被服务层重新拒掉。
  const limit = MAX_PROJECT_NAME_LENGTH
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`
    const candidate = `${name.slice(0, Math.max(1, limit - suffix.length))}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error(`同名项目过多，无法为「${name}」生成新名字`)
}

/**
 * 读取项目注册表；文件缺失返回空表。
 * @param {string} file - 注册表文件路径
 * @param {() => Promise<void>} [onCorrupt] - 表损坏且已备份后的补救动作
 * @returns {Promise<{ version: number, projects: object[] }>} 注册表快照
 */
async function readStore(file, onCorrupt) {
  const raw = await readFile(file, 'utf8').catch(() => undefined)
  if (raw === undefined) return { version: STORE_VERSION, projects: [] }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.projects)) {
      throw new Error('项目注册表结构非法：缺少 projects 数组')
    }
    return { version: STORE_VERSION, projects: parsed.projects.filter(isProjectRecord) }
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`
    await rename(file, backup).catch(() => undefined)
    // 备份后必须写回空表：否则存储文件就此消失，下次启动连「表是空的」都读不出来。
    await onCorrupt?.()
    return { version: STORE_VERSION, projects: [] }
  }
}

/**
 * 判断一条记录是否具备项目必需的字段。
 * @param {unknown} value - 待判断的记录
 * @returns {boolean} 是否是合法项目记录
 */
function isProjectRecord(value) {
  if (value === null || typeof value !== 'object') return false
  const record = /** @type {Record<string, unknown>} */ (value)
  return typeof record.id === 'string' && record.id !== ''
    && typeof record.name === 'string'
    && typeof record.directory === 'string' && record.directory !== ''
}

/**
 * 创建项目注册表存储。
 *
 * @param {object} options - 选项
 * @param {string} options.home - dsh home 目录
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {object} 项目注册表接口
 */
export function createProjectStore({ home, logger = () => {} } = {}) {
  const directory = join(home, 'dsh-coordinator')
  const file = join(directory, 'projects.json')
  const temporary = join(directory, 'projects.json.tmp')

  /** 所有写操作的串行链，保证读-改-写不交错。 */
  let tail = Promise.resolve()

  /**
   * 原子写回注册表。
   * @param {{ version: number, projects: object[] }} store - 注册表快照
   * @returns {Promise<void>} 写盘完成
   */
  async function writeStore(store) {
    await mkdir(directory, { recursive: true })
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  }

  /**
   * 表损坏后的补救：写回空表，避免存储文件就此消失。
   * @returns {Promise<void>} 写盘完成
   */
  async function recoverFromCorruption() {
    await writeStore({ version: STORE_VERSION, projects: [] })
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

    /**
     * 新建一条项目记录（不落盘）。
     *
     * 落盘由调用方决定：建项目要先建协调者会话再一次性写入，失败时不留半条记录。
     *
     * @param {object} input - 建项输入
     * @param {string} input.name - 项目名
     * @param {string} input.directory - 项目目录绝对路径
     * @param {string} [input.coordinatorSessionId] - 协调者会话 id
     * @returns {object} 项目记录
     */
    draft({ name, directory, coordinatorSessionId, workspaceId }) {
      const now = Date.now()
      return {
        id: randomUUID(),
        name,
        directory,
        ...coordinatorSessionId === undefined ? {} : { coordinatorSessionId },
        ...workspaceId === undefined ? {} : { workspaceId },
        createdAt: now,
        updatedAt: now,
      }
    },

    /**
     * 把项目记录写入注册表。
     * @param {object} project - 项目记录
     * @returns {Promise<object>} 落盘后的项目记录
     */
    async insert(project) {
      return serialize(async () => {
        const store = await readStore(file, recoverFromCorruption)
        const name = uniqueProjectName(store.projects, project.name)
        const record = name === project.name ? project : { ...project, name }
        store.projects.push(record)
        await writeStore(store)
        return record
      })
    },

    /**
     * 读单个项目。
     * @param {string} id - 项目 id
     * @returns {Promise<object | undefined>} 项目，不存在时 undefined
     */
    async get(id) {
      const store = await readStore(file, recoverFromCorruption)
      return store.projects.find((item) => item.id === id)
    },

    /**
     * 按协调者会话 id 反查项目。
     * @param {string} sessionId - 会话 id
     * @returns {Promise<object | undefined>} 项目，不存在时 undefined
     */
    async getByCoordinator(sessionId) {
      const store = await readStore(file, recoverFromCorruption)
      return store.projects.find((item) => item.coordinatorSessionId === sessionId)
    },

    /**
     * 列出全部项目，按创建时间升序。
     * @returns {Promise<object[]>} 项目列表
     */
    async list() {
      const store = await readStore(file, recoverFromCorruption)
      return [...store.projects].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    },

    /**
     * 改项目的可变字段。
     *
     * 传 `undefined` 表示清除该字段（`workspaceId` 移除工作区后要清空）。
     *
     * @param {string} id - 项目 id
     * @param {object} updates - 待改字段，只接受 name、coordinatorSessionId、retiredCoordinatorSessionIds 与 workspaceId
     * @returns {Promise<object>} 更新后的项目
     */
    async update(id, updates) {
      return serialize(async () => {
        const store = await readStore(file, recoverFromCorruption)
        const index = store.projects.findIndex((item) => item.id === id)
        if (index === -1) throw new Error(`项目不存在：${id}`)
        const current = store.projects[index]
        const next = { ...current }
        for (const key of MUTABLE_FIELDS) {
          if (Object.hasOwn(updates, key)) next[key] = updates[key]
        }
        // 重命名也要查重：建项时自动避让只是名字唯一性的一半，改名同样能撞上，
        // 列表里会重新出现两个一模一样的项目。这里不偷偷加序号——用户明明打了
        // 这个名字，被改成「X-2」比报错让他改更意外。
        if (next.name !== current.name
          && store.projects.some((item) => item.id !== id && item.name === next.name)) {
          throw new Error(`项目名「${next.name}」已被占用`)
        }
        next.updatedAt = Date.now()
        store.projects[index] = next
        await writeStore(store)
        return next
      })
    },

    /**
     * 删项目。
     * @param {string} id - 项目 id
     * @returns {Promise<object | undefined>} 被删的项目，不存在时 undefined
     */
    async remove(id) {
      return serialize(async () => {
        const store = await readStore(file, recoverFromCorruption)
        const index = store.projects.findIndex((item) => item.id === id)
        if (index === -1) return undefined
        const [removed] = store.projects.splice(index, 1)
        await writeStore(store)
        return removed
      })
    },
  }
}
