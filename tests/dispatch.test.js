import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { cleanupTempDirs, makeTempDir } from './helpers/temp-dir.js'
import { createDispatcher, buildNotificationText, buildWorkerReport } from '../src/host/dispatch.js'
import { createNotificationStore } from '../src/host/notification-store.js'
import { createCardStore } from '../src/host/cards/store.js'
import { createWorkerRegistry } from '../src/host/worker-registry.js'
import { createWorkerSessions } from '../src/host/worker-sessions.js'
import { createSpawnWorkerTool } from '../src/host/tools/spawn-worker.js'

// 临时目录统一登记、测试结束后统一删：用例自己 rm 容易漏，也会在在途写盘
// 与删除之间撞出 ENOENT / ENOTEMPTY。
after(cleanupTempDirs)

/**
 * 等待条件成立。落盘与唤醒是异步链，固定轮次的等待会在慢机器上偶发失败。
 * @param {() => boolean | Promise<boolean>} predicate - 条件
 * @param {number} [timeoutMs] - 超时毫秒
 * @returns {Promise<boolean>} 条件是否成立
 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return await predicate()
}

/**
 * 构造一个假的 dsh 上下文与会话工厂。
 * @returns {object} 测试夹具
 */
function createFixture() {
  /** 建过的 worker 会话：{ sessionId, messages, disposed } */
  const spawned = []
  /** 冷恢复过的会话 id */
  const resumed = []
  const delivered = []
  /** 已创建的 worker 会话（`sessions` 服务的假身按 id 查它） */
  const sessions = new Map()
  /** 会话标题改写记录 */
  const titles = new Map()
  /** 父会话 agent（测试用 `agents.set` 挂进来） */
  const parents = new Map()
  /** 订阅上来的 `session/event` 监听器 */
  const sessionEventListeners = []
  let sequence = 0

  /**
   * 造一个假 AgentHandle：followup 记录投递，session 供标题改写与身份判定。
   * @param {string} sessionId - 会话 id
   * @returns {object} 句柄
   */
  function createHandle(sessionId) {
    const entry = { sessionId, messages: [], disposed: false }
    spawned.push(entry)
    const session = { id: sessionId, header: { id: sessionId } }
    sessions.set(sessionId, session)
    return {
      entry,
      handle: {
        agent: {
          id: sessionId,
          session,
          followup(message) {
            entry.messages.push(message)
            // 投递途中 worker 可能自己把上一轮报了：测试用它复现这类时序。
            if (typeof entry.onFollowup === 'function') entry.onFollowup(message)
          },
        },
        async dispose() {
          entry.disposed = true
          sessions.delete(sessionId)
        },
      },
    }
  }

  const agents = {
    async create({ sessionId }) {
      sequence += 1
      const { handle } = createHandle(sessionId ?? `worker-${sequence}`)
      return handle
    },
    async resume({ resumeSessionId }) {
      resumed.push(resumeSessionId)
      // 冷恢复沿用同一个会话 id，历史消息不在这个假身里重建。
      const existing = spawned.find((item) => item.sessionId === resumeSessionId)
      if (existing !== undefined) existing.disposed = false
      const { handle } = createHandle(resumeSessionId)
      return handle
    },
    get(sessionId) {
      const parent = parents.get(sessionId)
      if (parent !== undefined) return { agent: parent }
      const found = spawned.find((item) => item.sessionId === sessionId && !item.disposed)
      if (found === undefined) return undefined
      return { agent: { id: sessionId, session: sessions.get(sessionId), followup() {} } }
    },
    /** 测试用：把父会话 agent 挂进注册表，供通知投递解析。 */
    set(sessionId, agent) {
      parents.set(sessionId, agent)
    },
  }

  const ctx = {
    /**
     * 订阅会话事件的假身：派工器靠它结算 worker 的轮次。
     * @param {string} event - 事件名
     * @param {(session: object, payload: object) => unknown} listener - 监听器
     * @returns {() => void} 解除订阅
     */
    on(event, listener) {
      assert.equal(event, 'session/event')
      sessionEventListeners.push(listener)
      return () => {
        const at = sessionEventListeners.indexOf(listener)
        if (at >= 0) sessionEventListeners.splice(at, 1)
      }
    },
    get(key) {
      if (key === 'agents') return agents
      if (key === 'sessions') return { get: (id) => sessions.get(id) }
      if (key === 'sessionTitle') {
        return {
          rename(session, title) {
            titles.set(session.id, title)
          },
        }
      }
      if (key === 'sessionPersistence') return { append() {} }
      if (key === 'sessionQuery') return { observeSession() {} }
      return undefined
    },
  }
  return {
    ctx,
    agents,
    spawned,
    resumed,
    delivered,
    sessions,
    titles,
    workers: createMemoryRegistry(),

    /**
     * 模拟宿主 append 一条会话事件。
     *
     * 返回监听器的结算结果（非结算事件返回 undefined）——宿主的 `session/event` 是
     * fire-and-forget，同步返回，所以结算是否完成要靠监听器自己的 promise。
     *
     * @param {string} sessionId - 会话 id
     * @param {object} event - 会话事件
     * @returns {Promise<unknown> | undefined} 结算结果
     */
    emitSessionEvent(sessionId, event) {
      const pending = sessionEventListeners
        .map((listener) => listener({ id: sessionId }, event))
        .filter((item) => item !== undefined)
      return pending.length === 0 ? undefined : Promise.all(pending).then((list) => list[0])
    },

    /**
     * 让某个 worker 走完一轮：先落这一轮的 assistant 文本，再落 `turn/end`。
     *
     * @param {string} sessionId - 会话 id
     * @param {{ text?: string, reason?: object, withMessage?: boolean }} [options] - 轮次内容
     * @returns {Promise<unknown>} 结算结果（是否确实结算了一条在飞记录）
     */
    async finishTurn(sessionId, { text = '产物在此', reason = { kind: 'completed' }, withMessage = true } = {}) {
      if (withMessage) {
        await this.emitSessionEvent(sessionId, {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text }] } },
        })
      }
      return await this.emitSessionEvent(sessionId, { type: 'turn/end', data: { reason } })
    },
  }
}

/**
 * 内存版 worker 登记表假件：dispatch 测试不关心落盘，登记表落盘行为由
 * `worker-registry.test.js` 单独覆盖。
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
      return [...workers.values()].sort((left, right) => right.registeredAt - left.registeredAt)
    },
    async rename(childId, name) {
      const existing = workers.get(childId)
      if (existing === undefined) return undefined
      existing.name = name
      return existing
    },
  }
}

/**
 * 建派工器。协调者索引默认放行，个别用例覆盖它验证拒绝路径。
 * @param {object} options - 传给 createDispatcher 的选项
 * @returns {object} 派工器
 */
function makeDispatcher(options) {
  return createDispatcher({
    // worker 会话管理器用同一份假 ctx：它会去 ctx 取 agents / sessions / sessionTitle。
    workerSessions: createWorkerSessions({ ctx: options.ctx, logger: options.logger }),
    coordinatorIndex: {
      async awaitIndex() {
        return true
      },
      isCoordinatorSession: () => true,
    },
    ...options,
  })
}

/**
 * 建一个父 agent 假身。
 *
 * 记录走 `followup`：完成通知排进父会话的下一个 turn（inbox 的 next-turn 边界）。
 *
 * @param {string} id - 会话 id
 * @param {object[]} delivered - 收到的消息数组
 * @returns {object} agent 假身
 */
function createParent(id, delivered, status = 'idle') {
  return {
    id,
    status,
    followup(message) {
      delivered.push(message)
    },
  }
}

/**
 * 建 worker 并投递第一条任务消息。
 *
 * 派工已两段化：`dispatch` 只建会话、不开工，任务正文由 `message` 投递。
 * 大多数用例关心的是「派出去之后 worker 跑一轮」，用这个复合动作保持原语义；
 * 只验派工本身（身份、名册、绑卡、回滚）的用例直接调 `dispatcher.dispatch`。
 *
 * @param {object} dispatcher - 派工器
 * @param {object} options - 派工参数（含 `initialMessage`）
 * @returns {Promise<object>} 派工记录
 */
async function dispatchAndStart(dispatcher, { initialMessage, cardId, slot, ...rest }) {
  const record = await dispatcher.dispatch({
    ...rest,
    ...cardId === undefined ? {} : { cardId },
    ...slot === undefined ? {} : { slot },
  })
  if (initialMessage !== undefined) {
    await dispatcher.message({
      parent: rest.parent,
      sessionId: record.childId,
      message: initialMessage,
      signal: rest.signal,
      ...cardId === undefined ? {} : { cardId },
    })
  }
  return record
}

