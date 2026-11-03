import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDispatcher } from '../src/host/dispatch.js'
import { createReadWorkerTool } from '../src/host/tools/read-worker.js'

/**
 * 内存版 worker 登记表：读取路径不关心落盘，登记表落盘行为由
 * `worker-registry.test.js` 覆盖。
 *
 * @returns {object} 登记表接口
 */
function createMemoryRegistry() {
  const workers = new Map()
  return {
    async register(worker) {
      workers.set(worker.childId, { ...worker, registeredAt: Date.now() })
      return workers.get(worker.childId)
    },
    async get(childId) {
      return workers.get(childId)
    },
    async list() {
      return [...workers.values()]
    },
    async rename(childId, name) {
      const existing = workers.get(childId)
      if (existing === undefined) return undefined
      existing.name = name
      return existing
    },
  }
}

/** 空的通知队列假件：读取路径不投递。 */
const noopStore = {
  async listPending() { return [] },
  async enqueue() {},
  async markDelivered() {},
  async markUndelivered() {},
}

/**
 * 造一套派工器夹具。
 *
 * @param {object} [options] - 覆盖项
 * @param {object} [options.sessionQuery] - `ctx.get('sessionQuery')` 的返回值
 * @param {boolean} [options.leader] - 调用方是否为项目 leader
 * @param {boolean} [options.indexReady] - 项目索引是否已就绪
 * @param {object} [options.workers] - 登记表假件
 * @returns {object} 夹具
 */
function makeFixture({ sessionQuery, leader = true, indexReady = true, workers = createMemoryRegistry() } = {}) {
  const spawned = []
  /**
   * 写方法的调用记录。读取路径必须一条都没有：`read_worker_session` 承诺只读、
   * 不唤醒 worker（`send` 会真的开一轮），这条列表就是它的回归护栏。
   */
  const mutations = []
  const ctx = {
    // 派工器构造时订阅 `session/event` 结算轮次；读取路径不产生事件。
    on() {
      return () => {}
    },
    get(key) {
      if (key === 'sessionQuery') return sessionQuery
      if (key === 'sessionPersistence') {
        return {
          append() {
            mutations.push('sessionPersistence.append')
          },
        }
      }
      return undefined
    },
  }
  const dispatcher = createDispatcher({
    ctx,
    store: noopStore,
    workers,
    workerSessions: {
      async spawn({ name }) {
        mutations.push('workerSessions.spawn')
        const sessionId = `worker-${spawned.length + 1}`
        spawned.push({ sessionId, name })
        return { sessionId, permission: undefined }
      },
      async send() {
        mutations.push('workerSessions.send')
        return 'merged'
      },
      present() {
        mutations.push('workerSessions.present')
      },
      async dispose() {
        mutations.push('workerSessions.dispose')
      },
      isWorkerSession: () => true,
    },
    leaderIndex: {
      async awaitIndex() {
        return indexReady
      },
      isLeaderSession: () => leader,
    },
  })
  return { dispatcher, workers, spawned, mutations, tool: createReadWorkerTool({ dispatcher }) }
}

/**
 * 造一条会话事件。
 * @param {string} type - 事件类型
 * @param {object} data - 事件 data
 * @returns {object} 事件
 */
function event(type, data) {
  return { type, seq: 0, time: 0, data }
}

/**
 * 一段完整的回合事件：leader 投任务、助手说了两段、一次成功的工具调用。
 * @param {number} turn - 回合号
 * @returns {object[]} 事件
 */
function fullTurn(turn) {
  return [
    event('turn/start', { turn }),
    // 真实的派工消息带 `dsh-leader-kit/worker-task` 来源（`worker-sessions.taskMessage`）。
    event('user/message', {
      content: [{ type: 'text', text: `第 ${turn} 轮任务` }],
      source: { kind: 'dsh-leader-kit/worker-task' },
    }),
    event('assistant/message', { message: { content: [{ type: 'text', text: `第 ${turn} 轮产物` }] } }),
    event('tool/call', { callId: `c-${turn}`, name: 'bash', arguments: '{}' }),
    event('tool/result', { message: { toolCallId: `c-${turn}`, isError: false, content: [] } }),
    event('turn/end', { turn, reason: { kind: 'completed' } }),
  ]
}

const WORKER_ID = 'worker-1'

/**
 * 一个登记过的 worker（父会话是 `parent-1`）。
 * @param {object} [extra] - 覆盖字段
 * @returns {object} 登记项
 */
function workerRecord(extra = {}) {
  return { childId: WORKER_ID, parentSessionId: 'parent-1', name: 'dev', ...extra }
}

/**
 * 建一个带登记项的夹具。
 * @param {object} [options] - 覆盖项
 * @returns {Promise<object>} 夹具
 */
