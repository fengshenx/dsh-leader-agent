import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createListWorkerModelsTool } from '../src/host/tools/list-worker-models.js'
import { createBundleTools } from '../src/host/index.js'

/**
 * 造一个只含 `llm` 的宿主上下文假件。
 *
 * @param {object} [options] - 目录数据
 * @param {object[]} [options.providers] - `listProviders()` 的返回
 * @param {Record<string, object[]>} [options.models] - provider id 到模型列表
 * @param {Record<string, object>} [options.infos] - `provider/model` 到解析结果
 * @param {Record<string, Error | string>} [options.failures] - provider id 到 `listModels()` 的异常
 * @returns {{ ctx: object, calls: string[][] }} 上下文与调用记录
 */
function makeCtx({ providers = [], models = {}, infos = {}, failures = {} } = {}) {
  const calls = []
  const llm = {
    listProviders: () => providers,
    async listModels(provider) {
      calls.push(['listModels', provider])
      if (Object.hasOwn(failures, provider)) throw failures[provider]
      return models[provider] ?? []
    },
    async resolveModelInfo(provider, model, signal) {
      calls.push(['resolveModelInfo', provider, model])
      signal?.throwIfAborted()
      const info = infos[`${provider}/${model}`]
      if (info === undefined) throw new Error(`unknown model ${model}`)
      return info
    },
  }
  return {
    ctx: { get: (name) => (name === 'llm' ? llm : undefined) },
    calls,
  }
}

const PROVIDERS = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'beta', name: 'Beta' },
]

const EXEC = { signal: new AbortController().signal }

test('list_worker_models：不传参按 provider 汇总有模型的 route', async () => {
  const { ctx } = makeCtx({
    providers: [...PROVIDERS, { id: 'empty', name: 'Empty' }],
    models: {
      alpha: [
        { id: 'one', name: 'One' },
        { id: 'two', name: 'Two' },
      ],
      beta: [{ id: 'three', name: 'Three' }],
      empty: [],
    },
  })
  const tool = createListWorkerModelsTool({ ctx })
  assert.equal(tool.isConcurrencySafe(), true)
  assert.equal(await tool.execute({}, EXEC), [
    'alpha — Alpha（2 个模型）',
    'beta — Beta（1 个模型）',
  ].join('\n'))
})

test('list_worker_models：没有注册 provider 与 provider 都没有模型时说明白', async () => {
  const none = makeCtx({ providers: [] })
  assert.equal(await createListWorkerModelsTool({ ctx: none.ctx }).execute({}, EXEC), '（没有已注册的 LLM provider）')

  const empty = makeCtx({ providers: PROVIDERS, models: { alpha: [], beta: [] } })
  assert.equal(await createListWorkerModelsTool({ ctx: empty.ctx }).execute({}, EXEC), '（没有可用的模型）')
})

test('list_worker_models：单个 provider 发现失败不拖垮目录，末尾点名', async () => {
  const { ctx } = makeCtx({
    providers: PROVIDERS,
    models: { alpha: [{ id: 'one', name: 'One' }] },
    failures: { beta: 'boom' },
  })
  assert.equal(await createListWorkerModelsTool({ ctx }).execute({}, EXEC), [
    'alpha — Alpha（1 个模型）',
    '读取失败的 provider：beta（boom）',
  ].join('\n'))
})

test('list_worker_models：给 provider 列模型，缺 name 时退回模型 id', async () => {
  const { ctx, calls } = makeCtx({
    providers: PROVIDERS,
    models: {
      alpha: [
        { id: 'one', name: 'One', description: 'first' },
        { id: 'two' },
      ],
    },
  })
  assert.equal(await createListWorkerModelsTool({ ctx }).execute({ provider: 'alpha' }, EXEC), [
    'alpha/one — One：first',
    'alpha/two — two',
    '用 provider + model 查该模型的 reasoning effort。',
  ].join('\n'))
  assert.deepEqual(calls, [['listModels', 'alpha']])
})

test('list_worker_models：provider 没有公布模型时明说，不返回空串', async () => {
  const { ctx } = makeCtx({ providers: PROVIDERS, models: { alpha: [] } })
  assert.equal(
    await createListWorkerModelsTool({ ctx }).execute({ provider: 'alpha' }, EXEC),
    'provider「alpha」没有公布模型。',
  )
})

