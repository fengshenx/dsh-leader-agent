/**
 * worker 回报消息的来源标记。
 *
 * 完成通知注入父会话时，消息的 `source` 带这个 kind，客户端据此认出「这条不是
 * 用户输入，是某个 worker 的回报」，并把它渲染成左侧、带头像与身份的气泡。
 *
 * 标记放在 `source` 而不是正文里：正文是模型读的事实，前缀会污染它；`source`
 * 是宿主的归属字段，链路上原样透传（宿主只校验 `source.kind` 是非空字符串）。
 *
 * @module dsh-leader-kit/shared/worker-report
 */

/** worker 回报消息的 source kind。 */
export const WORKER_REPORT_SOURCE_KIND = 'dsh-leader-kit/worker-report'

/** `notice` 摘要的长度上限，与宿主的 `CONTEXT_SUMMARY_MAX_CHARS` 同值。 */
export const CONTEXT_SUMMARY_MAX_CHARS = 120

/**
 * 把 `notice` 摘要压到长度上限。
 *
 * 宿主把这条约束写在生产者身上：摘要的输入（任务标签、目标、工具参数）是调用方
 * 文本，本身没有长度上限。本仓刻意不 peer 依赖 dsh 内部包，等价实现放这里。
 *
 * @param {string} summary - 一行摘要
 * @returns {string} 压到上限后的摘要
 */
export function boundSummary(summary) {
  // 兜住非字符串：改造前落盘的完成通知没有 summary 字段，补投时这里是 undefined。
  const text = typeof summary === 'string' ? summary : ''

  return text.length <= CONTEXT_SUMMARY_MAX_CHARS
    ? text
    : `${text.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
}

/**
 * 构造 worker 回报消息的 source。
 *
 * `form: 'notice'` 与 `summary` 是宿主给所有生产者的通用契约：带 form 的消息在
 * 官方上下文行里会直接显示一行摘要。我们的渲染接管失败而降级时，它显示的
 * 是「任务「X」已结束。」而不是 source 的原始 kind 字符串。
 *
 * `worker.report` 是 worker 最后一次回报的内容（产物摘要或失败原因）。消息正文
 * 是给模型读的事实（含子会话 id、状态、下一步这些协议字段），界面只渲染
 * `report`——两者分开，读的人各取所需。
 *
 * @param {string} name - worker 的显示名（身份名，头像与名字都用它）
 * @param {string} childSessionId - worker 子会话 id
 * @param {string} summary - 一行摘要
 * @param {string} [report] - worker 最后一次回报的内容
 * @param {string} [outcome] - 终态：`completed` 或 `failed`
 * @returns {{ kind: string, form: string, summary: string, worker: { name: string, childSessionId: string, report: string, outcome: string } }} source
 */
export function workerReportSource(name, childSessionId, summary = '', report = '', outcome = 'completed') {
  return {
    kind: WORKER_REPORT_SOURCE_KIND,
    form: 'notice',
    summary: boundSummary(summary),
    worker: { name, childSessionId, report, outcome },
  }
}

/**
 * 取界面要渲染的正文。
 *
 * worker 最后一次回报的内容（`report`）是界面显示的东西；消息正文（`text`）是给
 * 模型读的事实。改造之前落盘的消息没有 `report`，退回整条正文。
 *
 * @param {{ report?: string, text?: string } | null | undefined} state - 节点状态
 * @returns {string} 要渲染的正文
 */
export function workerReportBody(state) {
  if (state === null || typeof state !== 'object') return ''
  const report = state.report
  if (typeof report === 'string' && report !== '') return report
  return typeof state.text === 'string' ? state.text : ''
}

/**
 * 决定正文用哪种方式渲染。
 *
 * 新消息的 `report` 是 worker 自己的产物，按 Markdown 渲染；旧消息（改造前落盘）
 * 没有 `report`，回退的整条消息正文是逐行的协议字段（子会话、状态、下一步），
 * 按 Markdown 渲染会被软换行折成一段，所以保持纯文本。失败原因的回报同理：它是
 * 原样透出的错误文本，可能多行，也走纯文本。
 *
 * @param {{ report?: string, text?: string, outcome?: string } | null | undefined} state - 节点状态
 * @returns {'markdown' | 'text'} 渲染方式
 */
export function workerReportFormat(state) {
  if (state === null || typeof state !== 'object') return 'text'
  // 失败原因来自 error.message，可能带换行；交给 Markdown 会被折成一段。
  if (state.outcome === 'failed') return 'text'
  return typeof state.report === 'string' && state.report !== '' ? 'markdown' : 'text'
}

/**
 * 从消息内容块里取出纯文本。
 *
 * 宿主不约束 content 的形状（事件数据是开放 JSON），所以读的时候自己判型。
 *
 * @param {unknown} content - 消息的内容块数组
 * @returns {string} 拼接后的文本
 */
export function workerReportText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
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
 * 从消息的 source 里读出 worker 回报信息。
 *
 * 宿主不校验 source 的内部形状（只认 kind 是非空字符串），所以读的时候必须
 * 自己判型：盘上事件里的 source 是 `unknown`。
 *
 * @param {unknown} source - 消息的 source
 * @returns {{ name: string, childSessionId: string, report: string, outcome: string } | null} worker 信息；不是 worker 回报时为 null
 */
export function readWorkerReportSource(source) {
  if (!isRecord(source) || source.kind !== WORKER_REPORT_SOURCE_KIND) return null
  const worker = source.worker
  if (!isRecord(worker)) return null
  // 改名（label → name）之前落盘的消息只有 label，读旧消息时退回它。
  const name = worker.name ?? worker.label
  const childSessionId = worker.childSessionId
  if (typeof name !== 'string' || typeof childSessionId !== 'string') return null
  // report 与 outcome 是后加的字段：改造之前落盘的消息没有它们，读时按缺省处理。
  const report = typeof worker.report === 'string' ? worker.report : ''
  const outcome = typeof worker.outcome === 'string' ? worker.outcome : 'completed'
  return { name, childSessionId, report, outcome }
}
