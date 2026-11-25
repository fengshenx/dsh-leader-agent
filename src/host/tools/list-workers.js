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
  const lines = [`- worker「${worker.name}」 会话 ${worker.sessionId}`]
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
      `#${card.number} ${card.title}（槽位 ${card.slot}，cardId: ${card.cardId}）`
    )).join('、')}`)
  }
  return lines.join('\n')
}

/**
 * 把名册渲染成给模型看的文本。
 *
 * @param {{ workers: object[], archivedKnown: boolean }} roster - 名册
 * @returns {string} 文本
 */
export function renderWorkerList({ workers, archivedKnown }) {
  if (workers.length === 0) {
    return '本项目目前没有可用的 worker（未归档）。用 spawn_worker 派第一个工，或确认它们是否已经被归档。'
  }
  const lines = [
    `本项目可用的 worker 共 ${workers.length} 个（未归档，最近使用在前）：`,
    ...workers.map(renderWorker),
  ]
  if (!archivedKnown) lines.push('（当前组合读不到归档集合，列表可能包含已归档会话）')
  return lines.join('\n')
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
      '列出本项目里由你派出的、未归档的 worker 会话：会话 id、名字、当前模型与 effort、运行状态与挂着的卡。用来核对某个 worker 跑在哪个模型上、盘点可复用的 worker，或决定续聊还是新派工。只读，不唤醒 worker、不产生模型调用。',
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const parent = exec?.agent
      if (parent === undefined) {
        throw new Error('list_workers: 需要调用方 agent 才能列 worker')
      }
      return await renderWorkerList(await dispatcher.listWorkers({ parent }))
    },
  }
}
