/**
 * 续聊：给已派出的 worker 再投一次任务。
 *
 * worker 是常驻根会话，所以续聊有两种形态——会话还在内存里就直接投（并入当前
 * 轮次），进程重启后会话不在内存就冷恢复再投。这个文件覆盖两种形态、登记表校验
 * 与失败回滚。
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { cleanupTempDirs, makeTempDir } from './helpers/temp-dir.js'
import { createDispatcher } from '../src/host/dispatch.js'
import { createNotificationStore } from '../src/host/notification-store.js'
import { createWorkerRegistry } from '../src/host/worker-registry.js'
import { createWorkerSessions } from '../src/host/worker-sessions.js'

after(cleanupTempDirs)

/**
 * 构造一个假的宿主上下文：agents 记录建会话、冷恢复与投递。
 *
 * @param {{ resumeError?: Error }} [options] - 夹具选项
 * @returns {object} 上下文与记录
 */
function createHost({ resumeError } = {}) {
  /** 建过的会话：{ sessionId, messages, disposed } */
  const spawned = []
  /** 冷恢复过的会话 id */
  const resumed = []
  let sequence = 0

  /**
   * 造一个假 AgentHandle。
   *
   * @param {string} sessionId - 会话 id
   * @returns {object} 句柄
   */
  function createHandle(sessionId) {
    const entry = { sessionId, messages: [], disposed: false }
    spawned.push(entry)
    const session = { id: sessionId, header: { id: sessionId } }
    return {
      entry,
      handle: {
        agent: {
          id: sessionId,
          session,
          followup(message) {
            entry.messages.push(message)
          },
        },
        async dispose() {
          entry.disposed = true
        },
      },
    }
  }

  const agents = {
    async create({ sessionId }) {
      sequence += 1
      return createHandle(sessionId ?? `worker-${sequence}`).handle
    },
    async resume({ resumeSessionId }) {
      if (resumeError !== undefined) throw resumeError
      resumed.push(resumeSessionId)
      return createHandle(resumeSessionId).handle
    },
  }

  /** 订阅上来的 `session/event` 监听器 */
  const sessionEventListeners = []
  const ctx = {
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
      if (key === 'sessions') return { get: () => undefined }
      if (key === 'sessionTitle') return { rename() {} }
      if (key === 'sessionPersistence') return { append() {} }
      if (key === 'sessionQuery') return { observeSession() {} }
      return undefined
    },
  }

  /**
   * 让某个 worker 走完一轮：先落 assistant 文本，再落 `turn/end`。
   *
   * @param {string} sessionId - 会话 id
   * @param {{ text?: string, reason?: object }} [options] - 轮次内容
   * @returns {Promise<unknown>} 结算结果（是否确实结算了一条在飞记录）
   */
  async function finishTurn(sessionId, { text = '产物在此', reason = { kind: 'completed' } } = {}) {
    const settle = sessionEventListeners
      .map((listener) => listener({ id: sessionId }, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text }] } },
      }))
      .filter((item) => item !== undefined)
    await Promise.all(settle)
    const settled = sessionEventListeners
      .map((listener) => listener({ id: sessionId }, { type: 'turn/end', data: { reason } }))
      .filter((item) => item !== undefined)
    return (await Promise.all(settled))[0]
  }

  return { ctx, spawned, resumed, finishTurn }
}

/** 协调者索引假件：续聊用例都在协调者会话里跑，默认放行。 */
const coordinatorIndex = {
  async awaitIndex() {
    return true
  },
  isCoordinatorSession: () => true,
}

/**
 * 建夹具：一份宿主上下文、一份落盘后端、一个派工器。
 *
 * @param {{ resumeError?: Error }} [options] - 夹具选项
 * @returns {Promise<object>} 夹具
 */
async function createFixture({ resumeError } = {}) {
  const host = createHost({ resumeError })
  const delivered = []
  const home = await makeTempDir('dsh-leader-kit-continuation-')
  const store = createNotificationStore({ home })
  const workers = createWorkerRegistry({ home })
  const parent = {
    id: 'parent-1',
    status: 'idle',
    followup(message) {
      delivered.push(message)
    },
  }

  /**
   * 用同一份宿主上下文新建派工器。重建相当于插件重启：内存里的 worker 句柄全丢
   * 了，续聊只能走冷恢复。
   *
   * @returns {object} 派工器
   */
  function makeDispatcher() {
    return createDispatcher({
      ctx: host.ctx,
      store,
      workers,
      workerSessions: createWorkerSessions({ ctx: host.ctx }),
      coordinatorIndex,
    })
  }

  return { ...host, dispatcher: makeDispatcher(), makeDispatcher, delivered, store, workers, parent }
}

test('派工同时登记进 worker 登记表', async () => {
  const fixture = await createFixture()
  const record = await fixture.dispatcher.dispatch({
    parent: fixture.parent,
    initialMessage: '做一件事',
    name: '首轮',
    signal: new AbortController().signal,
  })

  const registered = await fixture.workers.get(record.childId)
  assert.notEqual(registered, undefined)
  assert.equal(registered.parentSessionId, 'parent-1')
  assert.equal(registered.name, '首轮')
})

