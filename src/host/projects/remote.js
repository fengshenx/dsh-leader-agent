/**
 * 项目数据的 Typert 远程服务（宿主侧）。
 *
 * 与工作区控制器同构：服务注册进 Cordis，方法通过 dsh 官方的 `/api` 通道被
 * 浏览器侧调用，鉴权、传输与错误语义都走官方链路。
 *
 * 这里手写协议形状而不安装 `@deepseek-ai/dsh-typert-protocol`：协议包是 dsh
 * 内部包，仓外 bundle 装它会被宿主的版本校验卡住，而它的标记契约是稳定字符串
 * + 版本化描述符，宿主读标记时不校验来源包的版本。手写的部分只有两处——
 * 原型上的方法标记与实例上的服务绑定，宿主的 SRC 通道据此还原调用描述符。
 *
 * @module dsh-leader-kit/host/projects/remote
 */

import { randomUUID } from 'node:crypto'
import { loadSlotTemplates } from '../slots/slot-templates.js'
import { normalizeLinkDrafts } from '../../shared/card-links.js'
import {
  PROJECT_REMOTE_METHODS,
  PROJECT_REMOTE_NAMESPACE,
  PROJECT_REMOTE_SERVICE_KEY,
} from '../../shared/projects.js'

/**
 * 协议包把 Remote 方法标记写在原型的这个属性上。属性名是稳定字符串，宿主读标记
 * 时不校验来源包的版本。
 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * 构造原型上的方法标记表。
 *
 * 标记里的方法名必须与实例上的方法名逐字一致：宿主按标记找实现方法，再按实现
 * 方法的形参名还原 wire 字段。
 *
 * @returns {{version: number, methods: ReadonlyArray<object>}} 版本化描述符
 */
function buildMethodDescriptor() {
  const methods = Object.keys(PROJECT_REMOTE_METHODS).map((method) => Object.freeze({
    method,
    invocation: Object.freeze({ kind: 'direct' }),
  }))
  return Object.freeze({ version: 1, methods: Object.freeze(methods) })
}

/**
 * 建项目数据的远程服务并注册进 Cordis。
 *
 * @param {object} options - 装配选项
 * @param {object} options.service - 项目服务（`src/host/projects/service.js`）
 * @param {object} options.cards - 卡片存储（`src/host/cards/store.js`）
 * @param {object} options.workers - worker 登记表（`src/host/worker-registry.js`）
 * @param {object} [options.workerSessions] - worker 会话管理器（`src/host/worker-sessions.js`）
 * @param {object} options.ctx - 宿主 Cordis 上下文
 * @returns {object} 已注册的远程服务实例
 */