/**
 * 让最近派出的 worker 走完一轮（宿主落 `assistant/message` 与 `turn/end`）。
 *
 * @param {object} dispatcher - 派工器
 * @param {object} fixture - 夹具
 * @param {{ summary?: string, outcome?: 'completed' | 'failed' }} [options] - 回报内容
 * @returns {Promise<boolean>} 是否结算成功
 */
function finishWorker(dispatcher, fixture, { summary = '产物在此', outcome = 'completed' } = {}) {
  const target = fixture.spawned.at(-1)
  return fixture.finishTurn(target.sessionId, {
    text: summary,
    reason: outcome === 'completed' ? { kind: 'completed' } : { kind: 'error', error: { message: summary } },
  })
}

test('通知正文包含任务标签、状态与产物摘要', () => {
  const text = buildNotificationText(
    { name: '实现派工', childId: 'child-1' },
    { ok: true, result: { stopReason: 'completed', output: [{ type: 'text', text: '改完了' }] } },
  )
  assert.match(text, /实现派工/)
  assert.match(text, /child-1/)
  assert.match(text, /completed/)
  assert.match(text, /改完了/)
})

test('失败终态的通知正文写明失败原因', () => {
  const text = buildNotificationText(
    { name: '实现派工', childId: 'child-1' },
    { ok: false, error: new Error('模型不可用') },
  )
  assert.match(text, /failed/)
  assert.match(text, /模型不可用/)
})

test('worker 报失败时通知判失败并写明原因', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
  const parent = createParent('parent-1', fixture.delivered)
  fixture.agents.set('parent-1', parent)

  await dispatchAndStart(dispatcher, {
    parent,
    initialMessage: '做一件长活',
    name: '长活',
    signal: new AbortController().signal,
  })
  await finishWorker(dispatcher, fixture, { summary: '产出被 max-tokens 截断', outcome: 'failed' })
  await waitFor(() => fixture.delivered.length === 1)

  const text = fixture.delivered[0].content[0].text
  assert.match(text, /状态：failed/)
  assert.match(text, /max-tokens/)
})

test('worker 一轮说完话就自动回报，不需要它调任何工具', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store: createNotificationStore({ home }), workers: fixture.workers })
  const parent = createParent('parent-1', fixture.delivered)
  fixture.agents.set('parent-1', parent)

  await dispatchAndStart(dispatcher, {
    parent,
    initialMessage: '做一件事',
    name: '实现派工',
    signal: new AbortController().signal,
  })
  const childId = fixture.spawned.at(-1).sessionId
  // 宿主在收尾时自己落这两条事件：worker 全程没调过任何「报告完成」的工具。
  await fixture.finishTurn(childId, { text: '改完了 auth.js' })
  await waitFor(() => fixture.delivered.length === 1)

  assert.equal(dispatcher.inflightCount(), 0)
  assert.match(fixture.delivered[0].content[0].text, /改完了 auth\.js/)
  assert.match(fixture.delivered[0].content[0].text, /状态：completed/)
})

test('人直接跟 worker 聊的轮次不打扰协调者', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store: createNotificationStore({ home }), workers: fixture.workers })
  const parent = createParent('parent-1', fixture.delivered)
  fixture.agents.set('parent-1', parent)

  await dispatchAndStart(dispatcher, {
    parent,
    initialMessage: '做一件事',
    name: '实现派工',
    signal: new AbortController().signal,
  })
  const childId = fixture.spawned.at(-1).sessionId
  await fixture.finishTurn(childId, { text: '这一轮做完了' })
  await waitFor(() => fixture.delivered.length === 1)

  // 人在这个 worker 会话里自己又问了一句：不经过派工器，没有在飞记录。
  const settled = await fixture.finishTurn(childId, { text: '顺手问一句' })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(settled, false)
  assert.equal(fixture.delivered.length, 1)
})

test('一轮里有多个 step 时，摘要取最后一条 assistant 文本', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store: createNotificationStore({ home }), workers: fixture.workers })
  const parent = createParent('parent-1', fixture.delivered)
  fixture.agents.set('parent-1', parent)

  await dispatchAndStart(dispatcher, {
    parent,
    initialMessage: '做一件事',
    name: '实现派工',
    signal: new AbortController().signal,
  })
  const childId = fixture.spawned.at(-1).sessionId
  // 一个 turn 里有多个 step，前面几步往往只有「我先看一下」这类过程叙述。
  await fixture.emitSessionEvent(childId, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '先看一下现有实现' }] } },
  })
  await fixture.emitSessionEvent(childId, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '改完了 auth.js，362 例全绿' }] } },
  })
  await fixture.emitSessionEvent(childId, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await waitFor(() => fixture.delivered.length === 1)

  const text = fixture.delivered[0].content[0].text
  assert.match(text, /改完了 auth\.js/)
  assert.doesNotMatch(text, /先看一下现有实现/)
})

test('这一轮只调了工具没说话，摘要如实说没产出文本', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store: createNotificationStore({ home }), workers: fixture.workers })
  const parent = createParent('parent-1', fixture.delivered)
  fixture.agents.set('parent-1', parent)

  await dispatchAndStart(dispatcher, {
    parent,
    initialMessage: '做一件事',
    name: '实现派工',
    signal: new AbortController().signal,
  })
  await fixture.finishTurn(fixture.spawned.at(-1).sessionId, { withMessage: false })
  await waitFor(() => fixture.delivered.length === 1)

  assert.match(fixture.delivered[0].content[0].text, /（worker 未产出文本）/)
})

test('被取消、被阻断、撞 token 上限的轮次都判失败并写明原因', async () => {
  const cases = [
    // `aborted.reason` 在 rc.2 是对象（`{ kind: 'user' | 'parent' | 'hook' | … }`），
    // 不是字符串——夹具按宿主真实形状造，渲染成 `[object Object]` 才能暴露出来。
    { reason: { kind: 'aborted', reason: { kind: 'user' } }, pattern: /被取消：user/ },
    { reason: { kind: 'blocked' }, pattern: /被阻断/ },
    { reason: { kind: 'max-tokens' }, pattern: /token 上限/ },
    { reason: { kind: 'error', error: { message: '模型不可用' } }, pattern: /失败：模型不可用/ },
  ]
  for (const { reason, pattern } of cases) {
    const fixture = createFixture()
    const home = await makeTempDir('dsh-leader-kit-dispatch-')
    const dispatcher = makeDispatcher({ ctx: fixture.ctx, store: createNotificationStore({ home }), workers: fixture.workers })
    const parent = createParent('parent-1', fixture.delivered)
    fixture.agents.set('parent-1', parent)

    await dispatchAndStart(dispatcher, {
      parent,
      initialMessage: '做一件事',
      name: '实现派工',
      signal: new AbortController().signal,
    })
    // 失败的轮次里 assistant 文本往往只写到一半，摘要必须用终态原因而不是它。
    await fixture.finishTurn(fixture.spawned.at(-1).sessionId, { text: '写到一半', reason })
    await waitFor(() => fixture.delivered.length === 1)

    const text = fixture.delivered[0].content[0].text
    assert.match(text, /状态：failed/, `${JSON.stringify(reason)}`)
    assert.match(text, pattern)
    assert.doesNotMatch(text, /写到一半/, `${JSON.stringify(reason)} 不该拿半截产物当摘要`)
  }
})

test('漏传 coordinatorIndex 时装配直接报错，不静默跳过派工校验', () => {
  assert.throws(
    () => createDispatcher({ ctx: createFixture().ctx, store: {}, workers: {} }),
    /coordinatorIndex/,
  )
})

test('派工立即返回，不等待 worker 完成', async () => {  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  try {
    const store = createNotificationStore({ home })
    const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
    const parent = createParent('parent-1', fixture.delivered)

    const record = await dispatchAndStart(dispatcher, {
      parent,
      initialMessage: '做一件事',
      name: '实现派工',
      signal: new AbortController().signal,
    })

    assert.match(record.childId, /^worker-/)
    assert.equal(dispatcher.inflightCount(), 1)
    assert.equal(fixture.delivered.length, 0)
  } finally {
  }
})

test('worker 完成后通知父会话并从队列移除', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  try {
    const store = createNotificationStore({ home })
    const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
    const parent = createParent('parent-1', fixture.delivered)
    fixture.agents.set('parent-1', parent)

    await dispatchAndStart(dispatcher, {
      parent,
      initialMessage: '做一件事',
      name: '实现派工',
      signal: new AbortController().signal,
    })
    await finishWorker(dispatcher, fixture)
    await waitFor(() => fixture.delivered.length === 1)
    await waitFor(async () => (await store.listPending()).length === 0)

    assert.equal(fixture.delivered.length, 1)
    assert.equal(fixture.delivered[0].role, 'user')
    assert.match(fixture.delivered[0].content[0].text, /产物在此/)
    assert.equal((await store.listPending()).length, 0)
  } finally {
  }
})

