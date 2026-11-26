import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createListWorkersTool, renderWorkerList } from '../src/host/tools/list-workers.js'
import { createBundleTools } from '../src/host/index.js'

const EXEC = { agent: { id: 'leader-1' } }

/**
 * 造一个名册条目。
 *
 * @param {object} [overrides] - 覆盖字段
 * @returns {object} 条目
 */
function worker(overrides = {}) {
  return {
    sessionId: 'worker-1',
    name: 'dev',
    model: 'deepseek/deepseek-chat',
    modelSource: 'spawn',
    running: false,
    cards: [],
    lastUsedAt: 1_700_000_000_000,
    ...overrides,
  }
}

test('renderWorkerList：没有 worker 时说明这是空名册', () => {
  assert.equal(
    renderWorkerList({ workers: [], archivedKnown: true }),
    '本项目目前没有可用的 worker（未归档）。用 spawn_worker 派第一个工，或确认它们是否已经被归档。',
  )
})

test('renderWorkerList：逐条给出模型、effort、来源、状态与挂卡', () => {
  const text = renderWorkerList({
    workers: [
      worker({
        name: 'dev-login',
        effort: 'high',
        running: true,
        runningSince: 1_700_000_010_000,
        cards: [{ number: 12, title: '修复登录', slot: 'dev', cardId: 'card-1' }],
      }),
      worker({ sessionId: 'worker-2', name: 'review-doc', model: undefined, modelSource: undefined }),
      worker({ sessionId: 'worker-3', name: 'dev-api', model: 'qwen/coder', modelSource: 'slot' }),
      worker({ sessionId: 'worker-4', name: 'dev-ui', model: 'deepseek/reasoner', modelSource: 'leader' }),
      worker({ sessionId: 'worker-5', name: 'dev-e2e', model: 'deepseek/chat', modelSource: 'live', running: true }),
      worker({ sessionId: 'worker-6', name: 'dev-old', model: 'deepseek/chat', modelSource: 'unknown' }),
    ],
    archivedKnown: true,
  })
  assert.match(text, /本项目可用的 worker 共 6 个（未归档，最近使用在前）/)
  assert.match(text, /worker「dev-login」 会话 worker-1\n  模型：deepseek\/deepseek-chat，effort high（来自派工参数）\n  状态：在跑（自 2023-11-14T22:13:30\.000Z 起）；最后使用 2023-11-14T22:13:20\.000Z\n  挂卡：#12 修复登录（槽位 dev，cardId: card-1）/)
  assert.match(text, /worker「review-doc」 会话 worker-2\n  模型：（未记录；可能是旧版派工或登记失败）/)
  assert.match(text, /模型：qwen\/coder（来自槽位默认）/)
  assert.match(text, /模型：deepseek\/reasoner（来自leader 当前模型）/)
  assert.match(text, /模型：deepseek\/chat（来自当前会话）/)
  // 未知来源不编，行尾不出现来源括号。
  assert.match(text, /模型：deepseek\/chat\n/)
  assert.match(text, /状态：空闲；最后使用 2023-11-14T22:13:20\.000Z/)
})

test('renderWorkerList：读不到归档集合时明说列表可能含已归档会话', () => {
  const text = renderWorkerList({ workers: [worker()], archivedKnown: false })
  assert.match(text, /当前组合读不到归档集合，列表可能包含已归档会话/)
  // 空名册不追加这句：没有条目就无所谓归档。
  assert.doesNotMatch(
    renderWorkerList({ workers: [], archivedKnown: false }),
    /归档集合/,
  )
})

test('renderWorkerList：注明「在跑」只统计 leader 派出的轮次', () => {
  const text = renderWorkerList({ workers: [worker()], archivedKnown: true })
  assert.match(text, /「在跑」只统计你派出的轮次/)
})

test('renderWorkerList：超限时整块丢 worker，尾部三句与「还有 N」不被切掉', () => {
  const longName = 'x'.repeat(5000)
  const stressWorker = (index) => worker({
    sessionId: `worker-${index}`,
    name: longName,
    cards: Array.from({ length: 30 }, (_, cardIndex) => ({
      number: index * 100 + cardIndex,
      title: 'y'.repeat(200),
      slot: 'dev',
      cardId: `card-${index}-${cardIndex}`,
    })),
  })
  const workers = Array.from({ length: 20 }, (_, index) => stressWorker(index))
  const text = renderWorkerList({ workers, total: 120, archivedKnown: false })
  const lines = text.split('\n')
  const kept = lines.filter((line) => line.startsWith('- worker「')).length
  assert.ok(text.length <= 12000, `输出应受整表上限约束，实际 ${text.length}`)
  assert.ok(kept > 0 && kept < workers.length, `应整块丢到部分 worker，实际保留 ${kept}`)
  assert.match(lines.at(-3), new RegExp(`还有 ${120 - kept} 个更久未用的 worker 未列出`))
  assert.match(lines.at(-2), /读不到归档集合/)
  assert.match(lines.at(-1), /「在跑」只统计你派出的轮次/)
  assert.match(lines.at(-4), /^…（已截断，原长 \d+ 码元；用更小的 limit 聚焦最近使用的 worker）$/)
  // 标记前必须是完整条目的最后一行：没有把某个 worker 切成半条。
  assert.match(lines.at(-5), /^  (状态|挂卡)：/)
})

test('renderWorkerList：limit 100、total 120 的极端名册也整块截断且保留尾部', () => {
  const longName = 'x'.repeat(5000)
  const stressWorker = (index) => worker({
    sessionId: `worker-${index}`,
    name: longName,
    cards: Array.from({ length: 30 }, (_, cardIndex) => ({
      number: index * 100 + cardIndex,
      title: 'y'.repeat(200),
      slot: 'dev',
      cardId: `card-${index}-${cardIndex}`,
    })),
  })
  const workers = Array.from({ length: 100 }, (_, index) => stressWorker(index))
  const text = renderWorkerList({ workers, total: 120, archivedKnown: false })
  const lines = text.split('\n')
  const kept = lines.filter((line) => line.startsWith('- worker「')).length
  assert.ok(text.length <= 12000, `输出应受整表上限约束，实际 ${text.length}`)
  assert.ok(kept > 0 && kept < workers.length)
  assert.match(lines.at(-3), new RegExp(`还有 ${120 - kept} 个更久未用的 worker 未列出`))
  assert.match(lines.at(-2), /读不到归档集合/)
  assert.match(lines.at(-1), /「在跑」只统计你派出的轮次/)
})

test('renderWorkerList：超过 limit 时只列最近使用的，并截断超长名字与卡标题', () => {
  const longName = 'x'.repeat(5000)
  const longTitle = 'y'.repeat(200)
  const workers = Array.from({ length: 20 }, (_, index) => worker({
    sessionId: `worker-${index}`,
    name: longName,
    cards: [{ number: index, title: longTitle, slot: 'dev', cardId: `card-${index}` }],
  }))
  const text = renderWorkerList({ workers, total: 50, archivedKnown: true })
  assert.match(text, /共 50 个/)
  assert.match(text, /这里列出最近使用的 20 个/)
  assert.match(text, /还有 30 个更久未用的 worker 未列出/)
  assert.match(text, /已截断，原长 5000 码元/)
  assert.match(text, /已截断，原长 200 码元/)
  assert.ok(text.length < 8000, `输出应有上限，实际 ${text.length} 字`)
})

test('工具把调用方 agent 交给派工器，并把名册渲染成文本', async () => {
  const calls = []
  const tool = createListWorkersTool({
    dispatcher: {
      async listWorkers(input) {
        calls.push(input)
        return {
          workers: [worker({ name: 'dev-login', model: 'deepseek/chat', effort: 'low' })],
          archivedKnown: true,
        }
      },
    },
  })
  assert.equal(tool.isConcurrencySafe(), true)
  const text = await tool.execute({}, EXEC)
  assert.match(text, /worker「dev-login」/)
  assert.match(text, /effort low/)
  assert.deepEqual(calls, [{ parent: EXEC.agent, limit: 20 }])
})

test('工具把 limit 传给派工器，越界时直接报错', async () => {
  const calls = []
  const tool = createListWorkersTool({
    dispatcher: {
      async listWorkers(input) {
        calls.push(input)
        return { workers: [], total: 0, archivedKnown: true }
      },
    },
  })
  await tool.execute({ limit: 5 }, EXEC)
  await tool.execute({}, EXEC)
  assert.deepEqual(calls.map((call) => call.limit), [5, 20])
  await assert.rejects(() => tool.execute({ limit: 0 }, EXEC), /limit 必须是 1–100 的整数/)
  await assert.rejects(() => tool.execute({ limit: 101 }, EXEC), /limit 必须是 1–100 的整数/)
  await assert.rejects(() => tool.execute({ limit: 1.5 }, EXEC), /limit 必须是 1–100 的整数/)
})

test('缺少调用方 agent 时直接报错，不静默返回空名册', async () => {
  const tool = createListWorkersTool({ dispatcher: { listWorkers: async () => ({ workers: [], archivedKnown: true }) } })
  await assert.rejects(() => tool.execute({}, {}), /需要调用方 agent/)
})

test('render 把名册文本原样交给界面', () => {
  const tool = createListWorkersTool({ dispatcher: {} })
  assert.deepEqual(tool.output.render({}, '名册文本'), [{ type: 'text', text: '名册文本' }])
})

test('createBundleTools 注册 list_workers 并透传派工器', async () => {
  const tool = createBundleTools({
    dispatcher: {
      async listWorkers() {
        return { workers: [], archivedKnown: true }
      },
    },
  }).find((candidate) => candidate.name === 'list_workers')
  assert.notEqual(tool, undefined)
  assert.match(await tool.execute({}, EXEC), /没有可用的 worker/)
})
