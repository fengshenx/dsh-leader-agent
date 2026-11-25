/**
 * `list_worker_models` 工具：给 leader 查 worker 可用的模型 route 与 reasoning effort。
 *
 * 宿主没有面向模型的通用模型目录工具：GUI 的完整目录走
 * `session/modelCatalog` Remote，`list_subagent_models` 又只服务子代理的
 * `allowedModels`（默认关闭时只列 leader 当前 route）。leader 要按任务换模型，
 * 就必须能先看见已注册的 `provider/model`；否则只能猜 route，把非法值留到
 * `spawn_worker` 的预检才报错。
 *
 * 这个工具读的是宿主的 live LLM registry，与 GUI 模型选择器同源：
 * - 不传参：列有模型的 provider；
 * - 给 `provider`：列该 provider 的模型；
 * - 再给 `model`：列该模型的 reasoning effort 与默认值。
 *
 * 它不是 `SLOTS.md` 的替代：这里只回答「有哪些 route」，不替 leader 决定用哪个。
 *
 * @module dsh-leader-agent/host/tools/list-worker-models
 */

/**
 * 取可选字符串参数；空串按未给处理。
 *
 * @param {unknown} value - 原始参数
 * @param {string} field - 参数名，用于报错
 * @returns {string | undefined} 去空白后的值
 */
function text(value, field) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new Error(`list_worker_models: ${field} 必须是字符串`)
  }
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 取宿主的 LLM 服务；没有就明确报缺。
 *
 * @param {object | undefined} ctx - Cordis 上下文
 * @returns {object} LLM 服务
 */
function requireLlm(ctx) {
  const llm = ctx?.get?.('llm')
  if (llm === undefined || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    throw new Error('list_worker_models: 当前组合没有可用的 llm 服务，无法查询模型')
  }
  return llm
}

/**
 * 渲染一个模型 route。名称或描述缺失时退回模型 id，不生产空行。
 *
 * @param {string} provider - provider id
 * @param {{ id: string, name?: string, description?: string }} model - 模型元数据
 * @returns {string} 一行 route
 */
function modelLine(provider, model) {
  const name = typeof model.name === 'string' && model.name !== '' ? model.name : model.id
  const description = typeof model.description === 'string' && model.description !== ''
    ? `：${model.description}`
    : ''
  return `${provider}/${model.id} — ${name}${description}`
}

/**
 * 渲染 exact model 的 reasoning effort。
 *
 * @param {string} provider - provider id
 * @param {{ id: string, name?: string, description?: string, reasoning?: { efforts?: { id: string, name: string, description?: string }[], defaultEffort?: string } }} model - 解析后的模型
 * @returns {string} 多行文案
 */
function modelDetail(provider, model) {
  const lines = [modelLine(provider, model)]
  const efforts = model.reasoning?.efforts
  if (efforts === undefined || efforts.length === 0) {
    lines.push('reasoning effort：（该模型没有公布）')
    return lines.join('\n')
  }
  lines.push('reasoning effort：')
  for (const effort of efforts) {
    const suffix = effort.id === model.reasoning?.defaultEffort ? '（默认）' : ''
    const description = typeof effort.description === 'string' && effort.description !== ''
      ? `：${effort.description}`
      : ''
    lines.push(`- ${effort.id}${suffix} — ${effort.name}${description}`)
  }
  return lines.join('\n')
}

/**
 * 查询并渲染模型目录。
 *
 * 不传 provider 时逐个 provider 读模型：单个 provider 的发现失败不拖垮整个目录，
 * 只在末尾点名；这正是 GUI 目录的降级形态，leader 仍能看见可用的那部分。给了
 * provider/model 就是精确查询，读取失败直接报错，不把「查不到」伪装成「没有」。
 *
 * @param {object | undefined} ctx - Cordis 上下文
 * @param {{ provider?: string, model?: string }} request - 查询条件
 * @param {AbortSignal} [signal] - 取消信号
 * @returns {Promise<string>} 给模型看的文本
 */
async function listWorkerModels(ctx, request, signal) {
  const llm = requireLlm(ctx)
  const providers = llm.listProviders()
  const providerId = request.provider
  const modelId = request.model

  if (providerId === undefined) {
    if (providers.length === 0) return '（没有已注册的 LLM provider）'
    const lines = []
    const failures = []
    for (const provider of providers) {
      signal?.throwIfAborted()
      try {
        const models = await llm.listModels(provider.id)
        if (models.length === 0) continue
        lines.push(`${provider.id} — ${provider.name}（${models.length} 个模型）`)
      } catch (error) {
        failures.push(`${provider.id}（${error instanceof Error ? error.message : String(error)}）`)
      }
    }
    signal?.throwIfAborted()
    const body = lines.length === 0 ? '（没有可用的模型）' : lines.join('\n')
    return failures.length === 0
      ? body
      : `${body}\n读取失败的 provider：${failures.join('、')}`
  }

  const provider = providers.find((candidate) => candidate.id === providerId)
  if (provider === undefined) {
    const available = providers.map((candidate) => candidate.id).join('、') || '（无）'
    throw new Error(`list_worker_models: provider「${providerId}」未注册；可用：${available}`)
  }

  signal?.throwIfAborted()
  if (modelId === undefined) {
    const models = await llm.listModels(provider.id)
    signal?.throwIfAborted()
    if (models.length === 0) return `provider「${provider.id}」没有公布模型。`
    return `${models.map((model) => modelLine(provider.id, model)).join('\n')}\n用 provider + model 查该模型的 reasoning effort。`
  }

  let resolved
  try {
    resolved = await llm.resolveModelInfo(provider.id, modelId, signal)
  } catch (error) {
    throw new Error(
      `list_worker_models: 读取 ${provider.id}/${modelId} 失败：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  return modelDetail(provider.id, resolved)
}

/**
 * 创建 `list_worker_models` 工具定义。
 *
 * @param {object} [options] - 工具选项
 * @param {object} [options.ctx] - Cordis 上下文，执行时惰性取 `llm`
 * @returns {object} dsh 工具定义
 */
export function createListWorkerModelsTool({ ctx } = {}) {
  return {
    name: 'list_worker_models',
    description:
      '查 worker 可用的模型 route。不传参列已注册的 provider；给 provider 列它的模型；再给 model 看该模型的 reasoning effort 与默认值。派工前用它确认 spawn_worker 的 model / effort，避免猜 route。',
    parameters: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: '可选：provider id，例如 deepseek。从无参调用的列表里取。',
        },
        model: {
          type: 'string',
          description: '可选：精确模型 id；必须与 provider 一起给。给到这一层会返回该模型的 reasoning effort。',
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // 只读 registry，不改会话与 provider 状态。
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = /** @type {{ provider?: unknown, model?: unknown }} */ (args)
      const provider = text(input.provider, 'provider')
      const model = text(input.model, 'model')
      if (model !== undefined && provider === undefined) {
        throw new Error('list_worker_models: 给 model 时必须同时给 provider')
      }
      return listWorkerModels(ctx, { provider, model }, exec?.signal)
    },
  }
}
