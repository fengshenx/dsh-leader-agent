/**
 * worker 模型选择：显式参数 > 槽位默认 > leader 当前模型。
 *
 * 这些用例盯的是「选择从哪来、什么时候需要校验、错误里说清是哪个来源」——
 * 真正的 route 可用性由宿主的 llm.resolveCallConfig 决定，这里只验调用形状。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  chooseWorkerModel,
  leaderModelSelection,
  normalizeModelSelection,
  parseModelSpec,
  resolveWorkerModel,
  resolveWorkerModelSwitch,
} from '../src/host/worker-model.js'

/**
 * 造一个只提供模型相关服务的上下文。
 *
 * @param {object} [options] - 选项
 * @param {object} [options.defaultSelection] - agentDefaultModel.currentSelection() 的返回值
 * @param {object} [options.llm] - llm 服务假件
 * @returns {object} Cordis 上下文假件
 */
function makeCtx({ defaultSelection, llm } = {}) {
  return {
    get(key) {
      if (key === 'agentDefaultModel') {
        return defaultSelection === undefined ? undefined : { currentSelection: () => defaultSelection }
      }
      if (key === 'llm') return llm
      return undefined
    },
  }
}

test('normalizeModelSelection 只接受完整且非空的 provider/model', () => {
  assert.deepEqual(
    normalizeModelSelection({ provider: ' deepseek ', model: ' chat ', reasoningEffort: ' high ' }),
    { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' },
  )
  assert.deepEqual(
    normalizeModelSelection({ provider: 'deepseek', model: 'chat' }),
    { provider: 'deepseek', model: 'chat' },
  )
  for (const value of [undefined, null, 'x', [], {}, { provider: 'deepseek' }, { provider: '', model: 'chat' }]) {
    assert.equal(normalizeModelSelection(value), undefined, JSON.stringify(value))
  }
})

test('leaderModelSelection 优先 live 选择，其次会话日志、请求头、options 与部署默认', () => {
  const ctx = makeCtx({ defaultSelection: { provider: 'default', model: 'd' } })

  assert.deepEqual(
    leaderModelSelection({
      model: { current: () => ({ provider: 'live', model: 'l' }) },
      session: {
        snapshotEvents: () => [{ type: 'model/selection', data: { provider: 'event', model: 'e' } }],
        requestHeader: () => ({ config: { provider: 'header', model: 'h' } }),
      },
      options: { provider: 'options', model: 'o' },
    }, ctx),
    { provider: 'live', model: 'l' },
  )

  assert.deepEqual(
    leaderModelSelection({
      session: {
        snapshotEvents: () => [
          { type: 'model/selection', data: { provider: 'event', model: 'e' } },
          { type: 'assistant/message', data: {} },
        ],
        requestHeader: () => ({ config: { provider: 'header', model: 'h' } }),
      },
    }, ctx),
    { provider: 'event', model: 'e' },
  )

  assert.deepEqual(
    leaderModelSelection({
      session: { snapshotEvents: () => [], requestHeader: () => ({ config: { provider: 'header', model: 'h' } }) },
      options: { provider: 'options', model: 'o' },
    }, ctx),
    { provider: 'header', model: 'h' },
  )

  assert.deepEqual(
    leaderModelSelection({ options: { provider: 'options', model: 'o' } }, ctx),
    { provider: 'options', model: 'o' },
  )

  assert.deepEqual(leaderModelSelection({}, ctx), { provider: 'default', model: 'd' })
  assert.equal(leaderModelSelection(undefined, ctx), undefined)
})

test('leaderModelSelection 跳过日志里形状不对的选择，继续找更早的有效项', () => {
  const ctx = makeCtx()
  const result = leaderModelSelection({
    session: {
      snapshotEvents: () => [
        { type: 'model/selection', data: { provider: 'old', model: 'm' } },
        { type: 'model/selection', data: { provider: '', model: 'broken' } },
      ],
    },
  }, ctx)
  assert.deepEqual(result, { provider: 'old', model: 'm' })
})

test('parseModelSpec 认 provider/model，裸 id 沿用 leader 的 provider', () => {
  assert.deepEqual(parseModelSpec('deepseek/chat', undefined), { provider: 'deepseek', model: 'chat' })
  // 模型 id 自己含斜杠：第一段是 provider，其余都归 model。
  assert.deepEqual(parseModelSpec('openrouter/anthropic/claude', undefined), {
    provider: 'openrouter',
    model: 'anthropic/claude',
  })
  assert.deepEqual(parseModelSpec('chat', 'deepseek'), { provider: 'deepseek', model: 'chat' })
  assert.throws(() => parseModelSpec('chat', undefined), /没带 provider/)
  assert.throws(() => parseModelSpec('', 'deepseek'), /不能为空/)
  assert.throws(() => parseModelSpec('deepseek/', 'x'), /不是合法的 provider\/model/)
  assert.throws(() => parseModelSpec('/chat', 'x'), /不是合法的 provider\/model/)
  assert.throws(() => parseModelSpec(`${'a'.repeat(201)}/x`), /超过 200 字符/)
})

test('chooseWorkerModel：显式模型与 effort 覆盖槽位默认，来源标成 spawn', () => {
  const result = chooseWorkerModel({
    leader: { provider: 'leader-provider', model: 'leader-model', reasoningEffort: 'low' },
    slot: { model: 'deepseek/slot-model', effort: 'medium' },
    model: 'deepseek/explicit',
    effort: 'high',
  })
  assert.deepEqual(result, {
    selection: { provider: 'deepseek', model: 'explicit', reasoningEffort: 'high' },
    source: 'spawn',
  })
})

test('chooseWorkerModel：显式换模型但没给 effort 时用新模型默认，不套槽位 effort', () => {
  const result = chooseWorkerModel({
    leader: { provider: 'leader-provider', model: 'leader-model' },
    slot: { model: 'deepseek/slot-model', effort: 'medium' },
    model: 'deepseek/explicit',
  })
  assert.deepEqual(result, {
    selection: { provider: 'deepseek', model: 'explicit' },
    source: 'spawn',
  })
})

test('chooseWorkerModel：槽位默认模型带自己的 effort', () => {
  const result = chooseWorkerModel({
    leader: { provider: 'leader-provider', model: 'leader-model', reasoningEffort: 'low' },
    slot: { model: 'deepseek/slot-model', effort: 'medium' },
  })
  assert.deepEqual(result, {
    selection: { provider: 'deepseek', model: 'slot-model', reasoningEffort: 'medium' },
    source: 'slot',
  })
})

test('chooseWorkerModel：只给 effort 时套在槽位模型上', () => {
  const result = chooseWorkerModel({
    leader: { provider: 'leader-provider', model: 'leader-model' },
    slot: { model: 'deepseek/slot-model', effort: 'medium' },
    effort: 'high',
  })
  assert.deepEqual(result, {
    selection: { provider: 'deepseek', model: 'slot-model', reasoningEffort: 'high' },
    source: 'slot',
  })
})

test('chooseWorkerModel：没有槽位模型时回落到 leader，槽位 effort 仍可生效', () => {
  const result = chooseWorkerModel({
    leader: { provider: 'leader-provider', model: 'leader-model', reasoningEffort: 'low' },
    slot: { effort: 'high' },
  })
  assert.deepEqual(result, {
    selection: { provider: 'leader-provider', model: 'leader-model', reasoningEffort: 'high' },
    source: 'leader',
  })

  assert.deepEqual(
    chooseWorkerModel({
      leader: { provider: 'leader-provider', model: 'leader-model', reasoningEffort: 'low' },
    }),
    {
      selection: { provider: 'leader-provider', model: 'leader-model', reasoningEffort: 'low' },
      source: 'leader',
    },
  )
})

test('chooseWorkerModel：读不到 leader 模型又没显式给时返回 undefined', () => {
  assert.equal(chooseWorkerModel({ leader: undefined }), undefined)
})

test('chooseWorkerModel：只给 effort 但没有可用模型 route 时报错', () => {
  assert.throws(
    () => chooseWorkerModel({ leader: undefined, effort: 'high' }),
    /给了 effort「high」但没有可用的模型 route/,
  )
  assert.throws(
    () => chooseWorkerModel({ leader: undefined, slot: { effort: 'high' } }),
    /给了 effort「high」但没有可用的模型 route/,
  )
})

test('chooseWorkerModel：裸模型 id 在槽位里沿用 leader 的 provider', () => {
  const result = chooseWorkerModel({
    leader: { provider: 'deepseek', model: 'base' },
    slot: { model: 'reasoner' },
  })
  assert.deepEqual(result, {
    selection: { provider: 'deepseek', model: 'reasoner' },
    source: 'slot',
  })
})

test('chooseWorkerModel：显式 effort 超长时报错', () => {
  assert.throws(
    () => chooseWorkerModel({
      leader: { provider: 'deepseek', model: 'base' },
      effort: 'e'.repeat(65),
    }),
    /effort 超过 64 字符/,
  )
})

test('resolveWorkerModel：目标槽位配置有误时直接拒绝派工', async () => {
  await assert.rejects(
    () => resolveWorkerModel({
      ctx: makeCtx(),
      parent: {},
      slot: { issues: ['model 超过 200 字符'] },
      slotName: 'dev',
    }),
    /SLOTS\.md 的槽位「dev」模型配置无效：model 超过 200 字符/,
  )
})

test('resolveWorkerModel：纯回落 leader 当前模型时不打 llm 预检', async () => {
  const result = await resolveWorkerModel({
    ctx: makeCtx({ defaultSelection: { provider: 'mock', model: 'base', reasoningEffort: 'low' } }),
    parent: {},
    slotName: undefined,
  })
  assert.deepEqual(result, {
    selection: { provider: 'mock', model: 'base', reasoningEffort: 'low' },
    source: 'leader',
  })
})

test('resolveWorkerModel：显式模型先过 llm.resolveCallConfig 预检', async () => {
  const calls = []
  const result = await resolveWorkerModel({
    ctx: makeCtx({
      llm: {
        async resolveCallConfig(selection) {
          calls.push(selection)
          return selection
        },
      },
      defaultSelection: { provider: 'mock', model: 'base' },
    }),
    parent: {},
    model: 'deepseek/explicit',
    effort: 'high',
  })
  assert.deepEqual(result, {
    selection: { provider: 'deepseek', model: 'explicit', reasoningEffort: 'high' },
    source: 'spawn',
  })
  assert.deepEqual(calls, [{ provider: 'deepseek', model: 'explicit', reasoningEffort: 'high' }])
})

test('resolveWorkerModel：指定模型但组合没有 llm 服务时明确报缺能力', async () => {
  await assert.rejects(
    () => resolveWorkerModel({
      ctx: makeCtx({ defaultSelection: { provider: 'mock', model: 'base' } }),
      parent: {},
      model: 'deepseek/explicit',
    }),
    /没有可用的 llm 服务/,
  )
})

test('resolveWorkerModel：预检失败时错误带上来源与 route', async () => {
  await assert.rejects(
    () => resolveWorkerModel({
      ctx: makeCtx({
        llm: {
          async resolveCallConfig() {
            throw new Error('unknown model')
          },
        },
        defaultSelection: { provider: 'mock', model: 'base' },
      }),
      parent: {},
      slot: { model: 'deepseek/slot-model', effort: 'medium' },
      slotName: 'dev',
    }),
    /槽位「dev」的默认模型 deepseek\/slot-model（effort medium） 不可用：unknown model/,
  )
})

test('resolveWorkerModel：显式 effort 落到 leader 模型时错误说 leader 来源', async () => {
  await assert.rejects(
    () => resolveWorkerModel({
      ctx: makeCtx({
        llm: {
          async resolveCallConfig() {
            throw new Error('unsupported effort')
          },
        },
        defaultSelection: { provider: 'mock', model: 'base' },
      }),
      parent: {},
      effort: 'high',
    }),
    /leader 的模型 mock\/base（effort high） 不可用：unsupported effort/,
  )
})

test('resolveWorkerModel：模型写法非法时包成 spawn_worker 错误', async () => {
  await assert.rejects(
    () => resolveWorkerModel({
      ctx: makeCtx(),
      parent: {},
      model: 'deepseek/',
    }),
    /spawn_worker: 模型「deepseek\/」不是合法的 provider\/model/,
  )
})

test('resolveWorkerModelSwitch：不给 model / effort 就什么都不做，也不碰 llm', async () => {
  const ctx = makeCtx({
    llm: {
      async resolveCallConfig() {
        throw new Error('不该被调用')
      },
    },
  })
  assert.equal(await resolveWorkerModelSwitch({
    ctx,
    current: { provider: 'mock', model: 'base' },
    signal: undefined,
  }), undefined)
})

test('resolveWorkerModelSwitch：显式换模型时用新模型默认 effort', async () => {
  const seen = []
  const selection = await resolveWorkerModelSwitch({
    ctx: makeCtx({
      llm: {
        async resolveCallConfig(value) {
          seen.push(value)
          return value
        },
      },
    }),
    current: { provider: 'mock', model: 'base', reasoningEffort: 'low' },
    model: 'other/strong',
    signal: undefined,
  })
  assert.deepEqual(selection, { provider: 'other', model: 'strong' })
  assert.deepEqual(seen, [{ provider: 'other', model: 'strong' }])
})

test('resolveWorkerModelSwitch：裸模型 id 沿用 worker 当前的 provider', async () => {
  const selection = await resolveWorkerModelSwitch({
    ctx: makeCtx({ llm: { async resolveCallConfig(value) { return value } } }),
    current: { provider: 'mock', model: 'base' },
    model: 'strong',
    signal: undefined,
  })
  assert.deepEqual(selection, { provider: 'mock', model: 'strong' })
})

test('resolveWorkerModelSwitch：只换 effort 时套在当前 route 上', async () => {
  const selection = await resolveWorkerModelSwitch({
    ctx: makeCtx({ llm: { async resolveCallConfig(value) { return value } } }),
    current: { provider: 'mock', model: 'base', reasoningEffort: 'low' },
    effort: 'high',
    signal: undefined,
  })
  assert.deepEqual(selection, { provider: 'mock', model: 'base', reasoningEffort: 'high' })
})

test('resolveWorkerModelSwitch：读不到当前 route 时只换 effort / 只写裸模型 id 都报错', async () => {
  const ctx = makeCtx({ llm: { async resolveCallConfig(value) { return value } } })
  await assert.rejects(
    () => resolveWorkerModelSwitch({ ctx, current: undefined, effort: 'high', signal: undefined }),
    /读不到 worker 当前的模型 route.*请同时给 model/,
  )
  await assert.rejects(
    () => resolveWorkerModelSwitch({ ctx, current: undefined, model: 'strong', signal: undefined }),
    /模型「strong」没带 provider/,
  )
})

test('resolveWorkerModelSwitch：effort 超长、写法非法、缺 llm、预检失败都包成 message_worker 错误', async () => {
  const llm = { async resolveCallConfig(value) { return value } }
  const ctx = makeCtx({ llm })
  await assert.rejects(
    () => resolveWorkerModelSwitch({ ctx, current: { provider: 'mock', model: 'base' }, effort: 'x'.repeat(65), signal: undefined }),
    /message_worker: effort 超过 64 字符/,
  )
  await assert.rejects(
    () => resolveWorkerModelSwitch({ ctx, current: { provider: 'mock', model: 'base' }, model: 'other/', signal: undefined }),
    /message_worker: 模型「other\/」不是合法的 provider\/model/,
  )
  await assert.rejects(
    () => resolveWorkerModelSwitch({ ctx: makeCtx(), current: { provider: 'mock', model: 'base' }, model: 'other/strong', signal: undefined }),
    /没有可用的 llm 服务/,
  )
  await assert.rejects(
    () => resolveWorkerModelSwitch({
      ctx: makeCtx({
        llm: {
          async resolveCallConfig() {
            throw new Error('unknown model')
          },
        },
      }),
      current: { provider: 'mock', model: 'base' },
      model: 'other/strong',
      effort: 'max',
      signal: undefined,
    }),
    /message_worker: 指定的模型 other\/strong（effort max） 不可用：unknown model/,
  )
})
