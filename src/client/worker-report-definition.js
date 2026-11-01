/**
 * worker 回报的会话节点定义。
 *
 * 官方 `input-message` 定义会匹配所有 `user/message` 事件，把它们渲染成右对齐的
 * 用户气泡。worker 回报也是 `user/message`（它要唤醒父会话），但它说话人是另一个
 * agent，不是用户。
 *
 * 这里注册一个独立的节点 kind，用 exclusive claim 接管这一类消息：认领成功后官方
 * 定义不再处理它，消息改由本插件的渲染器呈现成左侧、带头像与身份的气泡。影响面
 * 只有 worker 回报这一类消息，普通用户输入的渲染完全不动。
 *
 * 认领失败时（宿主版本漂移导致本定义没注册上）消息仍由官方渲染，最多退化成一条
 * 右对齐的用户气泡，不会丢内容。
 *
 * @module dsh-leader-kit/client/worker-report-definition
 */

import { readWorkerReportSource, workerReportText } from '../shared/worker-report.js'

/** worker 回报消息的节点 kind（渲染器的 dispatch key）。 */
export const WORKER_REPORT_NODE_KIND = 'dsh-leader-kit-worker-report'

/**
 * 会话节点定义。
 *
 * 字段与宿主契约一一对应（`ConversationNodeDefinition`）：`match` 认事件、
 * `start` 建状态、`update` 消化后续事件、`buildViewNode` 产出最终节点。
 */
export const workerReportDefinition = {
  kind: WORKER_REPORT_NODE_KIND,
  target: 'chat',
  match: (event) => {
    if (event.type !== 'user/message') return null
    // 只认追加到转录尾部的事件：替换副本只应留在模型侧，不该出现在人类转录里
    // （宿主的 `isAppendSurfaceEvent` 判的就是 `surfaceOp === 'append'`）。
    // 官方两个同类定义都带这一条。
    if (event.surfaceOp !== 'append') return null
    if (readWorkerReportSource(event.data?.source) === null) return null
    return { id: String(event.data.id), role: 'start', exclusive: true }
  },
  start: (_context, match) => {
    const event = match.event
    if (event.type !== 'user/message') throw new Error('worker 回报 start 需要 user/message 事件')
    const source = readWorkerReportSource(event.data.source)
    if (source === null) throw new Error('worker 回报 start 需要带 worker 标记的 source')
    return {
      seq: event.seq,
      time: event.time,
      messageId: String(event.data.id),
      text: workerReportText(event.data.content),
      name: source.name,
      childSessionId: source.childSessionId,
      // 最后一次回报的内容：界面渲染它，协议字段（子会话 id、状态、下一步）
      // 留在 text 里给模型读。
      report: source.report,
      outcome: source.outcome,
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const location = context.start?.location ?? { kind: 'unresolved' }
    return {
      key: context.key,
      kind: WORKER_REPORT_NODE_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location,
      visibility: 'visible',
      // 分组位置与官方一致：回合的首步开启新 exchange，其余留在 input。
      // 位置不能省——没有它，节点会落进回合的「过程折叠区」被默认隐藏，
      // worker 就在说话，却看不见它说话。
      groupTree: location.kind === 'step' && location.step.step === 1 ? 'exchange' : 'input',
      data: context.state,
    }
  },
}
