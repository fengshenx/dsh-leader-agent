/**
 * `list_workers` 工具：列本项目可用的 worker 会话，以及各自的模型、effort 与状态。
 *
 * 派工回执只在建会话那一刻报一次模型；事后想核对某个 worker 跑在什么 route
 * 上、还有哪些 worker 可以复用，模型侧原先没有任何入口（项目树只在前端）。
 * 这个工具把登记表与活 agent 的选择折成一张给 leader 读的名册。
 *
 * 只读：不唤醒 worker、不产生模型调用，也不改任何落盘状态。
 *
 * @module dsh-leader-agent/host/tools/list-workers
 */

import { clipText, truncationMarker } from '../../shared/truncate.js'

/** 默认列出多少个 worker：覆盖常见项目，又不至于把名册撑满 leader 上下文。 */
const DEFAULT_LIMIT = 20
/** `limit` 上限：再大就不再是「一张可读的名册」。 */
const MAX_LIMIT = 100
/** 名字与卡标题是 leader 自造输入（只校验非空），渲染时按上限截断。 */
const NAME_LIMIT = 80
const CARD_TITLE_LIMIT = 120
/** 整张名册的硬上限：limit 调大或名字/标题都超长时，也不让输出挤掉 leader 的工作记忆。 */
const OUTPUT_LIMIT = 12_000
/** 「在跑」口径是固定尾部提示：整块丢 worker 条目时不能被切掉。 */
const RUNNING_NOTE = '（「在跑」只统计你派出的轮次；人下钻跟 worker 聊的那一轮不算，别据此判断能否立刻续聊。）'

/**
 * 把模型来源写成给 leader 看的一段话。
 *
 * @param {string | undefined} source - `spawn` / `slot` / `leader` / `live`
 * @returns {string | undefined} 来源描述；未知来源不编
 */
function describeSource(source) {
  if (source === 'spawn') return '派工参数'
  if (source === 'slot') return '槽位默认'
  if (source === 'leader') return 'leader 当前模型'
  if (source === 'live') return '当前会话'
  return undefined
}

/**
 * 渲染一个 worker。
 *
 * 模型未记录是合法状态（登记表早于模型选择功能，或登记落盘失败），要明说而
 * 不是省略整行——否则 leader 会以为这个 worker 没有模型。
 *
 * @param {object} worker - 名册条目
 * @returns {string} 多行文本
 */
function renderWorker(worker) {
  const name = clipText(worker.name, NAME_LIMIT, '；名字在派工时设置')
  const lines = [`- worker「${name}」 会话 ${worker.sessionId}`]
  if (worker.model === undefined) {
    lines.push('  模型：（未记录；可能是旧版派工或登记失败）')
  } else {
    const effort = worker.effort === undefined ? '' : `，effort ${worker.effort}`
    const source = describeSource(worker.modelSource)
    lines.push(`  模型：${worker.model}${effort}${source === undefined ? '' : `（来自${source}）`}`)
  }
  const running = worker.running === true
    ? `在跑${typeof worker.runningSince === 'number' ? `（自 ${new Date(worker.runningSince).toISOString()} 起）` : ''}`
    : '空闲'
  lines.push(`  状态：${running}；最后使用 ${new Date(worker.lastUsedAt).toISOString()}`)
  if (worker.cards.length > 0) {
    lines.push(`  挂卡：${worker.cards.map((card) => (
      `#${card.number} ${clipText(card.title, CARD_TITLE_LIMIT, '；完整标题请查卡')}（槽位 ${card.slot}，cardId: ${card.cardId}）`
    )).join('、')}`)
  }
  return lines.join('\n')
}

/**
 * 把名册渲染成给模型看的文本。
 *
 * @param {{ workers: object[], total?: number, archivedKnown: boolean }} roster - 名册
 * @returns {string} 文本
 */
export function renderWorkerList({ workers, total = workers.length, archivedKnown }) {
  if (workers.length === 0) {
    return '本项目目前没有可用的 worker（未归档）。用 spawn_worker 派第一个工，或确认它们是否已经被归档。'
  }
  const headerFor = (shown) => total > shown
    ? `本项目可用的 worker 共 ${total} 个（未归档，最近使用在前），这里列出最近使用的 ${shown} 个：`
    : `本项目可用的 worker 共 ${total} 个（未归档，最近使用在前）：`
  const tailFor = (shown) => [
    total > shown
      ? `（还有 ${total - shown} 个更久未用的 worker 未列出；需要时用更大的 limit。）`
      : undefined,
    archivedKnown ? undefined : '（当前组合读不到归档集合，列表可能包含已归档会话）',
    RUNNING_NOTE,
  ].filter((line) => line !== undefined)
  const blocks = workers.map(renderWorker)
  const full = [headerFor(workers.length), ...blocks, ...tailFor(workers.length)].join('\n')
  if (full.length <= OUTPUT_LIMIT) return full
  const marker = truncationMarker(full.length, '；用更小的 limit 聚焦最近使用的 worker')
  // 尾部三句先占位；超限时从最久未用的条目整块丢，不切半条。
  let shown = workers.length
  let text = full
  while (text.length > OUTPUT_LIMIT && shown > 0) {
    shown -= 1
    text = [headerFor(shown), ...blocks.slice(0, shown), marker, ...tailFor(shown)].join('\n')
  }
  return text
}

/**
 * 创建 `list_workers` 工具定义。
 *
 * @param {object} options - 工具选项
 * @param {{ listWorkers: (input: object) => Promise<object> }} options.dispatcher - 派工器
 * @returns {object} dsh 工具定义
 */
export function createListWorkersTool({ dispatcher }) {
  return {
    name: 'list_workers',
    description:
      '列出本项目里由你派出的、未归档的 worker 会话：会话 id、名字、当前模型与 effort、运行状态与挂着的卡。用来核对某个 worker 跑在哪个模型上、盘点可复用的 worker，或决定续聊还是新派工。只读，不唤醒 worker、不产生模型调用。「在跑」只统计你派出的轮次，人下钻聊的那一轮不算。',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `最多列出多少个 worker（默认 ${DEFAULT_LIMIT}，按最近使用排序后截断）`,
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec?.agent
      if (parent === undefined) {
        throw new Error('list_workers: 需要调用方 agent 才能列 worker')
      }
      const limit = args?.limit ?? DEFAULT_LIMIT
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new Error(`list_workers: limit 必须是 1–${MAX_LIMIT} 的整数`)
      }
      return await renderWorkerList(await dispatcher.listWorkers({ parent, limit }))
    },
  }
}
