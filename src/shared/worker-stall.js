/**
 * 后台巡查提醒的来源标记。
 *
 * worker 长时间没有回报时，机制侧注入一条提醒到 leader 会话。这条消息不是
 * worker 的产物，也不是用户输入：客户端按这个 source kind 把它渲染成独立的
 * 「后台巡查」触发行，而不是 worker 回报气泡。
 *
 * 标记放在 `source` 而不是正文里，理由与 worker 回报相同（见
 * `src/shared/worker-report.js`）：正文是模型读的事实，前缀会污染它。
 *
 * 与 worker 回报分开一个 kind，是为了让界面读对语义：回报是「worker 干完了」，
 * 巡查是「worker 可能卡住了，去查」。混成一个 kind 会让沉寂本身看起来像一次交付。
 *
 * @module dsh-leader-agent/shared/worker-stall
 */

import { boundSummary } from './worker-report.js'

/** 后台巡查提醒消息的 source kind。 */
export const WORKER_STALL_SOURCE_KIND = 'dsh-leader-agent/worker-stall'

/**
 * 把巡查提醒压成一行摘要。
 *
 * `form: 'notice'` 的 `summary` 是宿主通用契约：我们的渲染接管失败而降级成官方
 * 上下文行时，显示的是这句摘要，不是 source 的原始 kind。时长文案由调用方给
 * （读侧的时长格式化在宿主侧，见 `src/host/worker-stall.js`）。
 *
 * @param {string} name - worker 显示名
 * @param {string} elapsedText - 已连续未回报的时长文案
 * @returns {string} 一行摘要
 */
export function stallNoticeSummary(name, elapsedText) {
  return boundSummary(`worker「${name}」已连续 ${elapsedText} 没有回报`)
}

/**
 * 构造后台巡查提醒的 source。
 *
 * `detail` 是界面读的正文（已连续多久、最后回报、下一步），`stall` 里另放机器
 * 事实（会话 id、最后回报时刻）。模型读的协议正文仍走消息的 `content`。
 *
 * @param {string} name - worker 显示名
 * @param {string} childSessionId - worker 会话 id
 * @param {string} summary - 一行摘要
 * @param {object} [detail] - 界面正文与机器事实
 * @param {string} [detail.detail] - 界面显示的正文
 * @param {number} [detail.elapsedMs] - 已连续未回报的时长
 * @param {number} [detail.lastReportAt] - 最后一次回报的时刻；没有回报时不传
 * @returns {{ kind: string, form: string, summary: string, stall: object }} source
 */
export function workerStallSource(name, childSessionId, summary = '', {
  detail = '',
  elapsedMs = 0,
  lastReportAt = undefined,
} = {}) {
  return {
    kind: WORKER_STALL_SOURCE_KIND,
    form: 'notice',
    summary: boundSummary(summary),
    stall: {
      name,
      childSessionId,
      detail,
      elapsedMs,
      // 值为 undefined 的键过不了宿主工具结果的 lossless JSON 判定，也过不了
      // 消息 source 的快照：没有回报时干脆不带这个键。
      ...lastReportAt === undefined ? {} : { lastReportAt },
    },
  }
}

/**
 * 判断某个值是不是普通对象。
 *
 * @param {unknown} value - 待判的值
 * @returns {boolean} 是否是普通对象
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 从消息的 source 里读出后台巡查提醒。
 *
 * 宿主不校验 source 的内部形状（只认 kind 是非空字符串），所以读的时候必须
 * 自己判型：盘上事件里的 source 是 `unknown`。
 *
 * @param {unknown} source - 消息的 source
 * @returns {{ name: string, childSessionId: string, detail: string, elapsedMs: number, lastReportAt?: number } | null} 提醒信息；不是巡查提醒时为 null
 */
export function readWorkerStallSource(source) {
  if (!isRecord(source) || source.kind !== WORKER_STALL_SOURCE_KIND) return null
  const stall = source.stall
  if (!isRecord(stall)) return null
  const { name, childSessionId } = stall
  if (typeof name !== 'string' || typeof childSessionId !== 'string') return null
  const detail = typeof stall.detail === 'string' ? stall.detail : ''
  const elapsedMs = typeof stall.elapsedMs === 'number' && Number.isFinite(stall.elapsedMs)
    ? stall.elapsedMs
    : 0
  return {
    name,
    childSessionId,
    detail,
    elapsedMs,
    ...typeof stall.lastReportAt === 'number' && Number.isFinite(stall.lastReportAt)
      ? { lastReportAt: stall.lastReportAt }
      : {},
  }
}

/**
 * 取界面要渲染的正文。
 *
 * 提醒的正文由机制侧生成并原样放进 `detail`；老消息没有它时退回整条消息正文，
 * 同样是给人读的事实（只是多了协议字段）。
 *
 * @param {{ detail?: string, text?: string } | null | undefined} state - 节点状态
 * @returns {string} 要渲染的正文
 */
export function workerStallBody(state) {
  if (state === null || typeof state !== 'object') return ''
  if (typeof state.detail === 'string' && state.detail !== '') return state.detail
  return typeof state.text === 'string' ? state.text : ''
}
