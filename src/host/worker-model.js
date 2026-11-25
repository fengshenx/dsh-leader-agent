/**
 * worker 模型选择：显式派工参数 > 角色槽位默认 > leader 当前模型。
 *
 * 模型在派工或续聊显式指定时定下：`SLOTS.md` 再改默认模型只影响之后新派的工，
 * 不会自己切换已在跑的会话；要换就在 `message_worker` 里带 `model` / `effort`。
 * 冷恢复要沿用登记表里的最近 route，所以选择结果还要随登记表落盘（见
 * `worker-sessions.js` 的 `resolveSessionSelection`）。
 *
 * route 的写法与宿主模型选择器一致：`provider/model`。只写模型 id 时沿用 leader
 * 的 provider——大多数项目里角色默认模型换的是同一家供应商下的模型。
 *
 * @module dsh-leader-agent/host/worker-model
 */

/** 模型 route 的长度上限。只防误把整段说明写进字段，不覆盖真实模型 id 的罕见长名。 */
const MAX_MODEL_LENGTH = 200

/** effort 的长度上限。effort 是适配器定义的短标识（low / medium / high …）。 */
const MAX_EFFORT_LENGTH = 64

/**
 * 取非空去空白的字符串。
 *
 * @param {unknown} value - 候选值
 * @returns {string | undefined} 非空字符串；空值与空白视为未声明
 */
function text(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 把宿主各种来源的模型选择归一成 `{ provider, model, reasoningEffort? }`。
 *
 * 宿主在 `model.current()`、`request/header` 的 `config`、`agent.options` 与
 * `agentDefaultModel.currentSelection()` 里给的是同名字段；缺 provider 或 model
 * 的一律当成没有选择，免得造出一个半截 route 让首轮请求才报错。
 *
 * @param {unknown} value - 候选选择
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined} 归一后的选择
 */
export function normalizeModelSelection(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const selection = /** @type {{ provider?: unknown, model?: unknown, reasoningEffort?: unknown }} */ (value)
  const provider = text(selection.provider)
  const model = text(selection.model)
  if (provider === undefined || model === undefined) return undefined
  const reasoningEffort = text(selection.reasoningEffort)
  return {
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
}

/**
 * 读会话日志里最近一次显式的模型选择。
 *
 * rc.2 没有 `agent.model.current()`；`model/selection` 事件是跨版本都有的真源。
 * 从后往前找第一条合法记录：日志里更晚的非法形状不应把更早的有效选择盖掉。
 *
 * @param {object | undefined} session - 宿主会话
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined} 最近选择
 */
function latestSelectionEvent(session) {
  if (session === undefined || typeof session.snapshotEvents !== 'function') return undefined
  const events = session.snapshotEvents()
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'model/selection') continue
    const selection = normalizeModelSelection(event.data)
    if (selection !== undefined) return selection
  }
  return undefined
}

/**
 * 读 leader 当前使用的模型。
 *
 * 顺序按「多接近当前选择」排：
 * 1. `agent.model.current()`：新宿主把待生效的选择也算进来；
 * 2. 会话日志里的 `model/selection`：rc.2 的等价真源，用户在模型选择器里换过就有；
 * 3. 最近一次请求头：还没换过模型时就是实际在用的 route；
 * 4. `agent.options`：rc.2 的 live route；
 * 5. 部署默认模型：leader 还没跑过任何请求时的最后回落。
 *
 * 任何一步读到半截 route 都跳过，不提前返回 undefined——后一步可能更完整。
 *
 * @param {object | undefined} agent - leader agent
 * @param {object} ctx - Cordis 上下文（读部署默认模型）
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined} leader 当前选择
 */
export function leaderModelSelection(agent, ctx) {
  if (agent === undefined) return undefined
  if (typeof agent.model?.current === 'function') {
    const live = normalizeModelSelection(agent.model.current())
    if (live !== undefined) return live
  }
  const selected = latestSelectionEvent(agent.session)
  if (selected !== undefined) return selected
  const header = normalizeModelSelection(agent.session?.requestHeader?.()?.config)
  if (header !== undefined) return header
  const options = normalizeModelSelection(agent.options)
  if (options !== undefined) return options
  return normalizeModelSelection(ctx.get('agentDefaultModel')?.currentSelection?.())
}

/**
 * 把 `provider/model` 或裸模型 id 解析成完整 route。
 *
 * 裸模型 id 沿用 leader 的 provider；带斜杠的一律按第一段切 provider——模型 id
 * 本身含斜杠时必须写全 `provider/model`（如 `openrouter/anthropic/claude`）。
 *
 * @param {string} spec - 模型写法
 * @param {string | undefined} fallbackProvider - 裸模型 id 沿用的 provider
 * @returns {{ provider: string, model: string }} 完整 route
 * @throws {Error} 写法为空、超长、缺 provider 或首尾段为空
 */