test('父会话正忙时通知先留队，空闲后自动投递', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store: createNotificationStore({ home }), workers: fixture.workers })
  try {
    const store = createNotificationStore({ home })
    const parent = createParent('parent-1', fixture.delivered, 'running')
    fixture.agents.set('parent-1', parent)

    await dispatchAndStart(dispatcher, {
      parent,
      initialMessage: '做一件事',
      name: '实现派工',
      signal: new AbortController().signal,
    })
    await finishWorker(dispatcher, fixture)
    // 协调者正忙：不投，通知留在落盘队列里
    await waitFor(async () => (await store.listPending()).length === 1)
    assert.equal(fixture.delivered.length, 0)

    // 转空闲后自动投递。投递与落盘的「已投递」标记之间有一步异步：
    // 消息先到父会话，队列文件随后才清——等两件事都成立再断言。
    parent.status = 'idle'
    await waitFor(async () => (
      fixture.delivered.length === 1 && (await store.listPending()).length === 0
    ), 5000)
    assert.equal(fixture.delivered.length, 1)
    assert.equal((await store.listPending()).length, 0)
  } finally {
    dispatcher.dispose()
  }
})

test('轮询重入不会重复投递同一条通知', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const real = createNotificationStore({ home })
  // 造出「两次轮询拿到同一份待投快照」：第一份读到的结果被缓存下来，
  // 之后每次轮询都返回它——两个轮询都认为这条通知还等着投。
  let calls = 0
  let snapshot = null
  const store = {
    listPending: async () => {
      calls += 1
      if (snapshot === null) snapshot = await real.listPending()
      await new Promise((resolve) => setTimeout(resolve, calls % 2 === 1 ? 800 : 300))
      return snapshot
    },
    markDelivered: (id) => real.markDelivered(id),
    markUndelivered: (id, reason) => real.markUndelivered(id, reason),
    enqueue: (notification) => real.enqueue(notification),
  }
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
  try {
    const parent = createParent('parent-1', fixture.delivered, 'running')
    fixture.agents.set('parent-1', parent)
    await dispatchAndStart(dispatcher, {
      parent,
      initialMessage: '做一件事',
      name: '实现派工',
      signal: new AbortController().signal,
    })
    await finishWorker(dispatcher, fixture)
    await waitFor(async () => (await real.listPending()).length === 1)
    parent.status = 'idle'
    // 两轮轮询（500ms 一次）都跑过
    await new Promise((resolve) => setTimeout(resolve, 2000))
    assert.equal(fixture.delivered.length, 1)
  } finally {
    dispatcher.dispose()
  }
})

test('空闲检测读盘失败不会变成未处理拒绝', async () => {
  const fixture = createFixture()
  const rejections = []
  const onRejection = (reason) => rejections.push(reason)
  process.on('unhandledRejection', onRejection)
  const store = {
    listPending: async () => { throw new Error('EIO: i/o error, read') },
    markDelivered: async () => {},
    markUndelivered: async () => {},
    enqueue: async () => {},
  }
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
  try {
    const parent = createParent('parent-1', fixture.delivered, 'running')
    fixture.agents.set('parent-1', parent)
    await dispatchAndStart(dispatcher, {
      parent,
      initialMessage: '做一件事',
      name: '实现派工',
      signal: new AbortController().signal,
    })
    await finishWorker(dispatcher, fixture)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.deepEqual(rejections, [])
    assert.equal(fixture.delivered.length, 0)
  } finally {
    process.off('unhandledRejection', onRejection)
    dispatcher.dispose()
  }
})

test('改造前落盘的旧通知补投不会失败', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
  try {
    // PR #6 形状的记录：没有 summary / report / outcome 字段。
    await store.enqueue({
      id: 'note-old-1',
      childId: 'child-old',
      parentSessionId: 'parent-1',
      name: '实现派工',
      text: '任务「实现派工」已结束。\n子会话：child-old',
      createdAt: 1,
      attempts: 0,
    })
    const parent = createParent('parent-1', fixture.delivered)
    fixture.agents.set('parent-1', parent)
    const delivered = await dispatcher.redeliverPending(parent)
    assert.equal(delivered, 1)
    assert.equal(fixture.delivered.length, 1)
    const source = fixture.delivered[0].source
    assert.equal(source.summary, '任务「实现派工」已结束。')
    assert.equal(source.worker.report, '')
    assert.equal(source.worker.outcome, 'completed')
  } finally {
    dispatcher.dispose()
  }
})

test('插件卸载后不再观察会话，也不再起定时器', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
  try {
    dispatcher.dispose()
    // 卸载后即便父会话转空闲，也不该再有定时器把它投出去
    const parent = createParent('parent-1', fixture.delivered, 'idle')
    fixture.agents.set('parent-1', parent)
    await dispatchAndStart(dispatcher, {
      parent,
      initialMessage: '做一件事',
      name: '实现派工',
      signal: new AbortController().signal,
    })
    await finishWorker(dispatcher, fixture)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    // 卸载时订阅已解除：worker 结束轮次也不会被结算，既不投递也不入队，
    // 更不该有轮询把它送出去。
    assert.equal(fixture.delivered.length, 0)
    assert.equal((await store.listPending()).length, 0)
  } finally {
    dispatcher.dispose()
  }
})

test('worker 最后一次回报的内容只取产物摘要或失败原因', () => {
  assert.equal(
    buildWorkerReport({ ok: true, result: { output: [{ type: 'text', text: '改完了' }] } }),
    '改完了',
  )
  assert.equal(buildWorkerReport({ ok: true, result: { output: [] } }), '（worker 未产出文本）')
  assert.equal(buildWorkerReport({ ok: false, error: new Error('模型不可用') }), '失败：模型不可用')
})

test('多块产物摘要按空行连接，交给 Markdown 渲染时不被折成一段', () => {
  const output = [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }]
  assert.equal(buildWorkerReport({ ok: true, result: { output } }), '第一段\n\n第二段')
  // 通知正文仍用单换行：同一个 blocksToText，分隔符由调用点决定。
  const text = buildNotificationText({ name: 'w', childId: 'c' }, { ok: true, result: { output } })
  assert.equal(text.includes('产物摘要：\n第一段\n第二段'), true)
})

test('父会话已销毁时通知留在队列等待补投', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  try {
    const store = createNotificationStore({ home })
    const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
    const parent = createParent('parent-1', fixture.delivered)
    dispatcher.markDisposed('parent-1')

    await dispatchAndStart(dispatcher, {
      parent,
      initialMessage: '做一件事',
      name: '实现派工',
      signal: new AbortController().signal,
    })
    await finishWorker(dispatcher, fixture, { summary: '做完了' })
    await waitFor(async () => (await store.listPending()).length === 1)

    assert.equal(fixture.delivered.length, 0)
    assert.equal((await store.listPending()).length, 1)
  } finally {
  }
})

test('父会话注册后补投队列中的通知', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  try {
    const store = createNotificationStore({ home })
    const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
    const parent = createParent('parent-1', fixture.delivered)
    dispatcher.markDisposed('parent-1')

    await dispatchAndStart(dispatcher, {
      parent,
      initialMessage: '做一件事',
      name: '实现派工',
      signal: new AbortController().signal,
    })
    await finishWorker(dispatcher, fixture, { summary: '做完了' })
    await waitFor(async () => (await store.listPending()).length === 1)
    assert.equal(fixture.delivered.length, 0)

    dispatcher.markAlive('parent-1')
    const delivered = await dispatcher.redeliverPending(parent)

    assert.equal(delivered, 1)
    assert.equal(fixture.delivered.length, 1)
    assert.equal((await store.listPending()).length, 0)
  } finally {
  }
})

test('连续自动续行达到上限后不再唤醒', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers, autoResumeLimit: 2 })
  try {
    const parent = createParent('parent-1', fixture.delivered)
    fixture.agents.set('parent-1', parent)

    for (let index = 0; index < 3; index += 1) {
      await dispatchAndStart(dispatcher, {
        parent,
        initialMessage: '做一件事',
        name: `工 ${index}`,
        signal: new AbortController().signal,
      })
      await finishWorker(dispatcher, fixture, { summary: '做完了' })
      await waitFor(() => fixture.delivered.length === Math.min(index + 1, 2))
    }
    await waitFor(async () => (await store.listPending()).length === 1)

    assert.equal(fixture.delivered.length, 2)
    assert.equal((await store.listPending()).length, 1)
  } finally {
    dispatcher.dispose()
  }
})

