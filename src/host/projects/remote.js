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

import { loadSlotTemplates } from '../slots/slot-templates.js'
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
     * 建项目：建实体 + 建协调者会话 + 绑定。
     * @param {string} directory - 项目目录绝对路径
     * @param {string} name - 项目名
     * @returns {Promise<object>} 建成的项目
     */
    async create(directory, name) {
      return this.projects.create({ directory, name })
    }

    /**
     * 删除项目：先移除插件为它注册的工作区，再删项目记录。
     *
     * 工作区删除只删注册，目录与全部会话日志保留，会话因此落到宿主工作区树的
     * 「未分组」下；协调者会话本身也保留。
     *
     * 「没有工作区可移除」（`skipped`：宿主没有工作区服务、项目没有插件注册的
     * 工作区、工作区已不在宿主里）不带 `reason`——那不是故障，客户端据此落到
     * 「文件夹与会话记录保留」那一支提示。宿主工作区服务不支持删除是真失败，
     * `reason` 带回原因，项目照删。
     *
     * 项目已经不在了时报 `notFound`：删除是幂等的，客户端据此按成功收尾而不是
     * 把「项目不存在」报成删除失败。
     *
     * @param {string} id - 项目 id
     * @returns {Promise<{removed: boolean, workspaceRemoved: boolean, notFound?: boolean, skipped?: boolean, reason?: string}>} 删除结果
     */
    async deleteProject(id) {
      const result = await this.projects.remove(id)
      if (result === undefined) {
        return { removed: false, workspaceRemoved: false, notFound: true, reason: '项目不存在。' }
      }
      const workspaceRemoved = result.workspace.removed === true
      if (result.workspace.reason !== undefined) {
        return { removed: true, workspaceRemoved, reason: result.workspace.reason }
      }
      return result.workspace.skipped === true
        ? { removed: true, workspaceRemoved, skipped: true }
        : { removed: true, workspaceRemoved }
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
     * 换新协调者会话并改绑。
     * @param {string} id - 项目 id
     * @returns {Promise<object>} 更新后的项目
     */
    async replaceCoordinator(id) {
      return this.projects.replaceCoordinator(id)
    }

    /**
     * 确保协调者会话挂在项目目录对应的工作区上。
     *
     * 归属是为了分组：不归属就落官方左栏的「未分组」，而本仓把项目会话行藏了，
     * 那里只剩一棵空组头。目录还不是工作区时顺带注册一个（幂等）。
     *
     * @param {string} id - 项目 id
     * @returns {Promise<{attached: boolean, workspaceId?: string, reason?: string}>} 挂载结果
     */
    async attachCoordinator(id) {
      return this.projects.attachCoordinator(id)
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
     * 判据与卡片归属同一套：协调者会话走项目注册表的指针，其它会话按 cwd 与项目
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
     * 看板按项目取卡：一个项目一个看板，跨会话聚合（协调者建的卡与 worker 建的
     * 卡在一处）。卡片真源在宿主的卡片库里，不从会话事件流重建。
     *
     * @param {string} projectId - 项目 id
     * @returns {Promise<object[]>} 该项目的全部卡片
     */
    async boardCards(projectId) {
      return this.cards.list({ projectId })
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