export function parseModelSpec(spec, fallbackProvider) {
  const value = text(spec)
  if (value === undefined) throw new Error('模型名不能为空')
  if (value.length > MAX_MODEL_LENGTH) throw new Error(`模型名超过 ${MAX_MODEL_LENGTH} 字符`)
  const slash = value.indexOf('/')
  if (slash === -1) {
    const provider = text(fallbackProvider)
    if (provider === undefined) {
      throw new Error(`模型「${value}」没带 provider，且读不到 leader 的 provider；请写成 provider/model`)
    }
    return { provider, model: value }
  }
  const provider = text(value.slice(0, slash))
  const model = text(value.slice(slash + 1))
  if (provider === undefined || model === undefined) {
    throw new Error(`模型「${value}」不是合法的 provider/model`)
  }
  return { provider, model }
}

/**
 * 按优先级合成 worker 的模型选择。
 *
 * effort 的回落跟着模型来源走：
 * - 显式给了 effort：用它；
 * - 显式换了模型但没给 effort：用新模型自己的默认 effort（槽位 effort 不跨模型套用，
 *   否则换到不支持该 effort 的模型时派工会失败）；
 * - 模型来自槽位：用槽位 effort，没写就用模型默认；
 * - 模型回落到 leader：槽位 effort 优先，其次 leader 的 effort。
 *
 * @param {object} options - 选择参数
 * @param {{ provider: string, model: string, reasoningEffort?: string } | undefined} options.leader - leader 当前选择
 * @param {{ model?: string, effort?: string } | undefined} options.slot - 槽位默认
 * @param {unknown} options.model - 派工时显式给的模型
 * @param {unknown} options.effort - 派工时显式给的 effort
 * @returns {{ selection: { provider: string, model: string, reasoningEffort?: string }, source: 'spawn' | 'slot' | 'leader' } | undefined} 选择与来源
 * @throws {Error} 写法非法、给了 effort 却没有可用模型，或需要回落却读不到 leader 的模型
 */
export function chooseWorkerModel({ leader, slot, model, effort }) {
  const spawnModel = text(model)
  const spawnEffort = text(effort)
  const slotModel = text(slot?.model)
  const slotEffort = text(slot?.effort)
  if (spawnEffort !== undefined && spawnEffort.length > MAX_EFFORT_LENGTH) {
    throw new Error(`effort 超过 ${MAX_EFFORT_LENGTH} 字符`)
  }
  /** @type {'spawn' | 'slot' | 'leader'} */
  let source
  let rawModel
  if (spawnModel !== undefined) {
    source = 'spawn'
    rawModel = spawnModel
  } else if (slotModel !== undefined) {
    source = 'slot'
    rawModel = slotModel
  } else {
    source = 'leader'
    rawModel = leader?.model
  }
  if (rawModel === undefined) {
    // effort 不能脱离模型单独存在：没有 route 时静默丢掉它等于假装派工成功。
    if (spawnEffort !== undefined || slotEffort !== undefined) {
      const value = spawnEffort ?? slotEffort
      throw new Error(`给了 effort「${value}」但没有可用的模型 route：请显式给 model，或在 SLOTS.md 里给该槽位配 model，或让 leader 有当前模型`)
    }
    return undefined
  }
  const route = parseModelSpec(rawModel, leader?.provider)
  let reasoningEffort
  if (spawnEffort !== undefined) {
    reasoningEffort = spawnEffort
  } else if (source === 'spawn') {
    reasoningEffort = undefined
  } else if (source === 'slot') {
    reasoningEffort = slotEffort
  } else {
    reasoningEffort = slotEffort ?? leader?.reasoningEffort
  }
  return {
    selection: {
      provider: route.provider,
      model: route.model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    },
    source,
  }
}

/**
 * 把选择来源写成错误/回执里的一句话。
 *
 * @param {'spawn' | 'slot' | 'leader'} source - 来源
 * @param {string | undefined} slotName - 槽位名
 * @returns {string} 人可读的来源描述
 */
function describeSource(source, slotName) {
  if (source === 'spawn') return '指定的'
  if (source === 'slot') return slotName === undefined ? '槽位默认的' : `槽位「${slotName}」的默认`
  return 'leader 的'
}

/**
 * 解析并校验 worker 最终使用的模型。
 *
 * 只有真的要换 route 或 effort 时才向 `llm` 预检：纯回落 leader 当前选择时，它
 * 已经在跑，重复校验既没必要，也会在缺 `llm` 服务的组合里平白拦住派工。
 *
 * @param {object} options - 解析参数
 * @param {object} options.ctx - Cordis 上下文
 * @param {object | undefined} options.parent - leader agent
 * @param {{ model?: string, effort?: string, issues?: string[] } | undefined} options.slot - 目标槽位配置
 * @param {string | undefined} options.slotName - 目标槽位名
 * @param {unknown} options.model - 显式模型
 * @param {unknown} options.effort - 显式 effort
 * @param {AbortSignal | undefined} options.signal - 取消信号
 * @returns {Promise<{ selection: { provider: string, model: string, reasoningEffort?: string }, source: 'spawn' | 'slot' | 'leader' } | undefined>} 最终选择与来源
 * @throws {Error} 槽位配置有误、写法非法或 route/effort 不可用
 */
