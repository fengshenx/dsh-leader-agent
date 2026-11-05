/**
 * leader 投递任务消息的会话节点定义。
 *
 * 官方 `input-message` 定义按 `source.kind === 'user'` 区分真人与上下文：不是
 * `user` 的 `user/message` 会被渲染成「收到执行请求」这类紧凑的触发行。leader 用
 * `message_worker` 投给 worker 的任务也走 `user/message`（它要驱动 worker 的回合），
 * 但说话人是 leader，不是用户，也不是宿主注入的系统通知。
 *
 * 这里注册独立节点 kind，用 exclusive claim 接管这一类消息：认领成功后官方定义不再
 * 处理它，消息由本插件的渲染器呈现成左侧、带 leader 身份的气泡。影响面只有
 * `dsh-leader-agent/worker-task` 这一类消息，普通用户输入与其他上下文不动。
 *
 * 认领失败时（宿主版本漂移、本定义没注册上）消息退回官方上下文行，内容不丢，只是
 * 失去气泡形态。
 *
 * @module dsh-leader-agent/client/worker-task-definition
 */

import { readWorkerTaskSource } from '../shared/worker-task.js'
import { messageText } from '../shared/message-text.js'

/** leader 任务消息的节点 kind（渲染器的 dispatch key）。 */
export const WORKER_TASK_NODE_KIND = 'dsh-leader-agent-worker-task'

/**
 * 会话节点定义。
 *
 * 字段与宿主契约一一对应（`ConversationNodeDefinition`）：`match` 认事件、
 * `start` 建状态、`update` 消化后续事件、`buildViewNode` 产出最终节点。
 */
export const workerTaskDefinition = {
  kind: WORKER_TASK_NODE_KIND,
  target: 'chat',
  match: (event) => {
    if (event.type !== 'user/message') return null
    // 只认追加到转录尾部的事件：替换副本只应留在模型侧，不该出现在人类转录里
    // （宿主的 `isAppendSurfaceEvent` 判的就是 `surfaceOp === 'append'`）。
    if (event.surfaceOp !== 'append') return null
    if (readWorkerTaskSource(event.data?.source) === null) return null
    return { id: String(event.data.id), role: 'start', exclusive: true }
  },
  start: (_context, match) => {
    const event = match.event
    if (event.type !== 'user/message') throw new Error('leader 任务 start 需要 user/message 事件')
    const source = readWorkerTaskSource(event.data.source)
    if (source === null) throw new Error('leader 任务 start 需要带 task 标记的 source')
    return {
      seq: event.seq,
      time: event.time,
      messageId: String(event.data.id),
      text: messageText(event.data.content),
      // 气泡的身份按钮指向发起任务的会话；leader 的显示名在 source 里没有落盘，
      // 界面上用角色名，点开会话能看到它的标题。
      parentSessionId: source.parentSessionId,
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const location = context.start?.location ?? { kind: 'unresolved' }
    return {
      key: context.key,
      kind: WORKER_TASK_NODE_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: context.state.seq,
      location,
      visibility: 'visible',
      // 分组位置与官方一致：回合的首步开启新 exchange，其余留在 input。
      // 位置不能省——没有它，节点会落进回合的「过程折叠区」被默认隐藏。
      groupTree: location.kind === 'step' && location.step.step === 1 ? 'exchange' : 'input',
      data: context.state,
    }
  },
}