test('缺会话持久化后端时拒绝派工', async () => {
  const host = createHost()
  const ctx = {
    on: () => () => {},
    get: (key) => (key === 'sessionPersistence'
      ? undefined
      : key === 'sessionQuery'
        ? { observeSession() {} }
        : host.ctx.get(key)),
  }
  const home = await makeTempDir('dsh-leader-kit-continuation-')
  const dispatcher = createDispatcher({
    ctx,
    store: createNotificationStore({ home }),
    workers: createWorkerRegistry({ home }),
    workerSessions: createWorkerSessions({ ctx }),
    coordinatorIndex,
  })

  await assert.rejects(
    () => dispatcher.dispatch({
      parent: { id: 'p' },
      initialMessage: 't',
      name: 'l',
      signal: new AbortController().signal,
    }),
    /持久化/,
  )
  // 拒绝发生在建会话之前，不该留下半个 worker。
  assert.equal(host.spawned.length, 0)
})

test('缺会话查询后端时拒绝派工', async () => {
  const host = createHost()
  const ctx = {
    on: () => () => {},
    get: (key) => (key === 'sessionQuery'
      ? undefined
      : key === 'sessionPersistence'
        ? { append() {} }
        : host.ctx.get(key)),
  }
  const home = await makeTempDir('dsh-leader-kit-continuation-')
  const dispatcher = createDispatcher({
    ctx,
    store: createNotificationStore({ home }),
    workers: createWorkerRegistry({ home }),
    workerSessions: createWorkerSessions({ ctx }),
    coordinatorIndex,
  })

  await assert.rejects(
    () => dispatcher.dispatch({
      parent: { id: 'p' },
      initialMessage: 't',
      name: 'l',
      signal: new AbortController().signal,
    }),
    /查询/,
  )
  assert.equal(host.spawned.length, 0)
})

test('worker 在飞时续聊并入当前执行', async () => {
  const fixture = await createFixture()
  const record = await fixture.dispatcher.dispatch({
    parent: fixture.parent,
    initialMessage: '做一件事',
    name: '在飞',
    signal: new AbortController().signal,
  })
  const status = await fixture.dispatcher.message({
    parent: fixture.parent,
    sessionId: record.childId,
    message: '顺手补个测试',
    signal: new AbortController().signal,
  })

  assert.equal(status.code, 'merged')
  assert.equal(status.name, '在飞')
  // 同一条会话收到第二条消息：没有另建会话。
  assert.equal(fixture.spawned.length, 1)
  const entry = fixture.spawned[0]
  assert.equal(entry.messages.length, 2)
  assert.equal(entry.messages[1].content[0].text, '顺手补个测试')
})

test('插件重启后会话不在内存，续聊走冷恢复', async () => {
  const fixture = await createFixture()
  const record = await fixture.dispatcher.dispatch({
    parent: fixture.parent,
    initialMessage: '做一件事',
    name: '首轮',
    signal: new AbortController().signal,
  })
  // 新派工器 = 插件重启：句柄全丢，只剩落盘的登记表与宿主上的会话日志。
  const restarted = fixture.makeDispatcher()

  const status = await restarted.message({
    parent: fixture.parent,
    sessionId: record.childId,
    message: '再核对一遍',
    signal: new AbortController().signal,
  })

  assert.equal(status.code, 'sent')
  assert.equal(status.name, '首轮')
  assert.deepEqual(fixture.resumed, [record.childId])
  const entry = fixture.spawned.at(-1)
  assert.equal(entry.sessionId, record.childId)
  assert.equal(entry.messages[0].content[0].text, '再核对一遍')
})

test('没有派工记录的会话拒绝续聊', async () => {
  const fixture = await createFixture()
  await assert.rejects(
    () => fixture.dispatcher.message({
      parent: fixture.parent,
      sessionId: 'session-别家的',
      message: 'hi',
      signal: new AbortController().signal,
    }),
    /派工记录/,
  )
})

test('别的会话派的 worker 不能跨会话续聊', async () => {
  const fixture = await createFixture()
  const record = await fixture.dispatcher.dispatch({
    parent: fixture.parent,
    initialMessage: '做一件事',
    name: '首轮',
    signal: new AbortController().signal,
  })

  await assert.rejects(
    () => fixture.dispatcher.message({
      parent: { ...fixture.parent, id: 'parent-别的' },
      sessionId: record.childId,
      message: 'hi',
      signal: new AbortController().signal,
    }),
    /跨会话/,
  )
})

test('冷恢复失败时不登记在飞记录，也不投递回报', async () => {
  const fixture = await createFixture({ resumeError: new Error('NOT_RESUMABLE') })
  const record = await fixture.dispatcher.dispatch({
    parent: fixture.parent,
    initialMessage: '做一件事',
    name: '首轮',
    signal: new AbortController().signal,
  })
  const restarted = fixture.makeDispatcher()
  // 真实进程里重启后只剩这一个派工器；夹具里两个都还订阅着，先卸掉旧的——
  // 否则下面那个 `turn/end` 会被上一轮派工的记录结算掉，测的就不是重启后了。
  fixture.dispatcher.dispose()

  await assert.rejects(
    () => restarted.message({
      parent: fixture.parent,
      sessionId: record.childId,
      message: 'x',
      signal: new AbortController().signal,
    }),
    /NOT_RESUMABLE/,
  )

  // 投递没成功，这一轮不存在：worker 那时结束的轮次也不该结算出通知。
  assert.equal(await fixture.finishTurn(record.childId, { text: 'x' }), false)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(fixture.delivered.length, 0)
  assert.equal((await fixture.store.listPending()).length, 0)
})