test('撞续行上限后不再每轮重试', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers, autoResumeLimit: 1 })
  try {
    const parent = createParent('parent-1', fixture.delivered, 'running')
    fixture.agents.set('parent-1', parent)

    // 两条通知都在父会话忙时进等待表
    for (let index = 0; index < 2; index += 1) {
      await dispatchAndStart(dispatcher, {
        parent,
        initialMessage: '做一件事',
        name: `工 ${index}`,
        signal: new AbortController().signal,
      })
      await finishWorker(dispatcher, fixture, { summary: '做完了' })
    }
    await waitFor(async () => (await store.listPending()).length === 2)

    // 转空闲：第一条投出，第二条撞上限
    parent.status = 'idle'
    await waitFor(() => fixture.delivered.length === 1, 5000)
    await waitFor(async () => {
      const pending = await store.listPending()
      return pending.some((item) => typeof item.lastError === 'string' && item.lastError.includes('上限'))
    }, 5000)

    // 撞上限后不再每 500ms 重试：尝试次数不再增长
    const before = (await store.listPending()).map((item) => item.attempts ?? 0)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const after = (await store.listPending()).map((item) => item.attempts ?? 0)
    assert.deepEqual(after, before)
    assert.equal(fixture.delivered.length, 1)
  } finally {
    dispatcher.dispose()
  }
})

test('上限复位后被挡下的通知能重新投出', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers, autoResumeLimit: 1 })
  try {
    const parent = createParent('parent-1', fixture.delivered, 'running')
    fixture.agents.set('parent-1', parent)

    for (let index = 0; index < 2; index += 1) {
      await dispatchAndStart(dispatcher, {
        parent,
        initialMessage: '做一件事',
        name: `工 ${index}`,
        signal: new AbortController().signal,
      })
      await finishWorker(dispatcher, fixture, { summary: '做完了' })
    }
    await waitFor(async () => (await store.listPending()).length === 2)

    // 转空闲：第一条投出，第二条撞上限被挡下
    parent.status = 'idle'
    await waitFor(() => fixture.delivered.length === 1, 5000)
    await waitFor(async () => {
      const pending = await store.listPending()
      return pending.some((item) => typeof item.lastError === 'string' && item.lastError.includes('上限'))
    }, 5000)
    assert.equal(fixture.delivered.length, 1)

    // 用户开口：上限复位 → 被挡下的那条要能重新投出
    dispatcher.resetResumeCount('parent-1')
    await waitFor(() => fixture.delivered.length === 2, 5000)
    assert.equal(fixture.delivered.length, 2)
    assert.equal((await store.listPending()).length, 0)
  } finally {
    dispatcher.dispose()
  }
})

test('外部输入重置自动续行计数', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  try {
    const store = createNotificationStore({ home })
    const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers, autoResumeLimit: 1 })
    const parent = createParent('parent-1', fixture.delivered)
    fixture.agents.set('parent-1', parent)

    await dispatchAndStart(dispatcher, {
      parent,
      initialMessage: '做一件事',
      name: '工 0',
      signal: new AbortController().signal,
    })
    await finishWorker(dispatcher, fixture, { summary: '做完了' })
    await waitFor(() => fixture.delivered.length === 1)
    assert.equal(fixture.delivered.length, 1)

    dispatcher.resetResumeCount('parent-1')

    await dispatchAndStart(dispatcher, {
      parent,
      initialMessage: '做一件事',
      name: '工 1',
      signal: new AbortController().signal,
    })
    await finishWorker(dispatcher, fixture, { summary: '做完了' })
    await waitFor(() => fixture.delivered.length === 2)
    assert.equal(fixture.delivered.length, 2)
  } finally {
  }
})

test('spawn_worker 缺少调用方 agent 时报错', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  try {
    const store = createNotificationStore({ home })
    const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
    const tool = createSpawnWorkerTool({ dispatcher })

    await assert.rejects(
      () => tool.execute({ name: '工' }, { signal: new AbortController().signal }),
      /调用方 agent/,
    )
    await assert.rejects(
      () => tool.execute({ name: '  ' }, { signal: new AbortController().signal, agent: createParent('p', []) }),
      /name 不能为空/,
    )
    // 旧调用还带任务正文：收下会让人以为已经开工，实际 worker 在等消息。
    await assert.rejects(
      () => tool.execute({ name: '工', initialMessage: '做一件事' }, { signal: new AbortController().signal, agent: createParent('p', []) }),
      /initialMessage 已移除/,
    )
    // 只给一半绑定参数会让人以为绑上了，实际什么都没写。
    await assert.rejects(
      () => tool.execute({ name: '工', cardId: 'card-1' }, { signal: new AbortController().signal, agent: createParent('p', []) }),
      /cardId 与 slot 必须成对/,
    )
  } finally {
  }
})

test('spawn_worker 只建会话并返回子会话 id，不开工', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  try {
    const store = createNotificationStore({ home })
    const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
    const tool = createSpawnWorkerTool({ dispatcher })

    const result = await tool.execute(
      { name: '实现派工' },
      { signal: new AbortController().signal, agent: createParent('parent-1', fixture.delivered) },
    )

    assert.match(result.childId, /^worker-/)
    assert.equal(result.status, 'spawned')
    assert.equal(result.name, '实现派工')
    // 建会话不产生模型调用：任务正文等协调者的 message_worker。
    assert.equal(fixture.spawned[0].messages.length, 0)
    assert.equal(dispatcher.inflightCount(), 0)
  } finally {
  }
})

test('派工带 cardId 与 slot 时，绑定先于开工完成', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  try {
    const store = createNotificationStore({ home })
    const cards = createCardStore({ home })
    const dispatcher = makeDispatcher({
      ctx: fixture.ctx,
      store,
      workers: fixture.workers,
      bindCardSlot: (input) => cards.bindSlot(input),
    })
    const card = await cards.create({ title: '任务' })

    const record = await dispatcher.dispatch({
      parent: createParent('parent-1', fixture.delivered),
      name: '实现派工',
      cardId: card.id,
      slot: 'dev',
      signal: new AbortController().signal,
    })

    // 绑定在返回前完成：协调者接下来的第一条消息就带着角色与卡片事实。
    const bound = await cards.get(card.id)
    assert.deepEqual(bound.slots, { dev: { sessionId: record.childId } })
    assert.equal(cards.slotIndex.get(record.childId), 'dev')
    assert.equal(cards.cardIndex.get(record.childId)[0].cardId, card.id)
    // 建会话本身仍然不投递任务。
    assert.equal(fixture.spawned[0].messages.length, 0)
    assert.equal(dispatcher.inflightCount(), 0)
  } finally {
  }
})

test('槽位已绑别的会话时派工失败，销毁新会话且不登记', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  try {
    const store = createNotificationStore({ home })
    const cards = createCardStore({ home })
    const dispatcher = makeDispatcher({
      ctx: fixture.ctx,
      store,
      workers: fixture.workers,
      bindCardSlot: (input) => cards.bindSlot(input),
    })
    const card = await cards.create({ title: '任务', slots: { dev: { sessionId: 'worker-old' } } })

    await assert.rejects(
      () => dispatcher.dispatch({
        parent: createParent('parent-1', fixture.delivered),
        name: '实现派工',
        cardId: card.id,
        slot: 'dev',
        signal: new AbortController().signal,
      }),
      /已绑到会话 worker-old/,
    )

    const childId = fixture.spawned[0].sessionId
    assert.equal(fixture.spawned[0].disposed, true)
    assert.equal(await fixture.workers.get(childId), undefined)
  } finally {
  }
})

test('装配没有 bindCardSlot 时带卡派工明确报错，不静默不绑', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  try {
    const dispatcher = makeDispatcher({
      ctx: fixture.ctx,
      store: createNotificationStore({ home }),
      workers: fixture.workers,
    })
    await assert.rejects(
      () => dispatcher.dispatch({
        parent: createParent('parent-1', fixture.delivered),
        name: '实现派工',
        cardId: 'card-1',
        slot: 'dev',
        signal: new AbortController().signal,
      }),
      /bindCardSlot/,
    )
    assert.equal(fixture.spawned[0].disposed, true)
  } finally {
  }
})