export function createProjectRemote({ service, cards, workers, workerSessions, ctx }) {
  // 归档后的收尾要同时改两张表：漏传任何一张，问题都要等到会话真的被归档时才
  // 以 `Cannot read properties of undefined` 暴露，那时用户看到的是「归档失败」。
  if (typeof cards?.detachSession !== 'function') {
    throw new Error('dsh-leader-kit: createProjectRemote 缺少 cards，归档后无法摘卡')
  }
  if (typeof workers?.remove !== 'function') {
    throw new Error('dsh-leader-kit: createProjectRemote 缺少 workers，归档后无法摘派工登记')
  }
  class ProjectRemote {
    /**
     * @param {object} service - 项目服务
     * @param {object} cards - 卡片存储
     * @param {object} workers - worker 登记表
     * @param {object} [workerSessions] - worker 会话管理器
     */
    constructor(service, cards, workers, workerSessions) {
      this.projects = service
      this.cards = cards
      this.workers = workers
      this.workerSessions = workerSessions
      // 服务绑定：宿主据此认出「这个服务导出哪个命名空间」。绑定里的 service 必须
      // 指向服务实例本身，宿主会拿它与调用时取到的实例比对。
      this.typertRemote = {
        service: this,
        serviceKey: PROJECT_REMOTE_SERVICE_KEY,
        namespace: PROJECT_REMOTE_NAMESPACE,
      }
    }

    /**
     * 列项目。
     * @returns {Promise<object[]>} 项目列表
     */
    async list() {
      return this.projects.list()
    }

    /**
     * 建项目：建实体 + 建 leader 会话 + 绑定。
     * @param {string} directory - 项目目录绝对路径
     * @param {string} name - 项目名
     * @returns {Promise<object>} 建成的项目
     */
    async create(directory, name) {
      return this.projects.create({ directory, name })
    }

    /**
     * 删除项目记录。
     *
     * 只删项目：目录、会话日志与用户在 dsh 里加的工作区都原样保留。
     *
     * 项目已经不在了时报 `notFound`：删除是幂等的，客户端据此按成功收尾而不是
     * 把「项目不存在」报成删除失败。
     *
     * @param {string} id - 项目 id
     * @returns {Promise<{removed: boolean, notFound?: boolean, reason?: string}>} 删除结果
     */
    async deleteProject(id) {
      const result = await this.projects.remove(id)
      return result === undefined
        ? { removed: false, notFound: true, reason: '项目不存在。' }
        : { removed: true }
    }

    /**
     * 改项目名。
     * @param {string} id - 项目 id
     * @param {string} name - 新项目名
     * @returns {Promise<object>} 更新后的项目
     */
    async rename(id, name) {
      return this.projects.rename(id, name)
    }

    /**
     * 调整项目在列表里的位置：移到 `beforeId` 之前，空串表示末尾。
     * @param {string} id - 项目 id
     * @param {string} beforeId - 落点项目 id；空串表示末尾
     * @returns {Promise<void>} 完成
     */
    async reorder(id, beforeId) {
      return this.projects.reorder(id, beforeId)
    }

    /**
     * 换新 leader 会话并改绑。
     * @param {string} id - 项目 id
     * @returns {Promise<object>} 更新后的项目
     */
    async replaceLeader(id) {
      return this.projects.replaceLeader(id)
    }

    /**
     * 列项目下的会话。
     * @returns {Promise<{projectId: string, sessionIds: string[]}[]>} 每个项目的会话 id 列表
     */
    async sessionsByProject() {
      return this.projects.sessionsByProject()
    }

    /**
     * 解析某个会话所属的项目。
     *
     * 判据与卡片归属同一套：leader 会话走项目注册表的指针，其它会话按 cwd 与项目
     * 目录的 canonical 路径相等。
     *
     * @param {string} sessionId - 会话 id
     * @returns {Promise<object | undefined>} 项目摘要；不归属任何项目时 undefined
     */
    async resolveProject(sessionId) {
      return this.projects.resolveProjectOfSession(sessionId)
    }

    /**
     * 摘掉一个会话在卡片槽位与派工登记表上的痕迹。
     *
     * 由浏览器侧在会话归档成功后调用：归档本身走宿主的 `workspaces` 服务（会话
     * 还在跑时会被拒绝，那时不该动卡片），这里只做归档之后的收尾。
     *
     * 两处收尾是**顺序的两次独立落盘**，不是一次事务：摘卡失败就直接抛出，登记表
     * 不会被碰，因此不会出现「卡没摘、登记先没了」；反过来摘卡成功而摘登记失败时，
     * 会留下一条指向已归档会话的登记（`message_worker` 会走进一条宿主注定拒绝的
     * 路径）。这个方向的不一致比反过来轻，所以顺序保持「先卡后表」。
     *
     * @param {string} sessionId - 会话 id
     * @returns {Promise<{cards: string[], slots: number, worker: boolean, disposed: boolean}>} 摘除结果
     */
    async detachSession(sessionId) {
      const detached = await this.cards.detachSession(sessionId)
      const worker = await this.workers.remove(sessionId)
      // worker 会话是常驻根会话，归档不会自己停掉它：不 dispose 的话它还在内存里
      // 跑、还在写会话日志，而用户以为它已经归档了。
      const disposed = typeof this.workerSessions?.dispose === 'function'
        ? await this.workerSessions.dispose(sessionId)
        : false
      return { ...detached, worker, disposed }
    }

    /**
     * 列某个项目的看板卡片。
     *
     * 看板按项目取卡：一个项目一个看板，跨会话聚合（leader 建的卡与 worker 建的
     * 卡在一处）。卡片真源在宿主的卡片库里，不从会话事件流重建。
     *
     * @param {string} projectId - 项目 id
     * @returns {Promise<object[]>} 该项目的全部卡片
     */
    async boardCards(projectId) {
      return this.cards.list({ projectId })
    }

    /**
     * 整体替换一张卡的链接条目。
     *
     * 看板的写通道只有这一处：卡片其余字段仍归 leader 工具，界面不越权改。
     * 不传 `expectedRevision`——详情浮层拿的是打开瞬间的快照，用户编辑期间
     * leader 改过卡时，用快照版本号会稳定触发冲突，而用户在这里表达的意图就是
     * 「这些链接现在是这样」。
     *
     * `links` 来自浏览器，必须在这里按同一份共享判定重新校验：客户端校验只
     * 是即时反馈，不能当成写入边界。
     *
     * **不做项目归属校验**：远程方法在 `direct` 调用里拿不到调用方会话，无法像
     * `create_card` / `update_card` 那样按会话反查项目、比对卡片归属。这是单机
     * 单用户威胁模型下的取舍——这条通道走官方 `/api` 的同源链路，能调它的本机
     * 页面或进程本来就能读写本机数据；它不比卡片工具更宽，只是少了一道「防误用」
     * 的一致性检查。要挡 bug 可以给方法加 `projectId` 参数做一致性校验，但它
     * 不提升安全性。
     *
     * @param {string} id - 卡片 id
     * @param {object[]} links - 链接条目（整体替换）
     * @returns {Promise<object>} 更新后的卡片
     */
    async updateCardLinks(id, links) {
      if (typeof id !== 'string' || id === '') throw new Error('updateCardLinks: id 不能为空')
      const normalized = normalizeLinkDrafts(links)
      if (normalized.error !== undefined) throw new Error(`updateCardLinks: ${normalized.error}`)
      // 缺 id 的条目在这里补：卡片链接的 id 是稳定标识，看板按它做 React key，
      // 缺了就只能退回「标签 + 序号」，标签一改就换节点。
      const prepared = normalized.links.map((link) => (
        link.id === undefined ? { ...link, id: randomUUID() } : link
      ))
      return this.cards.update({ id, links: prepared })
    }

    /**
     * 项目的槽位显示名字典。
     *
     * 看板渲染槽位 chip 时用：槽位键是机器标识，显示名由项目 `SLOTS.md` 的
     * `label:` 决定。只返回声明了显示名的槽位，没声明的由界面回落 locale 字典
     * 或原名——这里不替项目编名字。
     *
     * 项目不存在时返回空字典：标签是装饰信息，取不到不该让看板报错。
     *
     * @param {string} projectId - 项目 id
     * @returns {Promise<Record<string, string>>} 槽位名到显示名
     */
    async projectSlots(projectId) {
      const project = await this.projects.get(projectId)
      if (project === undefined) return {}
      /** @type {Record<string, string>} */
      const labels = {}
      for (const [name, slot] of loadSlotTemplates(project.directory)) {
        if (slot.label !== undefined) labels[name] = slot.label
      }
      return labels
    }
  }

  Object.defineProperty(ProjectRemote.prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: buildMethodDescriptor(),
  })

  const remote = new ProjectRemote(service, cards, workers, workerSessions)
  ctx.provide(PROJECT_REMOTE_SERVICE_KEY, remote)
  return remote
}
