/**
 * worker 会话日志的回合折叠：`read_worker_session` 的纯函数层。
 *
 * 输入是宿主 `sessionQuery.readSession()` 给出的完整 `SessionEvent[]`，输出是
 * 「一回合一段」的视图——用户投进去的任务、worker 说过的正文、调过哪些工具、
 * 终态。工具参数与结果正文只保留能解释失败的片段：完整日志往往是几万 token,
 * 读完塞进 leader 的上下文既没必要也会挤掉它自己的工作记忆。
 *
 * @module dsh-leader-agent/host/worker-transcript
 */

import { messageText } from '../shared/message-text.js'
import { clipText } from '../shared/truncate.js'
import { WORKER_TASK_SOURCE_KIND } from '../shared/worker-task.js'

/**
 * 单条消息正文的保留上限。
 *
 * 与完成通知的回报上限（4000）同值：通知里能看到的整段产物，回看视图也装得下，
 * 不会出现「通知被截断、去回看反而更短」的倒挂。
 */
const MESSAGE_LIMIT = 4000
/** 单条工具失败原因的保留上限。 */
const REASON_LIMIT = 200
/**
 * 整段正文的总上限。
 *
 * 回合数与单条上限都挡不住体积：20 个回合 × 每轮两条消息 × 4000 字符仍有十六万。
 * 这是给 leader 读的视图，不是导出；超出的回合丢给翻页，不是静默消失。
 */
const TOTAL_LIMIT = 12000
/** 单条正文截断后的下一步：其他回合能翻页读回，这条超出的部分只能让 worker 复述。 */
const MESSAGE_TRUNCATED_HINT = '；其他回合可用 read_worker_session 的 offset 翻页，本条超出的部分请让 worker 复述'

/**
 * 把会话事件折成回合列表。
 *
 * 回合边界取 `turn/start` / `turn/end`（agent loop 在每轮开头与 finally 里各
 * append 一次）。最后一轮可能还在跑：只有 `turn/start` 没有 `turn/end`，
 * 该回合的 `end` 保持 undefined。
 *
 * @param {object[]} events - `SessionEvent[]`
 * @returns {{ turns: object[], running: boolean }} 回合列表与「是否有未收尾的回合」
 */
export function foldTurns(events) {
  const turns = []
  /** 当前打开的回合；`turn/end` 之后置空，下一条消息另起一段。 */
  let current
  /**
   * 开一个新回合段。
   * @returns {object} 新回合
   */
  function open() {
    current = {
      turn: undefined,
      startedAt: undefined,
      task: [],
      user: [],
      injected: 0,
      assistant: [],
      tools: [],
      end: undefined,
    }
    turns.push(current)
    return current
  }
  for (const event of events) {
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'turn/start': {
        // 上一段没等到 turn/end 就来了新一轮：保留它，由 `running` 标出没收尾。
        const item = open()
        item.turn = data.turn
        item.startedAt = event.time
        break
      }
      case 'turn/end': {
        if (current === undefined || current.end !== undefined) open()
        current.turn ??= data.turn
        current.end = {
          kind: typeof data.reason?.kind === 'string' ? data.reason.kind : 'unknown',
          error: typeof data.reason?.error?.message === 'string' ? data.reason.error.message : undefined,
        }
        current = undefined
        break
      }
      case 'user/message': {
        const item = current ?? open()
        const text = messageText(data.content)
        if (text === '') break
        // 三种生产者共用 `user/message`，只有 `source.kind` 区分：靠它把宿主注入的
        // 上下文（换目录、plan 模式、hooks）与真正的投递正文分开，否则注入会占掉
        // 任务正文的预算，leader 看到的是「用户」说过一段自己没说过的话。
        const kind = typeof data.source?.kind === 'string' ? data.source.kind : undefined
        if (kind === WORKER_TASK_SOURCE_KIND) item.task.push(text)
        else if (kind === 'user') item.user.push(text)
        else item.injected += 1
        break
      }
      case 'assistant/message': {
        const item = current ?? open()
        const text = messageText(data.message?.content, '\n\n')
        if (text !== '') item.assistant.push(text)
        break
      }
      case 'tool/call': {
        const item = current ?? open()
        item.tools.push({
          callId: typeof data.callId === 'string' ? data.callId : undefined,
          name: typeof data.name === 'string' ? data.name : 'unknown',
          failed: undefined,
          reason: undefined,
        })
        break
      }
      case 'tool/result': {
        const item = current ?? open()
        const target = typeof data.message?.toolCallId === 'string'
          ? item.tools.find((tool) => tool.callId === data.message.toolCallId)
          : undefined
        const failed = data.message?.isError === true
        if (target === undefined) {
          // 没有配对的 tool/call 也不丢：宿主在工具恢复路径上会补写结果事件。
          item.tools.push({
            callId: typeof data.message?.toolCallId === 'string' ? data.message.toolCallId : undefined,
            name: 'unknown',
            failed,
            reason: failed ? describeToolFailure(data) : undefined,
          })
          break
        }
        target.failed = failed
        if (failed) target.reason = describeToolFailure(data)
        break
      }
      default:
        // 其余事件（step、请求头、压缩、系统/开发者消息）不进回合视图。
        break
    }
  }
  const running = turns.length > 0 && turns[turns.length - 1].end === undefined
  return { turns, running }
}