export async function resolveWorkerModel({ ctx, parent, slot, slotName, model, effort, signal }) {
  const issues = Array.isArray(slot?.issues) ? slot.issues : []
  if (issues.length > 0) {
    throw new Error(`spawn_worker: SLOTS.md 的槽位${slotName === undefined ? '' : `「${slotName}」`}模型配置无效：${issues.join('；')}`)
  }
  const leader = leaderModelSelection(parent, ctx)
  let chosen
  try {
    chosen = chooseWorkerModel({ leader, slot, model, effort })
  } catch (error) {
    throw new Error(`spawn_worker: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (chosen === undefined) return undefined
  const custom = text(model) !== undefined
    || text(effort) !== undefined
    || text(slot?.model) !== undefined
    || text(slot?.effort) !== undefined
  if (!custom) return chosen
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.resolveCallConfig !== 'function') {
    throw new Error('spawn_worker: 指定了模型或 effort，但当前组合没有可用的 llm 服务，无法校验模型 route')
  }
  try {
    await llm.resolveCallConfig(chosen.selection, signal)
  } catch (error) {
    const effortText = chosen.selection.reasoningEffort === undefined
      ? ''
      : `（effort ${chosen.selection.reasoningEffort}）`
    throw new Error(
      `spawn_worker: ${describeSource(chosen.source, slotName)}模型 ${chosen.selection.provider}/${chosen.selection.model}${effortText} 不可用：${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
  return chosen
}

/**
 * 解析续聊（`message_worker`）时的一次模型切换。
 *
 * 与派工的默认值不同：**不给 `model` / `effort` 就不切**，沿用 worker 当前选择，
 * 不回落到槽位或 leader。只给 `effort` 时套在当前 route 上；显式换模型却没给
 * `effort` 时用新模型自己的默认 effort，不把旧 effort 跨模型套用。
 *
 * @param {object} options - 解析参数
 * @param {object} options.ctx - Cordis 上下文
 * @param {{ provider: string, model: string, reasoningEffort?: string } | undefined} options.current -
 *   worker 当前选择（读 live agent，读不到时 undefined）
 * @param {unknown} options.model - 续聊显式给的模型
 * @param {unknown} options.effort - 续聊显式给的 effort
 * @param {AbortSignal | undefined} options.signal - 取消信号
 * @returns {Promise<{ provider: string, model: string, reasoningEffort?: string } | undefined>} 新选择；没要求切换时 undefined
 * @throws {Error} 写法非法、只给 effort 却没有当前 route，或 route/effort 不可用
 */
export async function resolveWorkerModelSwitch({ ctx, current, model, effort, signal }) {
  const nextModel = text(model)
  const nextEffort = text(effort)
  if (nextModel === undefined && nextEffort === undefined) return undefined
  const currentSelection = normalizeModelSelection(current)
  if (nextEffort !== undefined && nextEffort.length > MAX_EFFORT_LENGTH) {
    throw new Error(`message_worker: effort 超过 ${MAX_EFFORT_LENGTH} 字符`)
  }
  let route
  if (nextModel !== undefined) {
    // 裸模型 id 沿用 worker 自己的 provider：它不是 leader 那条 route 的延伸。
    if (!nextModel.includes('/') && currentSelection === undefined) {
      throw new Error(`message_worker: 模型「${nextModel}」没带 provider，且读不到 worker 当前的 provider；请写成 provider/model`)
    }
    try {
      route = parseModelSpec(nextModel, currentSelection?.provider)
    } catch (error) {
      throw new Error(`message_worker: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  } else {
    if (currentSelection === undefined) {
      throw new Error('message_worker: 读不到 worker 当前的模型 route，无法只换 effort；请同时给 model')
    }
    route = { provider: currentSelection.provider, model: currentSelection.model }
  }
  const reasoningEffort = nextEffort ?? (nextModel === undefined ? currentSelection.reasoningEffort : undefined)
  const selection = {
    provider: route.provider,
    model: route.model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
  const llm = ctx.get('llm')
  if (llm === undefined || typeof llm.resolveCallConfig !== 'function') {
    throw new Error('message_worker: 指定了模型或 effort，但当前组合没有可用的 llm 服务，无法校验模型 route')
  }
  try {
    await llm.resolveCallConfig(selection, signal)
  } catch (error) {
    const effortText = reasoningEffort === undefined ? '' : `（effort ${reasoningEffort}）`
    throw new Error(
      `message_worker: 指定的模型 ${selection.provider}/${selection.model}${effortText} 不可用：${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
  return selection
}
