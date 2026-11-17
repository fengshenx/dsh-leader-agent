/**
 * 后台巡查提醒的会话节点定义。
 *
 * 巡查提醒也是 `user/message`（它要唤醒 leader），但说话人是机制侧的巡查，不是
 * worker，也不是用户。这里注册一个独立节点 kind，用 exclusive claim 接管这一类
 * 消息：认领成功后官方定义不再把它渲染成用户气泡。
 *
 * 与 worker 回报分开一个 kind 的理由见 `src/shared/worker-stall.js`：回报是「干完
 * 了」，巡查是「可能卡住了」——混成一个 kind 会让沉寂看起来像一次交付。
 *
 * @module dsh-leader-agent/client/worker-stall-definition
 */

import { readWorkerStallSource } from '../shared/worker-stall.js'
import { messageText } from '../shared/message-text.js'

/** 后台巡查提醒消息的节点 kind（渲染器的 dispatch key）。 */
export const WORKER_STALL_NODE_KIND = 'dsh-leader-agent-worker-stall'

/**
 * 会话节点定义。
 *
 * 字段与宿主契约一一对应（`ConversationNodeDefinition`）：`match` 认事件、
 * `start` 建状态、`update` 消化后续事件、`buildViewNode` 产出最终节点。
 */
export const workerStallDefinition = {
  kind: WORKER_STALL_NODE_KIND,
  target: 'chat',
  match: (event) => {
    if (event.type !== 'user/message') return null
    // 只认追加到转录尾部的事件：替换副本只应留在模型侧，不该出现在人类转录里
    // （宿主的 `isAppendSurfaceEvent` 判的就是 `surfaceOp === 'append'`）。
    if (event.surfaceOp !== 'append') return null
    if (readWorkerStallSource(event.data?.source) === null) return null
    return { id: String(event.data.id), role: 'start', exclusive: true }
  },
  start: (_context, match) => {
    const event = match.event
    if (event.type !== 'user/message') throw new Error('后台巡查 start 需要 user/message 事件')
    const source = readWorkerStallSource(event.data.source)
    if (source === null) throw new Error('后台巡查 start 需要带巡查标记的 source')
    return {
      seq: event.seq,
      time: event.time,
      messageId: String(event.data.id),
      text: messageText(event.data.content),
      name: source.name,
      childSessionId: source.childSessionId,
      detail: source.detail,
      elapsedMs: source.elapsedMs,
      lastReportAt: source.lastReportAt,
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const location = context.start?.location ?? { kind: 'unresolved' }
    return {
      key: context.key,
      kind: WORKER_STALL_NODE_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location,
      visibility: 'visible',
      // 提醒是 followup 开的一轮的首条输入，位置与 worker 回报一致：回合首步开
      // 新 exchange，其余留在 input。没有它，节点会落进回合的「过程折叠区」。
      groupTree: location.kind === 'step' && location.step.step === 1 ? 'exchange' : 'input',
      data: context.state,
    }
  },
}
