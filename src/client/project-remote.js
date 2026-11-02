/**
 * 项目数据的 Typert 客户端（浏览器侧）。
 *
 * 与宿主侧的手写协议形状对称：浏览器侧把同一批方法挂到 `ctx.remote` 的
 * `projects` 命名空间上，之后的调用就是普通的远程方法调用，传输与鉴权走官方
 * `/api` 通道。
 *
 * 客户端侧要求每个入参带严格 codec（`$mount` 会拒收没有严格 codec 的描述符），
 * 这里的 codec 只做本地类型检查，不改变宿主侧的解析行为。
 *
 * @module dsh-leader-kit/client/project-remote
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
 * 造一个方法的客户端描述符。
 * @param {string} method - 方法名
 * @returns {object} 描述符
 */
function buildDescriptor(method) {
  const parameters = PROJECT_REMOTE_METHODS[method].map((name) => ({
    name,
    wire: name,
    source: 'json',
    codec: stringCodec(),
  }))
  return {
    id: `dsh-leader-kit:${PROJECT_REMOTE_NAMESPACE}/${method}`,
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
  package: 'dsh-leader-kit',
  descriptors: Object.freeze(
    Object.keys(PROJECT_REMOTE_METHODS).map((method) => Object.freeze(buildDescriptor(method))),
  ),
})

/** 命名空间在 Cordis 里的服务键，与官方 gateway 的拼法一致。 */
const NAMESPACE_SERVICE_KEY = `remote.${PROJECT_REMOTE_NAMESPACE}`

const readyListeners = new Set()
let ready = false
let mountError = ''

/**
 * 通道是否已挂好。
 * @returns {boolean} 是否可调用
 */
export function isProjectRemoteReady() {
  return ready
}

/**
 * 挂载失败的原因。
 * @returns {string} 错误说明；没有错误时是空串
 */
export function projectRemoteError() {
  return mountError
}

/**
 * 记录挂载失败的原因，供界面显示。
 * @param {string} message - 错误说明
 * @returns {void}
 */
export function reportProjectRemoteError(message) {
  mountError = message
  notifyReady()
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
  if (remote === undefined) throw new Error('宿主未提供远程调用通道')
  await remote.$mount(PROJECT_REMOTE_CONTRIBUTION)
  ready = true
  mountError = ''
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
  if (namespace === undefined) throw new Error('项目通道不可用')
  const result = await namespace[method](...args)
  if (!result.ok) {
    const code = result.error?.code ?? 'unknown'
    throw new Error(`项目通道调用失败：${method}（${code}）`)
  }
  return result.value
}