test('未启用 agents 服务时派工明确报错', async () => {
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  try {
    const store = createNotificationStore({ home })
    // 续聊后端都在，只缺建会话的 agents 服务：报错要指向真正的缺口。
    const dispatcher = makeDispatcher({
      ctx: {
        on: () => () => {},
        get: (key) => (key === 'sessionPersistence'
          ? { append() {} }
          : key === 'sessionQuery'
            ? { observeSession() {} }
            : undefined),
      },
      store,
    })
    await assert.rejects(
      () => dispatchAndStart(dispatcher, {
        parent: createParent('parent-1', []),
        initialMessage: '做一件事',
        name: '工',
        signal: new AbortController().signal,
      }),
      /agents/,
    )
  } finally {
  }
})

test('派工工具拒绝空的 name，不退回任务正文前缀', async () => {
  const dispatcher = { dispatch: async () => ({ childId: 'child-1', name: 'x' }) }
  const tool = createSpawnWorkerTool({ dispatcher })
  await assert.rejects(
    () => tool.execute({ initialMessage: '做一件事', name: 7 }, { signal: new AbortController().signal, agent: createParent('p', []) }),
    /name 不能为空/,
  )
  await assert.rejects(
    () => tool.execute({ initialMessage: '做一件事', name: '  ' }, { signal: new AbortController().signal, agent: createParent('p', []) }),
    /name 不能为空/,
  )
})

test('派工工具拒绝非字符串的 force', async () => {
  const dispatcher = { dispatch: async () => ({ childId: 'child-1', name: 'x' }) }
  const tool = createSpawnWorkerTool({ dispatcher })
  await assert.rejects(
    () => tool.execute({ name: '工', force: 7 }, { signal: new AbortController().signal, agent: createParent('p', []) }),
    /force 必须是字符串/,
  )
})

test('worker 登记失败仍照常投递完成通知', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  // home 只读、磁盘满：登记抛错，但子会话已经跑起来了，没法回滚。
  const workers = {
    async register() {
      throw new Error('DISK_FULL')
    },
    async get() {
      return undefined
    },
  }
  const warnings = []
  const dispatcher = makeDispatcher({
    ctx: fixture.ctx,
    store,
    workers,
    logger: (message) => warnings.push(message),
  })
  const parent = createParent('parent-1', fixture.delivered)
  fixture.agents.set('parent-1', parent)

  const record = await dispatchAndStart(dispatcher, {
    parent,
    initialMessage: '做一件事',
    name: '实现派工',
    signal: new AbortController().signal,
  })

  assert.match(record.childId, /^worker-/)
  assert.ok(warnings.some((message) => message.includes('登记失败')))
  await finishWorker(dispatcher, fixture)
  await waitFor(() => fixture.delivered.length === 1)
  assert.match(fixture.delivered[0].content[0].text, /产物在此/)
})

test('项目索引读不出来时拒绝派工，不拉起子会话', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const dispatcher = makeDispatcher({
    ctx: fixture.ctx,
    store,
    workers: fixture.workers,
    coordinatorIndex: {
      async awaitIndex() {
        return false
      },
      isCoordinatorSession: () => true,
    },
  })

  await assert.rejects(
    () => dispatchAndStart(dispatcher, {
      parent: createParent('parent-1', []),
      initialMessage: '做一件事',
      name: '工',
      signal: new AbortController().signal,
    }),
    /注册表尚未读出/,
  )
  assert.equal(fixture.spawned.length, 0)
})

test('非协调者会话派工被拒绝', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const dispatcher = makeDispatcher({
    ctx: fixture.ctx,
    store,
    workers: fixture.workers,
    coordinatorIndex: {
      async awaitIndex() {
        return true
      },
      isCoordinatorSession: () => false,
    },
  })

  await assert.rejects(
    () => dispatchAndStart(dispatcher, {
      parent: createParent('普通会话', []),
      initialMessage: '做一件事',
      name: '工',
      signal: new AbortController().signal,
    }),
    /只有项目协调者能派工/,
  )
  assert.equal(fixture.spawned.length, 0)
})

test('换下的协调者不能再给原班 worker 发消息', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  await fixture.workers.register({ childId: 'child-9', parentSessionId: 'retired-1', name: '实现工' })
  // 工具面只在建会话时裁一次，退役不重建会话：旧会话手里仍留着 message_worker，
  // 身份必须在调用时再判一遍。索引里已经没有退役后的它。
  const dispatcher = makeDispatcher({
    ctx: fixture.ctx,
    store,
    workers: fixture.workers,
    coordinatorIndex: {
      async awaitIndex() {
        return true
      },
      isCoordinatorSession: (sessionId) => sessionId !== 'retired-1',
    },
  })

  await assert.rejects(
    () => dispatcher.message({
      parent: createParent('retired-1', fixture.delivered),
      sessionId: 'child-9',
      message: '接着做',
      signal: new AbortController().signal,
    }),
    /只有项目协调者能给 worker 发消息/,
  )
  // 拒绝发生在投递之前：既没冷恢复，也没往 worker 里塞消息。
  assert.deepEqual(fixture.resumed, [])
  assert.deepEqual(fixture.delivered, [])
})

test('注册表没读出来时 message_worker 不投递', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  await fixture.workers.register({ childId: 'child-9', parentSessionId: 'parent-1', name: '实现工' })
  const dispatcher = makeDispatcher({
    ctx: fixture.ctx,
    store,
    workers: fixture.workers,
    coordinatorIndex: {
      async awaitIndex() {
        return false
      },
      isCoordinatorSession: () => true,
    },
  })

  await assert.rejects(
    () => dispatcher.message({
      parent: createParent('parent-1', fixture.delivered),
      sessionId: 'child-9',
      message: '接着做',
      signal: new AbortController().signal,
    }),
    /注册表尚未读出/,
  )
  assert.deepEqual(fixture.resumed, [])
})

test('换协调者后新协调者接管原班 worker，退役会话仍然投不进去', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const workers = createWorkerRegistry({ home })
  await workers.register({ childId: 'child-9', parentSessionId: 'retired-1', name: '实现工' })
  const dispatcher = makeDispatcher({
    ctx: fixture.ctx,
    store,
    workers,
    coordinatorIndex: {
      async awaitIndex() {
        return true
      },
      isCoordinatorSession: (sessionId) => sessionId === 'coordinator-2',
    },
  })
  const send = (parentId) => dispatcher.message({
    parent: createParent(parentId, fixture.delivered),
    sessionId: 'child-9',
    message: '接着做',
    signal: new AbortController().signal,
  })

  // 换人前：新协调者过不了父会话校验（登记表里还是退役会话派的工）
  await assert.rejects(() => send('coordinator-2'), /别的会话派的/)

  // 接管：登记表归属与派工器内存态一起改投
  assert.deepEqual(await workers.reassignParent('retired-1', 'coordinator-2'), ['child-9'])
  dispatcher.reassignParent('retired-1', 'coordinator-2')
  assert.equal((await send('coordinator-2')).code, 'sent')

  // 退役会话自己仍然被身份闸挡住
  await assert.rejects(() => send('retired-1'), /只有项目协调者能给 worker 发消息/)
})

test('换协调者后，在飞 worker 的回报投给新协调者', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const workers = createWorkerRegistry({ home })
  // 接手会话能被 `sessionController` 解析出来：换人后投递靠这条路取新 agent
  // （在飞记录里那个是退役会话的活对象，已随改绑丢掉）。
  const handedOverMessages = []
  const handedOver = createParent('parent-2', handedOverMessages)
  const ctx = {
    ...fixture.ctx,
    get(key) {
      if (key === 'sessionController') {
        return {
          async resolveAgent(sessionId) {
            return sessionId === 'parent-2' ? { agent: handedOver } : { error: '会话不在内存' }
          },
        }
      }
      return fixture.ctx.get(key)
    },
  }
  const dispatcher = makeDispatcher({ ctx, store, workers })
  await dispatchAndStart(dispatcher, {
    parent: createParent('parent-1', fixture.delivered),
    initialMessage: '做一件事',
    name: '实现派工',
    signal: new AbortController().signal,
  })
  const workerId = fixture.spawned.at(-1).sessionId

  // 换协调者：登记表与内存态改绑之后这批在飞记录才跟着换父会话
  await workers.reassignParent('parent-1', 'parent-2')
  assert.equal(dispatcher.reassignParent('parent-1', 'parent-2'), 1)
  await fixture.finishTurn(workerId, { text: '改完了' })

  // 回报投给了新协调者，退役会话那边一条都没有
  assert.equal(handedOverMessages.length, 1)
  assert.match(handedOverMessages[0].content?.[0]?.text ?? '', /实现派工/)
  assert.equal(fixture.delivered.length, 0)
  // 已投出：队列清空
  assert.deepEqual(await store.listPending(), [])
})

