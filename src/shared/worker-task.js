/**
 * leader 投递任务消息的来源标记。
 *
 * 消息的 `source` 带这个 kind，客户端据此认出「这条不是用户输入，是 leader 派来的
 * 任务」，用 exclusive claim 接管并渲染成带头像与身份的 leader 气泡；host 侧的
 * 回看（`read_worker_session`）也靠它把任务正文与宿主注入的上下文分开。
 *
 * 标记放在 `source` 而不是正文里：正文是模型读的事实，前缀会污染它；`source`
 * 是宿主的归属字段，链路上原样透传（宿主只校验 `source.kind` 是非空字符串）。
 *
 * @module dsh-leader-agent/shared/worker-task
 */

/** leader 投递任务消息的 source kind。 */
export const WORKER_TASK_SOURCE_KIND = 'dsh-leader-agent/worker-task'

/**
 * 从消息的 source 里读出 task 信息。
 *
 * 宿主不校验 source 的内部形状，盘上事件里的 source 是 `unknown`，读的时候必须
 * 自己判型。没有 `parentSessionId` 的历史消息不认领——气泡的身份按钮要指向发起
 * 任务的会话，缺了它就只能退回官方上下文行。
 *
 * @param {unknown} source - 消息的 source
 * @returns {{ parentSessionId: string } | null} task 信息；不是 leader 任务时为 null
 */
export function readWorkerTaskSource(source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return null
  if (source.kind !== WORKER_TASK_SOURCE_KIND) return null
  const parentSessionId = source.parentSessionId
  if (typeof parentSessionId !== 'string' || parentSessionId === '') return null
  return { parentSessionId }
}