async function fixtureWithWorker(options = {}) {
  const fixture = makeFixture(options)
  await fixture.workers.register(workerRecord())
  return fixture
}

const parent = { id: 'parent-1' }

test('leader 能读自己派出的 worker：正文、回合数与进行中标记', async () => {
  const read = []
  const fixture = await fixtureWithWorker({
    sessionQuery: {
      async readSession(sessionId) {
        read.push(sessionId)
        return { session: { id: sessionId }, inheritedEventCount: 0, events: [...fullTurn(1), ...fullTurn(2)] }
      },
    },
  })
  const result = await fixture.tool.execute({ sessionId: WORKER_ID }, { agent: parent })
  assert.deepEqual(read, [WORKER_ID])
  assert.equal(result.sessionId, WORKER_ID)
  assert.equal(result.name, 'dev')
  assert.equal(result.totalTurns, 2)
  assert.equal(result.running, false)
  assert.match(result.text, /共 2 个回合/)
  assert.match(result.text, /第 2 轮任务/)
  assert.match(result.text, /第 2 轮产物/)
  assert.match(result.text, /工具：bash/)
})

test('读路径不调用任何写方法：不唤醒 worker、不写会话事件', async () => {
  const fixture = await fixtureWithWorker({
    sessionQuery: {
      async readSession(sessionId) {
        return { session: { id: sessionId }, inheritedEventCount: 0, events: [...fullTurn(1), ...fullTurn(2)] }
      },
    },
  })
  await fixture.tool.execute({ sessionId: WORKER_ID, turns: 2 }, { agent: parent })
  // `send` 会真的让 worker 再跑一轮——只读承诺一旦破了，这里必须红。
  assert.deepEqual(fixture.mutations, [], 'read_worker_session 不该 send / spawn / dispose / append')
})

test('读失败时同样没有写动作', async () => {
  const fixture = await fixtureWithWorker({
    sessionQuery: {
      async readSession() {
        throw new Error('session not found: worker-1')
      },
    },
  })
  await assert.rejects(() => fixture.tool.execute({ sessionId: WORKER_ID }, { agent: parent }), /读不到 worker/)
  assert.deepEqual(fixture.mutations, [])
})

test('授权拒绝发生在读取之前，更不会有写动作', async () => {
  const fixture = await fixtureWithWorker({
    leader: false,
    sessionQuery: { async readSession() { throw new Error('不该被调用') } },
  })
  await assert.rejects(() => fixture.tool.execute({ sessionId: WORKER_ID }, { agent: parent }), /只有项目 leader 能读/)
  assert.deepEqual(fixture.mutations, [])
})

test('turns 只影响渲染的回合数，不影响读取', async () => {
  const fixture = await fixtureWithWorker({
    sessionQuery: {
      async readSession(sessionId) {
        return { session: { id: sessionId }, inheritedEventCount: 0, events: [...fullTurn(1), ...fullTurn(2), ...fullTurn(3)] }
      },
    },
  })
  const result = await fixture.tool.execute({ sessionId: WORKER_ID, turns: 1 }, { agent: parent })
  assert.equal(result.totalTurns, 3)
  assert.match(result.text, /第 3 轮任务/)
  assert.doesNotMatch(result.text, /第 2 轮任务/)
  assert.match(result.text, /更早的 2 个回合超出 turns=1 的范围/)
})

test('退役或非项目 leader 不能读（工具面不会重裁，身份在调用时再判一次）', async () => {
  const fixture = await fixtureWithWorker({
    leader: false,
    sessionQuery: { async readSession() { throw new Error('不该被调用') } },
  })
  await assert.rejects(
    () => fixture.tool.execute({ sessionId: WORKER_ID }, { agent: parent }),
    /只有项目 leader 能读 worker 的会话/,
  )
})

test('项目索引未就绪时拒绝，不放行高危读取', async () => {
  const fixture = await fixtureWithWorker({
    indexReady: false,
    sessionQuery: { async readSession() { throw new Error('不该被调用') } },
  })
  await assert.rejects(
    () => fixture.tool.execute({ sessionId: WORKER_ID }, { agent: parent }),
    /项目注册表尚未读出/,
  )
})

test('不是本体系派出的会话读不到', async () => {
  const fixture = makeFixture({
    sessionQuery: { async readSession() { throw new Error('不该被调用') } },
  })
  await assert.rejects(
    () => fixture.tool.execute({ sessionId: 'someone-else' }, { agent: parent }),
    /没有会话 someone-else 的派工记录/,
  )
})

test('别的会话派出的 worker 不能跨会话读', async () => {
  const fixture = makeFixture({
    sessionQuery: { async readSession() { throw new Error('不该被调用') } },
  })
  await fixture.workers.register(workerRecord({ parentSessionId: 'parent-2' }))
  await assert.rejects(
    () => fixture.tool.execute({ sessionId: WORKER_ID }, { agent: parent }),
    /别的会话派的/,
  )
})