test('接管后按会话 id 补投：改投过来的通知直接送到新协调者', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  // 队列里躺着一条已改投给新协调者的通知：它没有对应的在飞记录，也没人在等
  await store.enqueue({
    id: 'note-1',
    childId: 'child-1',
    parentSessionId: 'coordinator-2',
    name: '实现工',
    text: '任务「实现工」已结束。',
    createdAt: 1,
    attempts: 0,
  })
  const messages = []
  const parent2 = createParent('coordinator-2', messages)
  const ctx = {
    ...fixture.ctx,
    get(key) {
      if (key === 'sessionController') {
        return {
          async resolveAgent(sessionId) {
            return sessionId === 'coordinator-2' ? { agent: parent2 } : { error: '会话不在内存' }
          },
        }
      }
      return fixture.ctx.get(key)
    },
  }
  const dispatcher = makeDispatcher({ ctx, store, workers: createWorkerRegistry({ home }) })

  assert.equal(await dispatcher.redeliverPendingFor('coordinator-2'), 1)
  assert.equal(messages.length, 1)
  assert.match(messages[0].content?.[0]?.text ?? '', /实现工/)
  assert.deepEqual(await store.listPending(), [])
})

test('补投期间会话转忙：新进等待表的那条仍然送达', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  for (const id of ['note-a', 'note-b']) {
    await store.enqueue({
      id,
      childId: `child-${id}`,
      parentSessionId: 'coordinator-2',
      name: '实现工',
      text: `任务「${id}」已结束。`,
      createdAt: 1,
      attempts: 0,
    })
  }
  const messages = []
  // 投出第一条之后会话转忙：第二条只能先进等待表（补投这一轮里 delivered 已经是 1）
  const parent2 = {
    id: 'coordinator-2',
    status: 'idle',
    followup(message) {
      messages.push(message)
      this.status = 'busy'
    },
  }
  const ctx = {
    ...fixture.ctx,
    get(key) {
      if (key === 'sessionController') {
        return {
          async resolveAgent(sessionId) {
            return sessionId === 'coordinator-2' ? { agent: parent2 } : { error: '会话不在内存' }
          },
        }
      }
      return fixture.ctx.get(key)
    },
  }
  const dispatcher = makeDispatcher({ ctx, store, workers: createWorkerRegistry({ home }) })

  assert.equal(await dispatcher.redeliverPendingFor('coordinator-2'), 1)
  // 会话空闲下来之后，等待表里那条要自己投出去（整表删会把刚进去的它一起丢掉）
  parent2.status = 'idle'
  assert.equal(await waitFor(() => messages.length === 2), true)
  assert.deepEqual(await store.listPending(), [])
})

test('接管后等待中的通知按接手会话的额度计，不绕过自动续行上限', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const workers = createWorkerRegistry({ home })
  const handedOverMessages = []
  const handedOver = createParent('coordinator-2', handedOverMessages)
  const ctx = {
    ...fixture.ctx,
    get(key) {
      if (key === 'sessionController') {
        return {
          async resolveAgent(sessionId) {
            return sessionId === 'coordinator-2' ? { agent: handedOver } : { error: '会话不在内存' }
          },
        }
      }
      return fixture.ctx.get(key)
    },
  }
  const dispatcher = makeDispatcher({ ctx, store, workers, autoResumeLimit: 1 })
  // 旧协调者正忙：这条回报进等待表，条目里的通知还带着旧父会话 id
  const retiredParent = createParent('parent-1', [], 'busy')
  await dispatchAndStart(dispatcher, {
    parent: retiredParent,
    initialMessage: '第一件事',
    name: '实现派工',
    signal: new AbortController().signal,
  })
  await fixture.finishTurn(fixture.spawned.at(-1).sessionId, { text: '第一件事做完了' })
  assert.equal((await store.listPending()).length, 1)

  await workers.reassignParent('parent-1', 'coordinator-2')
  // 这一轮已经没有在飞记录（工已结算），改绑要动的是等待表里的那条通知
  dispatcher.reassignParent('parent-1', 'coordinator-2')
  // 等待表里的那条投给新会话：额度记在新会话名下（上限 1，这里用掉唯一一次）
  assert.equal(await waitFor(() => handedOverMessages.length === 1), true)

  const second = await dispatchAndStart(dispatcher, {
    parent: handedOver,
    initialMessage: '第二件事',
    name: '再来一单',
    signal: new AbortController().signal,
  })
  await fixture.finishTurn(second.childId, { text: '第二件事做完了' })
  // 额度已满：第二条不投，留在队列里等人工开口，而不是被当成 0 额度继续投
  assert.equal(handedOverMessages.length, 1)
  const pending = await store.listPending()
  assert.equal(pending.length, 1)
  assert.match(pending[0].lastError, /连续自动续行已达上限/)
})

test('接管后新会话不可达：在飞回报留给新会话，不投给退役会话', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const workers = createWorkerRegistry({ home })
  // ctx 没有 sessionController：投递只可能回落到记录里握着的 parent 活对象
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers })
  const retiredMessages = []
  await dispatchAndStart(dispatcher, {
    parent: createParent('parent-1', retiredMessages),
    initialMessage: '做一件事',
    name: '实现派工',
    signal: new AbortController().signal,
  })
  const workerId = fixture.spawned.at(-1).sessionId

  await workers.reassignParent('parent-1', 'parent-2')
  dispatcher.reassignParent('parent-1', 'parent-2')
  await fixture.finishTurn(workerId, { text: '改完了' })

  // 换人之后的回报不能落进一个已经不能动手的会话
  assert.deepEqual(retiredMessages, [])
  const pending = await store.listPending()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].parentSessionId, 'parent-2')
})

test('投递途中 worker 报完工，不误报发不出去', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
  const parent = createParent('parent-1', fixture.delivered)
  fixture.agents.set('parent-1', parent)

  const record = await dispatchAndStart(dispatcher, {
    parent,
    initialMessage: '做一件事',
    name: '实现派工',
    signal: new AbortController().signal,
  })
  // worker 在收到续聊消息的同时把上一轮报了：报完工会从在飞表删记录，这条路径在
  // 真实环境里随时可能发生。
  const entry = fixture.spawned.find((item) => item.sessionId === record.childId)
  entry.onFollowup = () => {
    void fixture.finishTurn(record.childId, { text: '上一轮做完了' })
  }

  const outcome = await dispatcher.message({
    parent,
    sessionId: record.childId,
    message: '接着做',
    signal: new AbortController().signal,
  })

  assert.equal(outcome.code, 'merged')
  assert.equal(outcome.name, '实现派工')
})

test('续聊轮 worker 报失败时通知判失败', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
  const parent = createParent('parent-1', fixture.delivered)
  fixture.agents.set('parent-1', parent)

  const record = await dispatchAndStart(dispatcher, {
    parent,
    initialMessage: '做一件事',
    name: '续聊工',
    signal: new AbortController().signal,
  })
  const outcome = await dispatcher.message({
    parent,
    sessionId: record.childId,
    message: '接着做',
    signal: new AbortController().signal,
  })
  assert.equal(outcome.code, 'merged')

  await finishWorker(dispatcher, fixture, { summary: '依赖装不上', outcome: 'failed' })
  await waitFor(() => fixture.delivered.length === 1)

  assert.match(fixture.delivered[0].content[0].text, /状态：failed/)
  assert.match(fixture.delivered[0].content[0].text, /失败原因/)
})

test('续聊轮正常结束仍报完成', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
  const parent = createParent('parent-1', fixture.delivered)
  fixture.agents.set('parent-1', parent)

  const record = await dispatchAndStart(dispatcher, {
    parent,
    initialMessage: '做一件事',
    name: '续聊工',
    signal: new AbortController().signal,
  })
  await dispatcher.message({
    parent,
    sessionId: record.childId,
    message: '接着做',
    signal: new AbortController().signal,
  })
  await finishWorker(dispatcher, fixture, { summary: '续聊产物' })
  await waitFor(() => fixture.delivered.length === 1)

  assert.match(fixture.delivered[0].content[0].text, /状态：completed/)
  assert.match(fixture.delivered[0].content[0].text, /续聊产物/)
})