test('list_worker_models：未注册 provider 报出可用列表', async () => {
  const { ctx } = makeCtx({ providers: PROVIDERS })
  await assert.rejects(
    () => createListWorkerModelsTool({ ctx }).execute({ provider: 'missing' }, EXEC),
    /provider「missing」未注册；可用：alpha、beta/,
  )
})

test('list_worker_models：给 provider + model 列出 effort 与默认值', async () => {
  const { ctx } = makeCtx({
    providers: PROVIDERS,
    infos: {
      'alpha/one': {
        id: 'one',
        name: 'One',
        description: 'first',
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'high', name: 'High', description: 'hard tasks' },
          ],
          defaultEffort: 'high',
        },
      },
    },
  })
  assert.equal(await createListWorkerModelsTool({ ctx }).execute({ provider: 'alpha', model: 'one' }, EXEC), [
    'alpha/one — One：first',
    'reasoning effort：',
    '- off — Off',
    '- high（默认） — High：hard tasks',
  ].join('\n'))
})

test('list_worker_models：模型没有 reasoning 或 effort 为空时明确说明', async () => {
  const { ctx } = makeCtx({
    providers: PROVIDERS,
    infos: {
      'alpha/plain': { id: 'plain', name: 'Plain' },
      'alpha/empty': { id: 'empty', name: 'Empty', reasoning: { efforts: [] } },
    },
  })
  const tool = createListWorkerModelsTool({ ctx })
  assert.equal(
    await tool.execute({ provider: 'alpha', model: 'plain' }, EXEC),
    'alpha/plain — Plain\nreasoning effort：（该模型没有公布）',
  )
  assert.equal(
    await tool.execute({ provider: 'alpha', model: 'empty' }, EXEC),
    'alpha/empty — Empty\nreasoning effort：（该模型没有公布）',
  )
})

test('list_worker_models：model 读取失败时带 route 报错，不伪装成没有', async () => {
  const { ctx } = makeCtx({ providers: PROVIDERS })
  await assert.rejects(
    () => createListWorkerModelsTool({ ctx }).execute({ provider: 'alpha', model: 'missing' }, EXEC),
    /list_worker_models: 读取 alpha\/missing 失败：unknown model missing/,
  )
})

test('list_worker_models：model 必须与 provider 一起给', async () => {
  const { ctx } = makeCtx({ providers: PROVIDERS })
  await assert.rejects(
    () => createListWorkerModelsTool({ ctx }).execute({ model: 'one' }, EXEC),
    /给 model 时必须同时给 provider/,
  )
})

test('list_worker_models：非字符串参数与缺失 llm 服务都直接报错', async () => {
  const { ctx } = makeCtx({ providers: PROVIDERS })
  await assert.rejects(
    () => createListWorkerModelsTool({ ctx }).execute({ provider: 1 }, EXEC),
    /provider 必须是字符串/,
  )
  await assert.rejects(
    () => createListWorkerModelsTool({}).execute({}, EXEC),
    /当前组合没有可用的 llm 服务/,
  )
})

test('list_worker_models：空字符串按未给处理，取消信号在读取前生效', async () => {
  const { ctx } = makeCtx({ providers: PROVIDERS, models: { alpha: [{ id: 'one', name: 'One' }] } })
  assert.equal(
    await createListWorkerModelsTool({ ctx }).execute({ provider: '  ', model: '' }, EXEC),
    'alpha — Alpha（1 个模型）',
  )
  await assert.rejects(
    () => createListWorkerModelsTool({ ctx }).execute({ provider: 'alpha' }, { signal: AbortSignal.abort() }),
    /aborted/i,
  )
})

test('list_worker_models：render 把文本原样交给界面', () => {
  const tool = createListWorkerModelsTool()
  assert.deepEqual(tool.output.render({}, 'alpha — Alpha'), [{ type: 'text', text: 'alpha — Alpha' }])
})

test('createBundleTools 把 ctx 透传给 list_worker_models', async () => {
  const { ctx } = makeCtx({ providers: PROVIDERS, models: { alpha: [{ id: 'one', name: 'One' }] } })
  const tool = createBundleTools({ ctx }).find((candidate) => candidate.name === 'list_worker_models')
  assert.equal(
    await tool.execute({ provider: 'alpha' }, EXEC),
    'alpha/one — One\n用 provider + model 查该模型的 reasoning effort。',
  )
})
