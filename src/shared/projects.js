/**
 * 项目数据的 Typert 通道契约。
 *
 * 宿主侧与浏览器侧共用：服务键、线上命名空间、方法名与参数名。放在 `shared/`
 * 是因为两端各跑各的进程，浏览器半边不能 import 宿主模块里的实现。
 *
 * 通道走 dsh 官方的 Typert 远程调用（`/api` 共享通道），与工作区控制器同构：
 * 宿主侧把服务注册进 Cordis，浏览器侧把同一批方法挂到 `ctx.remote` 上。
 *
 * @module dsh-leader-kit/shared/projects
 */

/** 宿主侧的 Cordis 服务键。 */
export const PROJECT_REMOTE_SERVICE_KEY = 'dsh-leader-kitProjects'

/** 线上命名空间，即 endpoint 的 `namespace/method` 前缀。 */
export const PROJECT_REMOTE_NAMESPACE = 'projects'

/** 项目名的长度上限。宿主侧校验与浏览器侧前置校验共用同一个数。 */
export const MAX_PROJECT_NAME_LENGTH = 200

/**
 * 每个远程方法的参数：参数名 → 线上类型。
 *
 * 参数名同时是宿主侧方法的形参与浏览器侧 descriptor 的 wire 字段名——Typert 的
 * SRC 通道按宿主方法源码里的形参名建 wire 字段，两边必须逐字一致。类型只给
 * 浏览器侧的严格 codec 用：`string` 是标量，`links` 是链接条目数组（形状由
 * 共享的 `card-links.js` 校验）。
 *
 * 方法名要避开官方命名空间服务保留的字（`ctx`、`name`、`methods` 等，以及
 * Cordis 服务原型的成员）：官方在挂载前会逐个检查，撞名即拒收整个命名空间。
 */
export const PROJECT_REMOTE_METHODS = Object.freeze({
  list: Object.freeze({}),
  create: Object.freeze({ directory: 'string', name: 'string' }),
  deleteProject: Object.freeze({ id: 'string' }),
  rename: Object.freeze({ id: 'string', name: 'string' }),
  reorder: Object.freeze({ id: 'string', beforeId: 'string' }),
  replaceLeader: Object.freeze({ id: 'string' }),
  sessionsByProject: Object.freeze({}),
  resolveProject: Object.freeze({ sessionId: 'string' }),
  boardCards: Object.freeze({ projectId: 'string' }),
  projectSlots: Object.freeze({ projectId: 'string' }),
  detachSession: Object.freeze({ sessionId: 'string' }),
  updateCardLinks: Object.freeze({ id: 'string', links: 'links' }),
})