test('未归档 worker 到顶时拒绝新建，并给出可复用候选', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  await fixture.workers.register({ childId: 'child-old-1', parentSessionId: 'parent-1', name: 'research-sources' })
  await fixture.workers.register({ childId: 'child-old-2', parentSessionId: 'parent-1', name: 'write-summary' })
  const dispatcher = makeDispatcher({
    ctx: fixture.ctx,
    store,
    workers: fixture.workers,
    activeWorkerLimit: 2,
    archivedSessionIds: () => [],
  })

  await assert.rejects(
    () => dispatchAndStart(dispatcher, {
      parent: createParent('parent-1', fixture.delivered),
      initialMessage: '做一件事',
      name: '新工',
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.match(error.message, /已达上限 2/)
      // 候选要能直接被拿去续聊：id 与名字都在提示里。
      assert.match(error.message, /child-old-2 write-summary/)
      assert.match(error.message, /child-old-1 research-sources/)
      assert.match(error.message, /force/)
      return true
    },
  )
  // 拒绝发生在拉起会话之前
  assert.equal(fixture.spawned.length, 0)
})

test('名册到顶时不推荐挂着未完成卡的 worker，单独说明怎么释放', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  try {
    const store = createNotificationStore({ home })
    const cards = createCardStore({ home })
    await fixture.workers.register({ childId: 'child-bound', parentSessionId: 'parent-1', name: 'dev-a' })
    await fixture.workers.register({ childId: 'child-free', parentSessionId: 'parent-1', name: 'dev-b' })
    await cards.create({ title: '看板上的活', slots: { dev: { sessionId: 'child-bound' } } })
    const dispatcher = makeDispatcher({
      ctx: fixture.ctx,
      store,
      workers: fixture.workers,
      activeWorkerLimit: 2,
      archivedSessionIds: () => [],
      listCardBindings: (sessionId) => cards.bindingsOf(sessionId),
    })

    await assert.rejects(
      () => dispatcher.dispatch({
        parent: createParent('parent-1', fixture.delivered),
        name: '新工',
        signal: new AbortController().signal,
      }),
      (error) => {
        const [reusable = '', blocked = ''] = error.message.split('挂着未完成卡')
        // 挂着卡的不能接新活，不该出现在「可复用」清单里。
        assert.match(reusable, /child-free dev-b/)
        assert.doesNotMatch(reusable, /child-bound/)
        assert.match(blocked, /child-bound dev-a/)
        assert.match(blocked, /#1 看板上的活/)
        assert.match(blocked, /标 done \/ archived/)
        return true
      },
    )
  } finally {
  }
})

test('关闭卡片后 worker 被释放，可以接新任务', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  try {
    const store = createNotificationStore({ home })
    const cards = createCardStore({ home })
    await fixture.workers.register({ childId: 'child-1', parentSessionId: 'parent-1', name: 'dev-a' })
    const card = await cards.create({ title: '旧活', slots: { dev: { sessionId: 'child-1' } } })
    const dispatcher = makeDispatcher({
      ctx: fixture.ctx,
      store,
      workers: fixture.workers,
      listCardBindings: (sessionId) => cards.bindingsOf(sessionId),
    })
    const parent = createParent('parent-1', fixture.delivered)

    // 挂着未完成的卡：不能接别的工作。
    await assert.rejects(
      () => dispatcher.message({
        parent,
        sessionId: 'child-1',
        message: '去做别的活',
        signal: new AbortController().signal,
      }),
      /挂着未完成的卡/,
    )

    // 关闭卡片即释放槽位：绑定真的被清掉（不只是门禁放行），角色与卡片注入
    // 也随之停止；否则 worker 收工后仍带着旧卡的上下文。
    await cards.update({ id: card.id, status: 'done' })
    assert.deepEqual((await cards.get(card.id)).slots, {})
    assert.equal(cards.slotIndex.has('child-1'), false)
    assert.equal(cards.cardIndex.has('child-1'), false)

    // 同一条 worker 立刻可以接新任务。
    const result = await dispatcher.message({
      parent,
      sessionId: 'child-1',
      message: '去做新活',
      signal: new AbortController().signal,
    })
    assert.equal(result.code, 'sent')
  } finally {
  }
})

test('名册已归档的记录不占名额', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  await fixture.workers.register({ childId: 'child-old-1', parentSessionId: 'parent-1', name: '旧工' })
  const dispatcher = makeDispatcher({
    ctx: fixture.ctx,
    store,
    workers: fixture.workers,
    activeWorkerLimit: 1,
    // 唯一那条已归档：不算在用，新建应当放行。
    archivedSessionIds: () => ['child-old-1'],
  })

  const record = await dispatchAndStart(dispatcher, {
    parent: createParent('parent-1', fixture.delivered),
    initialMessage: '做一件事',
    name: '新工',
    signal: new AbortController().signal,
  })
  assert.equal(record.name, '新工')
  assert.equal(fixture.spawned.length, 1)
})

test('force 非空时越过名册上限', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  await fixture.workers.register({ childId: 'child-old-1', parentSessionId: 'parent-1', name: '占位' })
  const dispatcher = makeDispatcher({
    ctx: fixture.ctx,
    store,
    workers: fixture.workers,
    activeWorkerLimit: 1,
    archivedSessionIds: () => [],
  })

  const record = await dispatchAndStart(dispatcher, {
    parent: createParent('parent-1', fixture.delivered),
    initialMessage: '做一件事',
    name: '新工',
    force: '现有 worker 的上下文已被上一轮任务污染，需要干净上下文',
    signal: new AbortController().signal,
  })
  assert.match(record.childId, /^worker-/)
})

test('投递未声明 cardId 而 worker 挂着未完成的卡时拒绝', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  await fixture.workers.register({ childId: 'child-9', parentSessionId: 'parent-1', name: '实现工' })
  const dispatcher = makeDispatcher({
    ctx: fixture.ctx,
    store,
    workers: fixture.workers,
    listCardBindings: async (sessionId) => (sessionId === 'child-9'
      ? [{ cardId: 'card-1', number: 7, title: '实现登录', status: 'active', slot: 'dev' }]
      : []),
  })

  await assert.rejects(
    () => dispatcher.message({
      parent: createParent('parent-1', fixture.delivered),
      sessionId: 'child-9',
      message: '接着做',
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.match(error.message, /未声明同卡/)
      assert.match(error.message, /#7 实现登录/)
      assert.match(error.message, /card-1/)
      assert.match(error.message, /槽位 dev/)
      return true
    },
  )
  // 拒绝发生在投递之前：既没建会话，也没冷恢复。
  assert.equal(fixture.spawned.length, 0)
  assert.deepEqual(fixture.resumed, [])
})

test('声明同卡时放行，声明别的卡时拒绝', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  await fixture.workers.register({ childId: 'child-9', parentSessionId: 'parent-1', name: '实现工' })
  const dispatcher = makeDispatcher({
    ctx: fixture.ctx,
    store,
    workers: fixture.workers,
    listCardBindings: async (sessionId) => (sessionId === 'child-9'
      ? [{ cardId: 'card-1', number: 7, title: '实现登录', status: 'active', slot: 'dev' }]
      : []),
  })
  const parent = createParent('parent-1', fixture.delivered)

  const status = await dispatcher.message({
    parent,
    sessionId: 'child-9',
    message: '接着做',
    cardId: 'card-1',
    signal: new AbortController().signal,
  })
  assert.equal(status.code, 'sent')

  await assert.rejects(
    () => dispatcher.message({
      parent,
      sessionId: 'child-9',
      message: '换个活',
      cardId: 'card-2',
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.match(error.message, /不一致/)
      assert.match(error.message, /card-2/)
      return true
    },
  )
})

test('同时挂两张未完成的卡时拒绝投递，声明哪张都一样', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  await fixture.workers.register({ childId: 'child-9', parentSessionId: 'parent-1', name: '实现工' })
  const bindings = [
    { cardId: 'card-1', number: 7, title: '实现登录', status: 'active', slot: 'dev' },
    { cardId: 'card-2', number: 8, title: '审查登录', status: 'active', slot: 'review' },
  ]
  const dispatcher = makeDispatcher({
    ctx: fixture.ctx,
    store,
    workers: fixture.workers,
    listCardBindings: async (sessionId) => (sessionId === 'child-9' ? bindings : []),
  })
  const parent = createParent('parent-1', fixture.delivered)

  // 两条工作线并行时产物无从归属；角色注入本来就只按一张卡算，上下文早就不一致。
  for (const cardId of ['card-1', 'card-2', undefined]) {
    await assert.rejects(
      () => dispatcher.message({
        parent,
        sessionId: 'child-9',
        message: '接着做',
        ...(cardId === undefined ? {} : { cardId }),
        signal: new AbortController().signal,
      }),
      (error) => {
        assert.match(error.message, /同时挂着 2 张未完成的卡/)
        assert.match(error.message, /#7 实现登录/)
        assert.match(error.message, /#8 审查登录/)
        assert.match(error.message, /只留一张 active 卡/)
        return true
      },
    )
  }
  assert.deepEqual(fixture.resumed, [])
})

test('挂着已完成卡的 worker 可以直接投递', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  await fixture.workers.register({ childId: 'child-9', parentSessionId: 'parent-1', name: '实现工' })
  const dispatcher = makeDispatcher({
    ctx: fixture.ctx,
    store,
    workers: fixture.workers,
    listCardBindings: async () => ([{ cardId: 'card-1', number: 7, title: '实现登录', status: 'done', slot: 'dev' }]),
  })

  const status = await dispatcher.message({
    parent: createParent('parent-1', fixture.delivered),
    sessionId: 'child-9',
    message: '接新活',
    signal: new AbortController().signal,
  })
  assert.equal(status.code, 'sent')
})

test('派工时把 worker 会话标题定成 name', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
  const parent = createParent('parent-1', fixture.delivered)

  const record = await dispatchAndStart(dispatcher, {
    parent,
    initialMessage: '做一件事',
    name: 'research-sources',
    signal: new AbortController().signal,
  })

  // 不钉住标题时宿主会按首条 user 消息自动起名，侧栏看到的是任务正文前几个字。
  assert.equal(fixture.titles.get(record.childId), 'research-sources')
})

