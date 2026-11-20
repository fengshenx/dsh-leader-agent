/**
 * 项目数据的 Typert 客户端（浏览器侧）。
 *
 * 与宿主侧的手写协议形状对称：浏览器侧把同一批方法挂到 `ctx.remote` 的
 * `projects` 命名空间上，之后的调用就是普通的远程方法调用，传输与鉴权走官方
 * `/api` 通道。
 *
 * 客户端侧要求每个入参带严格 codec（`$mount` 会拒收没有严格 codec 的描述符）。
 * 这些 codec 只服务挂载校验：调用时宿主按**自己**从服务实例派生出的描述符
 * （`src-json`）派发，不读这里的 parse。真正的入参边界在宿主侧——所以
 * `updateCardLinks` 里会再规范化一遍链接。
 *
 * @module dsh-leader-agent/client/project-remote
 */

import {
  PROJECT_REMOTE_METHODS,
  PROJECT_REMOTE_NAMESPACE,
  PROJECT_REMOTE_SERVICE_KEY,
} from '../shared/projects.js'

/**
 * 造一个字符串入参的严格 codec。
 * @returns {object} codec
 */
function stringCodec() {
  return {
    mode: 'strict',
    typeSymbol: 'string',
    create: () => ({
      parse: (value) => {
        if (typeof value !== 'string') throw new TypeError(`期望字符串，收到 ${typeof value}`)
        return value
      },
    }),
  }
}

/**
 * 造一个链接数组入参的严格 codec。
 *
 * 只校验「是数组」：条目形状由共享的 `card-links.js` 在保存前规范化，宿主侧
 * 写通道还会再校验一遍。这里不做第二套字段规则，免得两端判定漂移。这个
 * `parse` 只用于满足挂载校验，运行时不执行（见文件头）。
 *
 * @returns {object} codec
 */
function linksCodec() {
  return {
    mode: 'strict',
    typeSymbol: 'array',
    create: () => ({
      parse: (value) => {
        if (!Array.isArray(value)) throw new TypeError(`期望链接数组，收到 ${typeof value}`)
        return value
      },
    }),
  }
}

/**
 * 线上类型 → codec 工厂。
 *
 * 类型表是 `src/shared/projects.js` 的静态字面量，只有这两种；查表比逐个
 * `if` 少一条永远走不到的 throw，拼错的类型名会在这里抛 TypeError，不会
 * 静默退回某个默认 codec。表用 `Object.create(null)` 起：普通对象字面量会把
 * `toString` / `constructor` 这类原型链键查成函数，拼错成它们时反而不抛。
 */
const CODEC_FACTORIES = Object.assign(Object.create(null), { string: stringCodec, links: linksCodec })

/**
 * 按契约里的线上类型取 codec。
 *
 * 导出只给单测：要让原型链键（`toString` 等）走不到表里，得能直接按类型取一次。
 *
 * @param {string} type - `string` / `links`
 * @returns {object} codec
 */
export function codecFor(type) {
  return CODEC_FACTORIES[type]()
}

/**
 * 造一个方法的客户端描述符。
 * @param {string} method - 方法名
 * @returns {object} 描述符
 */
function buildDescriptor(method) {
  const parameters = Object.entries(PROJECT_REMOTE_METHODS[method]).map(([name, type]) => ({
    name,
    wire: name,
    source: 'json',
    codec: codecFor(type),
  }))
  return {
    id: `dsh-leader-agent:${PROJECT_REMOTE_NAMESPACE}/${method}`,
    service: PROJECT_REMOTE_SERVICE_KEY,
    namespace: PROJECT_REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters,
    result: { mode: 'src-json' },
  }
}

/** 客户端贡献：宿主与浏览器共用的那批方法。 */
export const PROJECT_REMOTE_CONTRIBUTION = Object.freeze({
  package: 'dsh-leader-agent',
  descriptors: Object.freeze(
    Object.keys(PROJECT_REMOTE_METHODS).map((method) => Object.freeze(buildDescriptor(method))),
  ),
})