/**
 * 取一条失败工具结果的用户可见原因。
 * @param {object} data - `tool/result` 的事件 data
 * @returns {string} 失败原因
 */
function describeToolFailure(data) {
  const reason = data.error?.reason ?? data.error?.name ?? messageText(data.message?.content)
  return clipText(typeof reason === 'string' && reason !== '' ? reason : '未说明原因', REASON_LIMIT)
}

/**
 * 把回合列表渲染成给 leader 读的正文。
 *
 * 只渲染指定窗口内的回合，且整段正文再受 {@link TOTAL_LIMIT} 约束：按「最新
 * 优先」累加，放不下的更早回合直接丢弃并标注条数与翻页位置。回合数上限挡不住
 * 体积——20 个回合 × 每轮两条消息 × 单条上限，仍能拼出十几万字符，塞进 leader
 * 上下文会挤掉它自己的工作记忆。窗口内最新那一段单独超限时按 {@link TOTAL_LIMIT}
 * 硬截断。
 *
 * @param {object[]} options.turns - `foldTurns().turns`
 * @param {string} options.sessionId - worker 会话 id
 * @param {string} options.name - worker 显示名
 * @param {number} options.limit - 保留的回合数
 * @param {number} [options.offset] - 跳过最新的几个回合（翻页用），默认 0
 * @param {boolean} [options.running] - 最后一轮是否还在跑
 * @returns {string} 正文
 */
export function renderTranscript({ turns, sessionId, name, limit, offset = 0, running = false }) {
  const header = `worker「${name}」会话 ${sessionId}：共 ${turns.length} 个回合`
  if (turns.length === 0) return `${header}，日志里还没有任何回合。`
  const windowEnd = Math.max(0, turns.length - offset)
  const selected = turns.slice(Math.max(0, windowEnd - limit), windowEnd)
  const blocks = selected.map(renderTurn)
  // 从最新往回装：放不下的更早回合丢掉，保证读者先看到最近的结论。
  const kept = []
  let size = 0
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (size + block.length > TOTAL_LIMIT) {
      if (kept.length > 0) break
      // 最新一回合自己就超限：截断它，否则整次读取拿不到任何内容。
      const clipped = clipText(block, TOTAL_LIMIT, '；用 read_worker_session 加大 offset 翻页')
      kept.unshift(clipped)
      size = clipped.length
      break
    }
    kept.unshift(block)
    size += block.length
  }
  const shown = kept.length
  const range = shown === 1 ? `倒序第 ${offset + 1} 个` : `倒序第 ${offset + 1}–${offset + shown} 个`
  const windowLabel = offset === 0
    ? `以下是最新的 ${shown} 个`
    : `以下是${range}（offset=${offset} 跳过最新 ${offset} 个）`
  const lines = [
    `${header}，${windowLabel}${running ? '（最后一轮仍在执行中，内容可能不完整）' : ''}：`,
    ...kept,
  ]
  const overflowTurns = selected.length - shown
  const olderRemaining = turns.length - offset - shown
  const nextOffset = offset + shown
  if (overflowTurns > 0) {
    lines.push('', `本页有 ${overflowTurns} 个回合因单次读取总量上限未展示（连同更早的 ${olderRemaining} 个），可用 offset=${nextOffset} 翻页读取。`)
  } else if (olderRemaining > 0) {
    lines.push('', `更早的 ${olderRemaining} 个回合可用 offset=${nextOffset} 继续翻页。`)
  }
  return lines.join('\n')
}

/**
 * 渲染一个回合。
 *
 * @param {object} turn - `foldTurns` 的一个回合
 * @returns {string} 该回合的正文段
 */
function renderTurn(turn) {
  const label = typeof turn.turn === 'number' ? `回合 ${turn.turn}` : '回合（未标号）'
  const outcome = turn.end === undefined
    ? '进行中'
    : turn.end.error === undefined ? turn.end.kind : `${turn.end.kind}：${clipText(turn.end.error, REASON_LIMIT)}`
  const lines = ['', `## ${label} · ${outcome}`]
  if (turn.task.length > 0) lines.push(`任务：${clipText(turn.task.join('\n\n'), MESSAGE_LIMIT, MESSAGE_TRUNCATED_HINT)}`)
  if (turn.user.length > 0) lines.push(`用户：${clipText(turn.user.join('\n\n'), MESSAGE_LIMIT, MESSAGE_TRUNCATED_HINT)}`)
  if (turn.task.length === 0 && turn.user.length === 0) lines.push('用户：（无）')
  if (turn.injected > 0) lines.push(`（另有 ${turn.injected} 条注入上下文，已省略）`)
  lines.push(`助手：${turn.assistant.length === 0 ? '（无）' : clipText(turn.assistant.join('\n\n'), MESSAGE_LIMIT, MESSAGE_TRUNCATED_HINT)}`)
  if (turn.tools.length > 0) {
    const tools = turn.tools.map((tool) => {
      if (tool.failed === true) return `${tool.name}（失败：${tool.reason ?? '未说明原因'}）`
      return tool.name
    })
    lines.push(`工具：${tools.join('、')}`)
  }
  return lines.join('\n')
}
