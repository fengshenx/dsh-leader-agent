/**
 * 后台巡查提醒的来源标记。
 *
 * worker 长时间没有回报时，机制侧注入一条提醒到 leader 会话。这条消息不是
 * worker 的产物，也不是用户输入：正文自己带「【后台巡查】」前缀，让它一眼区别于
 * 完成回报；`source.kind` 与 `source.stall` 给机制与降级路径读，不驱动自绘呈现。
 *
 * 标记放在 `source` 而不是只靠正文前缀：前缀是给人读的，续聊与去重需要机器可读的
 * 身份；`stall` 里的 `childSessionId` / `runStartedAt` / `lastReportAt` 是落盘
 * 队列去重、`stalledNoticeIsLive` 与换 leader 改投的依据，一条都不能少。
 *
 * @module dsh-leader-agent/shared/worker-stall
 */

import { boundSummary } from './worker-report.js'

/** 后台巡查提醒消息的 source kind。 */
export const WORKER_STALL_SOURCE_KIND = 'dsh-leader-agent/worker-stall'

/**
 * 把巡查提醒压成一行摘要。
 *
 * `form: 'notice'` 的 `summary` 是宿主通用契约：客户端没有接管这个 kind 时，
 * 宿主降级成「裸 kind 标签 + summary + 正文」的官方上下文行，摘要要能独立成句。
 *
 * @param {string} name - worker 显示名
 * @param {string} elapsedText - 已连续未回报的时长文案
 * @returns {string} 一行摘要
 */
export function stallNoticeSummary(name, elapsedText) {
  return boundSummary(`例行巡查：worker「${name}」已连续 ${elapsedText}没有回报`)
}

/**
 * 构造后台巡查提醒的 source。
 *
 * 只放机制要读的字段，不放界面文案：呈现已经回到消息正文，客户端不再为这个
 * kind 注册节点。
 *
 * @param {string} name - worker 显示名
 * @param {string} childSessionId - worker 会话 id
 * @param {string} summary - 一行摘要
 * @param {object} [facts] - 机器事实
 * @param {number} [facts.runStartedAt] - 这一轮的开跑时刻；队列去重与在飞核对用
 * @param {number} [facts.lastReportAt] - 最后一次回报的时刻；没有回报时不传
 * @returns {{ kind: string, form: string, summary: string, stall: object }} source
 */
export function workerStallSource(name, childSessionId, summary = '', {
  runStartedAt = undefined,
  lastReportAt = undefined,
} = {}) {
  return {
    kind: WORKER_STALL_SOURCE_KIND,
    form: 'notice',
    summary: boundSummary(summary),
    stall: {
      name,
      childSessionId,
      // 值为 undefined 的键过不了宿主工具结果的 lossless JSON 判定，也过不了
      // 消息 source 的快照：没有这些事实时干脆不带键。
      ...runStartedAt === undefined ? {} : { runStartedAt },
      ...lastReportAt === undefined ? {} : { lastReportAt },
    },
  }
}