test('缺少会话查询后端时明确报缺口，不是静默返回空', async () => {
  const fixture = await fixtureWithWorker({ sessionQuery: undefined })
  await assert.rejects(
    () => fixture.tool.execute({ sessionId: WORKER_ID }, { agent: parent }),
    /缺少会话查询后端/,
  )
})

test('查询后端没有 readSession 时同样报缺口', async () => {
  const fixture = await fixtureWithWorker({ sessionQuery: { async listSessions() { return [] } } })
  await assert.rejects(
    () => fixture.tool.execute({ sessionId: WORKER_ID }, { agent: parent }),
    /缺少会话查询后端/,
  )
})

test('日志读不出来时把原因转述给 leader（还没跑过回合是预期状态）', async () => {
  const fixture = await fixtureWithWorker({
    sessionQuery: {
      async readSession() {
        throw new Error('session not found: worker-1')
      },
    },
  })
  await assert.rejects(
    () => fixture.tool.execute({ sessionId: WORKER_ID }, { agent: parent }),
    /读不到 worker worker-1 的会话日志.*session not found/,
  )
})

test('日志形状不对（缺 events 数组）时报契约问题，不当成空日志', async () => {
  const fixture = await fixtureWithWorker({
    sessionQuery: {
      async readSession() {
        return { session: { id: WORKER_ID } }
      },
    },
  })
  await assert.rejects(
    () => fixture.tool.execute({ sessionId: WORKER_ID }, { agent: parent }),
    /日志形状不符/,
  )
})

test('turns 只接受 1 到 20 的整数', async () => {
  const fixture = await fixtureWithWorker({ sessionQuery: { async readSession() { return { events: [] } } } })
  for (const turns of [0, 21, 1.5, '2']) {
    await assert.rejects(
      () => fixture.tool.execute({ sessionId: WORKER_ID, turns }, { agent: parent }),
      /turns 必须是 1 到 20 的整数/,
      `turns=${String(turns)} 应被拒绝`,
    )
  }
})

test('sessionId 为空时拒绝', async () => {
  const fixture = makeFixture({ sessionQuery: { async readSession() { return { events: [] } } } })
  await assert.rejects(
    () => fixture.tool.execute({ sessionId: '  ' }, { agent: parent }),
    /sessionId 不能为空/,
  )
})

test('派工落盘失败的本进程窗口里也能读（owners 兜底）', async () => {
  const fixture = makeFixture({
    workers: {
      async register() {
        throw new Error('磁盘满')
      },
      async get() {
        return undefined
      },
      async list() {
        return []
      },
    },
    sessionQuery: {
      async readSession(sessionId) {
        return { session: { id: sessionId }, inheritedEventCount: 0, events: fullTurn(1) }
      },
    },
  })
  const record = await fixture.dispatcher.dispatch({ parent, name: 'dev', signal: new AbortController().signal })
  const result = await fixture.tool.execute({ sessionId: record.childId }, { agent: parent })
  assert.equal(result.totalTurns, 1)
  assert.match(result.text, /第 1 轮任务/)
})

/**
 * 宿主 rc.2 的 JSON Schema 执行子集（`packages/core/tools/src/json-schema.ts`）。
 * 越界关键字会让 `tools.register` 在注册时直接抛 `UNSUPPORTED_SCHEMA`，
 * 整个插件装配失败——不是「约束不生效」。
 */
const HOST_SCHEMA_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
])

/**
 * 收集 schema 树里超出宿主执行子集的地方。
 * @param {unknown} node - schema 节点
 * @param {string} path - 出错路径
 * @param {string[]} violations - 违规列表
 * @returns {void}
 */
function collectSchemaViolations(node, path, violations) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(`${path} 不是 schema 对象`)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (!HOST_SCHEMA_KEYWORDS.has(key)) {
      violations.push(`${path}.${key} 不在宿主支持的关键字里`)
      continue
    }
    if (key === 'properties') {
      for (const [name, child] of Object.entries(value)) collectSchemaViolations(child, `${path}.properties.${name}`, violations)
    }
    if (key === 'items') collectSchemaViolations(value, `${path}.items`, violations)
    if (key === 'oneOf') value.forEach((child, index) => collectSchemaViolations(child, `${path}.oneOf[${index}]`, violations))
    if (key === 'additionalProperties' && typeof value !== 'boolean') {
      violations.push(`${path}.additionalProperties 必须是布尔`)
    }
  }
}

test('工具 schema 只用宿主执行子集里的关键字', () => {
  const tool = createReadWorkerTool({ dispatcher: {} })
  const violations = []
  collectSchemaViolations(tool.parameters, 'parameters', violations)
  collectSchemaViolations(tool.output.schema, 'output.schema', violations)
  assert.deepEqual(violations, [])
})