/** 命名空间在 Cordis 里的服务键，与官方 gateway 的拼法一致。 */
const NAMESPACE_SERVICE_KEY = `remote.${PROJECT_REMOTE_NAMESPACE}`

const readyListeners = new Set()
let ready = false

/**
 * 项目通道错误。插件自有诊断只保留 code；界面文案由调用方按当前语言映射，
 * 宿主给的 `result.error.message` 原样留在 `detail`，不在这里拼接。
 */
export class ProjectRemoteError extends Error {
  /**
   * @param {'remote-missing' | 'namespace-missing' | 'call-failed'} code - 错误码
   * @param {{ method?: string, hostCode?: string, detail?: string }} [details] - 调用上下文
   */
  constructor(code, { method, hostCode, detail } = {}) {
    super(code)
    this.name = 'ProjectRemoteError'
    this.code = code
    this.method = method
    this.hostCode = hostCode
    this.detail = typeof detail === 'string' ? detail : ''
  }
}

/**
 * 通道是否已挂好。
 * @returns {boolean} 是否可调用
 */
export function isProjectRemoteReady() {
  return ready
}

/**
 * 订阅通道就绪事件。
 *
 * 通道可能在这行代码之前就挂好了——那种情况下订阅者会错过那次通知，
 * 而通知只有一次，不补一次就再也拿不到。
 *
 * @param {() => void} listener - 回调
 * @returns {() => void} 退订函数
 */
export function onProjectRemoteReady(listener) {
  readyListeners.add(listener)
  if (ready) queueMicrotask(listener)
  return () => readyListeners.delete(listener)
}

/**
 * 通知订阅者通道状态有变。
 * @returns {void}
 */
function notifyReady() {
  for (const listener of readyListeners) listener()
}

/**
 * 挂载项目命名空间。
 * @param {object} ctx - 浏览器侧 Cordis 上下文
 * @returns {Promise<void>} 挂载完成后 resolve
 */
export async function mountProjectRemote(ctx) {
  const remote = ctx.get('remote')
  if (remote === undefined) throw new ProjectRemoteError('remote-missing')
  await remote.$mount(PROJECT_REMOTE_CONTRIBUTION)
  ready = true
  notifyReady()
}

/**
 * 调一个远程方法。
 * @param {object} ctx - 浏览器侧 Cordis 上下文
 * @param {string} method - 方法名
 * @param {unknown[]} args - 位置参数，顺序与契约一致
 * @returns {Promise<unknown>} 方法返回值
 */
export async function callProjectRemote(ctx, method, args = []) {
  const namespace = ctx.get(NAMESPACE_SERVICE_KEY)
  if (namespace === undefined) throw new ProjectRemoteError('namespace-missing')
  const result = await namespace[method](...args)
  if (!result.ok) {
    throw new ProjectRemoteError('call-failed', {
      method,
      hostCode: result.error?.code ?? 'unknown',
      // 宿主的业务原因（可能仍是宿主语言）原样保留，映射层只负责包前缀。
      detail: typeof result.error?.message === 'string' ? result.error.message : '',
    })
  }
  return result.value
}

/**
 * 把项目通道错误映射成当前语言的文案。
 *
 * 非通道错误沿用调用方的通用模板；通道错误只翻插件自有的 code，宿主 message
 * 作为 detail 原样附在句尾（不在这里翻译）。
 *
 * @param {unknown} error - 捕获到的错误
 * @param {(key: string, params?: Record<string, unknown>) => string} t - 当前语言的翻译函数
 * @param {string} fallbackKey - 非通道错误的通用文案 key
 * @returns {string} 用户可见文案
 */
export function projectRemoteErrorText(error, t, fallbackKey) {
  if (error instanceof ProjectRemoteError) {
    if (error.code === 'remote-missing') return t('project.remoteNotReady')
    if (error.code === 'namespace-missing') return t('project.error.namespaceMissing')
    const base = t('project.error.callFailed', { method: error.method, code: error.hostCode })
    return error.detail === '' ? base : `${base} ${error.detail}`
  }
  return t(fallbackKey, { message: error instanceof Error ? error.message : String(error) })
}