test('宿主缺 sessionTitle 服务时派工照常成功，只是标题保持默认', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const warnings = []
  const inner = fixture.ctx.get
  fixture.ctx.get = (key) => (key === 'sessionTitle' ? undefined : inner(key))
  const dispatcher = makeDispatcher({
    ctx: fixture.ctx,
    store,
    workers: fixture.workers,
    logger: (message) => warnings.push(message),
  })

  const record = await dispatchAndStart(dispatcher, {
    parent: createParent('parent-1', fixture.delivered),
    initialMessage: '做一件事',
    name: 'research-sources',
    signal: new AbortController().signal,
  })

  assert.match(record.childId, /^worker-/)
  assert.equal(record.name, 'research-sources')
  assert.ok(warnings.some((message) => message.includes('sessionTitle')))
})

test('续聊带 rename 时登记表与会话标题都改到新名字', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
  const parent = createParent('parent-1', fixture.delivered)

  const record = await dispatchAndStart(dispatcher, {
    parent,
    initialMessage: '做一件事',
    name: 'research-sources',
    signal: new AbortController().signal,
  })
  const status = await dispatcher.message({
    parent,
    sessionId: record.childId,
    message: '换个角色接着写',
    name: 'write-summary',
    signal: new AbortController().signal,
  })
  assert.equal(status.name, 'write-summary')
  assert.equal((await fixture.workers.get(record.childId)).name, 'write-summary')
  assert.equal(fixture.titles.get(record.childId), 'write-summary')

  // 完成通知也要用新名字：worker 已经换过角色，还喊旧名会让人对不上号。
  await finishWorker(dispatcher, fixture, { summary: '做完了' })
  await waitFor(() => fixture.delivered.length === 1)
  assert.match(fixture.delivered[0].content[0].text, /任务「write-summary」已结束/)
})

test('一轮只结算一次回报，重复上报不重复唤醒', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const store = createNotificationStore({ home })
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
  const parent = createParent('parent-1', fixture.delivered)
  fixture.agents.set('parent-1', parent)

  const record = await dispatchAndStart(dispatcher, {
    parent,
    initialMessage: '做一件事',
    name: '实现派工',
    signal: new AbortController().signal,
  })
  assert.equal(await finishWorker(dispatcher, fixture), true)
  // worker 一时不确定有没有报过、又报一次：不能把协调者唤醒两遍。
  assert.equal(await finishWorker(dispatcher, fixture), false)
  await waitFor(() => fixture.delivered.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(fixture.delivered.length, 1)
  assert.equal(record.childId, fixture.spawned[0].sessionId)
})

test('投递写盘失败不会重结算，也不会把新一轮产物标成这一轮', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const real = createNotificationStore({ home })
  let failures = 1
  const store = {
    ...real,
    markDelivered: async (id) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('EIO: i/o error, write')
      }
      return real.markDelivered(id)
    },
  }
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store, workers: fixture.workers })
  const parent = createParent('parent-1', fixture.delivered)
  fixture.agents.set('parent-1', parent)

  await dispatchAndStart(dispatcher, {
    parent,
    initialMessage: '做一件事',
    name: '实现派工',
    signal: new AbortController().signal,
  })
  // 通知已经投出，但「已投递」标记写盘失败：落盘即结算成功，不能再结算一遍。
  assert.equal(await finishWorker(dispatcher, fixture, { summary: '第一轮产物' }), true)
  assert.equal(fixture.delivered.length, 1)
  assert.equal(dispatcher.inflightCount(), 0)

  // worker 随后又跑了一轮（这一轮没有派工）：不产生第二条通知。
  await finishWorker(dispatcher, fixture, { summary: '新一轮产物' })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(fixture.delivered.length, 1)
  assert.match(fixture.delivered[0].content[0].text, /第一轮产物/)
  assert.doesNotMatch(fixture.delivered[0].content[0].text, /新一轮产物/)
  // 队列里的那一条等空闲检测或补投通道处理，不重复入队。
  const pending = await real.listPending()
  assert.equal(pending.length, 1)
  assert.match(pending[0].text, /第一轮产物/)
})

test('非派工的轮次不攒 assistant 文本，不会把人的话当成 worker 产物', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const dispatcher = makeDispatcher({ ctx: fixture.ctx, store: createNotificationStore({ home }), workers: fixture.workers })
  const parent = createParent('parent-1', fixture.delivered)
  fixture.agents.set('parent-1', parent)

  const record = await dispatchAndStart(dispatcher, {
    parent,
    initialMessage: '做一件事',
    name: '实现派工',
    signal: new AbortController().signal,
  })
  await finishWorker(dispatcher, fixture, { summary: '第一轮做完了' })
  await waitFor(() => fixture.delivered.length === 1)

  // 人下钻到 worker 会话自己聊：这一轮还在跑，assistant 文本已落、turn/end 未到。
  await fixture.emitSessionEvent(record.childId, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '人自己聊出来的东西' }] } },
  })
  // 协调者此时给它投了下一轮，登记在飞记录。
  await dispatcher.message({
    parent,
    sessionId: record.childId,
    message: '接着做',
    signal: new AbortController().signal,
  })
  // 人的这一轮结束：它不是派工轮，这一轮没有派工产物，摘要不能拿人那句话。
  assert.equal(await fixture.finishTurn(record.childId, { withMessage: false }), true)
  await waitFor(() => fixture.delivered.length === 2)

  const text = fixture.delivered[1].content[0].text
  assert.match(text, /（worker 未产出文本）/)
  assert.doesNotMatch(text, /人自己聊出来的东西/)
})

test('通知落盘失败时保留在飞记录，重试送出的仍是这一轮的产物', async () => {
  const fixture = createFixture()
  const home = await makeTempDir('dsh-leader-kit-dispatch-')
  const real = createNotificationStore({ home })
  let failures = 1
  const store = {
    ...real,
    enqueue: async (notification) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('DISK_FULL')
      }
      return real.enqueue(notification)
    },
  }
  const logs = []
  const dispatcher = makeDispatcher({
    ctx: fixture.ctx,
    store,
    workers: fixture.workers,
    logger: (line) => logs.push(line),
  })
  const parent = createParent('parent-1', fixture.delivered)
  fixture.agents.set('parent-1', parent)

  await dispatchAndStart(dispatcher, {
    parent,
    initialMessage: '做一件事',
    name: '实现派工',
    signal: new AbortController().signal,
  })

  // 落盘失败要留痕，而且不能把在飞记录删掉——删了这条回报就没了，协调者还在等它。
  assert.equal(await finishWorker(dispatcher, fixture, { summary: '第一轮产物' }), false)
  assert.equal(dispatcher.inflightCount(), 1)
  assert.ok(logs.some((line) => /DISK_FULL/.test(line)), `期望日志留痕，实际：${logs.join(' / ')}`)

  // 这个 worker 下一次轮次结束时再结算。第二轮文本刻意不同：重试必须送出第一轮
  // 冻结下来的摘要，而不是被下一轮覆盖后的内容。
  assert.equal(await finishWorker(dispatcher, fixture, { summary: '第二轮产物' }), true)
  assert.equal(dispatcher.inflightCount(), 0)
  await waitFor(() => fixture.delivered.length === 1)
  const text = fixture.delivered[0].content[0].text
  assert.match(text, /第一轮产物/)
  assert.doesNotMatch(text, /第二轮产物/)
  assert.equal((await store.listPending()).length, 0)
})
