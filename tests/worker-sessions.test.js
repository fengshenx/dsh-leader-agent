/**
 * worker 会话的生命周期：建、投、销毁。
 *
 * 这一层是「worker 常驻」的落点——根会话由本模块持有的 AgentHandle 决定生死，
 * 归档或插件卸载时才 dispose。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkerSessions } from '../src/host/worker-sessions.js'

/**
 * 造一个假的宿主上下文：记录建/恢复/投递/销毁。
 *
 * @param {{ missingAgents?: boolean, missingModel?: boolean, missingPresets?: boolean, createError?: Error, followupError?: Error }} [options] - 夹具选项
 * @returns {object} 上下文与记录
 */
function createFixture({ missingAgents = false, missingModel = false, missingPresets = false, brokenPresets = false, missingProjections = false, brokenProjections = false, createError, followupError, workspaceExists = true, attachError } = {}) {
  const created = []
  const resumed = []
  /** 挂进工作区的记录：`{ workspaceId, sessionId }` */
  const attached = []
  /** 每次冷恢复传给 `agents.resume` 的完整 options */
  const resumeOptions = []
  const titles = []
  /** 被挂上 agent preset 的作用域，按调用顺序 */
  const mounts = []
  /** 每次 mount 用的 preset id */
  const mountIds = []
  /** 传给 `agents.create` 的会话 id，含没建成的那些 */
  const requested = []
  let sequence = 0

  const agents = {
    async create(options) {
      requested.push(options.sessionId)
      if (createError !== undefined) throw createError
      sequence += 1
      const sessionId = options.sessionId ?? `worker-${sequence}`
      const entry = { options, sessionId, messages: [], disposed: false }
      created.push(entry)
      return {
        agent: {
          id: sessionId,
          session: { id: sessionId, header: { id: sessionId } },
          followup(message) {
            if (followupError !== undefined) throw followupError
            entry.messages.push(message)
          },
        },
        async dispose() {
          entry.disposed = true
        },
      }
    },
    async resume(options) {
      resumed.push(options.resumeSessionId)
      resumeOptions.push(options)
      const entry = { options, sessionId: options.resumeSessionId, messages: [], disposed: false }
      created.push(entry)
      return {
        agent: {
          id: entry.sessionId,
          session: { id: entry.sessionId, header: { id: entry.sessionId } },
          followup(message) {
            entry.messages.push(message)
          },
        },
        async dispose() {
          entry.disposed = true
        },
      }
    },
  }

  const ctx = {
    get(key) {
      if (key === 'agents') return missingAgents ? undefined : agents
      if (key === 'agentDefaultModel' && !missingModel) {
        return { currentSelection: () => ({ provider: 'mock', model: 'mock-echo', reasoningEffort: 'low' }) }
      }
      if (key === 'sessionTitle') {
        return {
          rename(session, title) {
            titles.push({ sessionId: session.id, title })
          },
        }
      }
      if (key === 'workspaceRegistry') {
        return {
          get: (workspaceId) => (workspaceExists
            ? {
                id: workspaceId,
                sessionIds: [],
                async attachSession(sessionId) {
                  if (attachError !== undefined) throw attachError
                  attached.push({ workspaceId, sessionId })
                },
              }
            : undefined),
        }
      }
      if (key === 'agentPresets' && brokenPresets) {
        return { resolve: async () => ({ id: 'standard' }) }
      }
      if (key === 'agentPresets' && !missingPresets) {
        // 方法面照 rc.2：registry 只有 resolve / mount，没有 presetForSession()。
        return {
          async resolve(id) { return { id: id ?? 'standard' } },
          async mount(agentCtx, id) {
            mounts.push(agentCtx)
            mountIds.push(id)
          },
        }
      }
      // 冷恢复的 preset 从会话投影读（rc.2 的 registry 也走这条路）。投影值与
      // 默认 id 故意不同，否则用例区分不出「读了投影」和「用了默认」。
      if (key === 'sessionProjections' && brokenProjections) return {}
      if (key === 'sessionProjections' && !missingProjections) {
        return {
          stateOf: (session, name) => (name === 'agentPreset' ? 'custom' : null),
        }
      }
      return undefined
    },
  }
  return { ctx, created, resumed, resumeOptions, titles, requested, mounts, mountIds, attached }
}

test('建会话时用带前缀的会话 id，并把任务简报即刻投进去', async () => {
  const fixture = createFixture()
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  const sessionId = await sessions.spawn({
    cwd: '/repo',
    name: 'research-sources',
    initialMessage: '查一下上游依赖',
    parentSessionId: 'coordinator-1',
    signal: new AbortController().signal,
  })

  assert.match(sessionId, /^worker-/)
  const entry = fixture.created[0]
  assert.equal(entry.options.sessionId, sessionId)
  // 工作目录决定会话归属哪个项目，必须传给宿主而不是事后改。
  assert.equal(entry.options.meta.cwd, '/repo')
  assert.equal(entry.messages.length, 1)
  assert.equal(entry.messages[0].content[0].text, '查一下上游依赖')
  assert.equal(entry.messages[0].source.kind, 'dsh-leader-kit/worker-task')
  assert.equal(entry.messages[0].source.name, 'research-sources')
  assert.equal(entry.messages[0].source.parentSessionId, 'coordinator-1')
})

test('建会话时把显示名钉成会话标题', async () => {
  const fixture = createFixture()
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  const sessionId = await sessions.spawn({
    name: 'research-sources',
    initialMessage: '查',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })

  // 不钉住标题时宿主会拿首条 user 消息自动起名，侧栏看到的是任务正文。
  assert.deepEqual(fixture.titles, [{ sessionId, title: 'research-sources' }])
})

test('建会话时带上默认模型选择，否则系统提示里的 {{model}} 变量没值', async () => {
  const fixture = createFixture()
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  await sessions.spawn({
    name: 'w',
    initialMessage: 'x',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })

  const options = fixture.created[0].options.agentOptions
  assert.equal(options.provider, 'mock')
  assert.equal(options.model, 'mock-echo')
  assert.equal(options.reasoningEffort, 'low')
})

test('没有默认模型服务时不塞空的 agentOptions', async () => {
  const fixture = createFixture({ missingModel: true })
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  await sessions.spawn({
    name: 'w',
    initialMessage: 'x',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })

  assert.equal('agentOptions' in fixture.created[0].options, false)
})

test('建会话时挂默认 agent preset：不挂就没有 bash / read', async () => {
  const fixture = createFixture()
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  await sessions.spawn({
    name: 'w',
    initialMessage: 'x',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })

  // 宿主把内建工具挂在 preset 组合里，只有 sessionController 会替调用方挂；
  // 走 agents.create 的会话必须自己给 setup。
  const setup = fixture.created[0].options.setup
  assert.equal(typeof setup, 'function')
  const agentCtx = { scope: 'worker' }
  await setup(agentCtx)
  assert.deepEqual(fixture.mounts, [agentCtx])
  assert.deepEqual(fixture.mountIds, ['standard'])
})

test('建会话把 preset id 写进 meta.agentPreset，投影才读得到', async () => {
  const fixture = createFixture()
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  await sessions.spawn({
    name: 'w',
    initialMessage: 'x',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })

  // 官方 sessionController 建会话时就写这个字段，resume 与 UI 都从投影读回。
  assert.equal(fixture.created[0].options.meta.agentPreset, 'standard')
})

test('agentPresets 存在但缺 mount() 时当场报错，不静默建一个没有工具的会话', async () => {
  const fixture = createFixture({ brokenPresets: true })
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  await assert.rejects(
    () => sessions.spawn({
      name: 'w',
      initialMessage: 'x',
      parentSessionId: 'c',
      signal: new AbortController().signal,
    }),
    /缺少 mount\(\)/,
  )
  assert.deepEqual(fixture.requested, [])
})

test('组合里没有 agentPresets 服务时记一行日志再退化', async () => {
  const fixture = createFixture({ missingPresets: true })
  const lines = []
  const sessions = createWorkerSessions({ ctx: fixture.ctx, logger: (line) => lines.push(line) })

  await sessions.spawn({
    name: 'w',
    initialMessage: 'x',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })

  // 退化是允许的（headless / sdk），但必须留痕：否则 worker 没有 bash / read
  // 又是一次无声故障。
  assert.equal(lines.length, 1)
  assert.match(lines[0], /没有 agentPresets 服务/)
})

test('组合里没有 agent preset 服务时不传 setup', async () => {
  const fixture = createFixture({ missingPresets: true })
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  await sessions.spawn({
    name: 'w',
    initialMessage: 'x',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })

  assert.equal('setup' in fixture.created[0].options, false)
})

test('冷恢复也挂 agent preset：新作用域不会自己带着 preset 回来', async () => {
  const fixture = createFixture()
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  await sessions.send({
    sessionId: 'worker-1',
    text: '继续',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })

  // 断言落在恢复路径上：create 分支同样带 setup，读 created[0] 会让用例
  // 在「send 回归成新建会话」时仍然绿。
  assert.deepEqual(fixture.resumed, ['worker-1'])
  const setup = fixture.resumeOptions[0].setup
  assert.equal(typeof setup, 'function')
  const agentCtx = { scope: 'resumed' }
  await setup(agentCtx, { session: { id: 'worker-1' } })
  assert.deepEqual(fixture.mounts, [agentCtx])
  // 读的是会话投影里记的 preset（'custom'），不是默认的 'standard'
  assert.deepEqual(fixture.mountIds, ['custom'])
})

test('冷恢复缺投影服务时记一行日志，再用默认 preset', async () => {
  const fixture = createFixture({ missingProjections: true })
  const lines = []
  const sessions = createWorkerSessions({ ctx: fixture.ctx, logger: (line) => lines.push(line) })

  await sessions.send({
    sessionId: 'worker-1',
    text: '继续',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })
  const setup = fixture.resumeOptions[0].setup
  await setup({ scope: 'resumed' }, { session: { id: 'worker-1' } })

  // 缺投影服务时只能用默认 preset，但「用户换过的 preset 丢了」必须留痕
  assert.deepEqual(fixture.mountIds, [undefined])
  assert.match(lines.at(-1), /没有 sessionProjections 服务/)
})

test('投影服务缺 stateOf() 时抛错，不静默用默认', async () => {
  const fixture = createFixture({ brokenProjections: true })
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  await sessions.send({
    sessionId: 'worker-1',
    text: '继续',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })
  const setup = fixture.resumeOptions[0].setup

  await assert.rejects(
    () => setup({ scope: 'resumed' }, { session: { id: 'worker-1' } }),
    /缺少 stateOf\(\)/,
  )
})

test('没有 cwd 时不给宿主塞空的 cwd 键', async () => {
  const fixture = createFixture()
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  await sessions.spawn({
    name: 'w',
    initialMessage: 'x',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })

  assert.equal('cwd' in fixture.created[0].options.meta, false)
})

test('派出的会话立刻算 worker，供同步的工具面裁剪判定', async () => {
  const fixture = createFixture()
  const sessions = createWorkerSessions({ ctx: fixture.ctx })
  assert.equal(sessions.isWorkerSession('worker-1'), false)

  const sessionId = await sessions.spawn({
    name: 'w',
    initialMessage: 'x',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })
  assert.equal(sessions.isWorkerSession(sessionId), true)
})

test('登记表收编的历史会话也算 worker', () => {
  const fixture = createFixture()
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  // 进程启动时按落盘登记表灌入：这些会话不在内存里，工具面也要当 worker 裁剪。
  sessions.adopt('session-from-last-run')
  assert.equal(sessions.isWorkerSession('session-from-last-run'), true)
  assert.equal(sessions.get('session-from-last-run'), undefined)
})

test('活着时续聊直接投到当前会话，不算冷恢复', async () => {
  const fixture = createFixture()
  const sessions = createWorkerSessions({ ctx: fixture.ctx })
  const sessionId = await sessions.spawn({
    name: 'w',
    initialMessage: '首轮',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })

  const form = await sessions.send({
    sessionId,
    text: '续聊',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })

  assert.equal(form, 'live')
  assert.deepEqual(fixture.resumed, [])
  assert.equal(fixture.created.length, 1)
  assert.equal(fixture.created[0].messages.at(-1).content[0].text, '续聊')
})

test('不在内存时续聊走冷恢复，并重新算作 worker', async () => {
  const fixture = createFixture()
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  const form = await sessions.send({
    sessionId: 'worker-from-last-run',
    text: '接着做',
    name: '新名字',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })

  assert.equal(form, 'resumed')
  assert.deepEqual(fixture.resumed, ['worker-from-last-run'])
  assert.equal(sessions.isWorkerSession('worker-from-last-run'), true)
  assert.equal(fixture.titles.at(-1).title, '新名字')
})

test('续聊不带名字时不改标题，消息署名取会话头里的标题', async () => {
  const fixture = createFixture()
  const sessions = createWorkerSessions({ ctx: fixture.ctx })
  const sessionId = await sessions.spawn({
    name: 'w',
    initialMessage: '首轮',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })

  await sessions.send({
    sessionId,
    text: '续聊',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })

  // 只有建会话那一次改名。
  assert.equal(fixture.titles.length, 1)
})

test('销毁调宿主 dispose，并从活表与 worker 集合里移除', async () => {
  const fixture = createFixture()
  const sessions = createWorkerSessions({ ctx: fixture.ctx })
  const sessionId = await sessions.spawn({
    name: 'w',
    initialMessage: 'x',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })

  assert.equal(await sessions.dispose(sessionId), true)
  assert.equal(fixture.created[0].disposed, true)
  assert.equal(sessions.get(sessionId), undefined)
  assert.equal(sessions.isWorkerSession(sessionId), false)
  // 再删一次没有可销毁的会话，但也不该报错（归档与注销项目都会走到）。
  assert.equal(await sessions.dispose(sessionId), false)
})

test('销毁全部只收在内存的会话', async () => {
  const fixture = createFixture()
  const sessions = createWorkerSessions({ ctx: fixture.ctx })
  const first = await sessions.spawn({
    name: 'a',
    initialMessage: 'x',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })
  const second = await sessions.spawn({
    name: 'b',
    initialMessage: 'y',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })
  sessions.adopt('never-in-memory')

  await sessions.disposeAll()

  assert.deepEqual(fixture.created.map((item) => item.disposed), [true, true])
  assert.equal(sessions.isWorkerSession(first), false)
  assert.equal(sessions.isWorkerSession(second), false)
  // 只在登记表里的历史会话不该被这次卸载抹掉身份。
  assert.equal(sessions.isWorkerSession('never-in-memory'), true)
})

test('缺 agents 服务时报错说清是哪个缺口', async () => {
  const fixture = createFixture({ missingAgents: true })
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  await assert.rejects(
    () => sessions.spawn({
      name: 'w',
      initialMessage: 'x',
      parentSessionId: 'c',
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.match(error.message, /agents/)
      return true
    },
  )
  await assert.rejects(
    () => sessions.send({
      sessionId: 'worker-x',
      text: 'y',
      parentSessionId: 'c',
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.match(error.message, /agents/)
      return true
    },
  )
})

test('宿主销毁失败只记日志，不改判成没销毁', async () => {
  const fixture = createFixture()
  const warnings = []
  const sessions = createWorkerSessions({ ctx: fixture.ctx, logger: (message) => warnings.push(message) })
  const sessionId = await sessions.spawn({
    name: 'w',
    initialMessage: 'x',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })
  // 会话已经在宿主那边出问题：句柄的 dispose 抛错。
  sessions.get(sessionId).dispose = async () => {
    throw new Error('ALREADY_GONE')
  }

  assert.equal(await sessions.dispose(sessionId), false)
  assert.ok(warnings.some((message) => message.includes('ALREADY_GONE')))
  // 内存里已经没有它了，工具面判定也要跟着失效。
  assert.equal(sessions.isWorkerSession(sessionId), false)
})

test('建会话失败时不留 worker 身份', async () => {
  const fixture = createFixture({ createError: new Error('NO_CAPACITY') })
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  await assert.rejects(
    () => sessions.spawn({
      name: 'w',
      initialMessage: 'x',
      parentSessionId: 'c',
      signal: new AbortController().signal,
    }),
    /NO_CAPACITY/,
  )

  // 身份先于 create 登记（`agent/created` 在 create 内部就发出），失败必须回滚，
  // 否则这个 id 会被永远判成 worker。
  assert.equal(fixture.requested.length, 1)
  assert.equal(sessions.isWorkerSession(fixture.requested[0]), false)
})

test('任务投递失败时销毁刚建好的会话，不留孤儿', async () => {
  const fixture = createFixture({ followupError: new Error('INBOX_CLOSED') })
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  await assert.rejects(
    () => sessions.spawn({
      name: 'w',
      initialMessage: 'x',
      parentSessionId: 'c',
      signal: new AbortController().signal,
    }),
    /INBOX_CLOSED/,
  )

  // 会话建起来了但没收到任务：它不在登记表、不在在飞表，协调者与名册都看不见它。
  const entry = fixture.created.at(-1)
  assert.equal(entry.disposed, true)
  assert.equal(sessions.get(entry.sessionId), undefined)
  assert.equal(sessions.isWorkerSession(entry.sessionId), false)
})

test('宿主要求忘掉已销毁的会话时只摘记录，不再调 dispose', async () => {
  const fixture = createFixture()
  const sessions = createWorkerSessions({ ctx: fixture.ctx })
  const sessionId = await sessions.spawn({
    name: 'w',
    initialMessage: 'x',
    parentSessionId: 'c',
    signal: new AbortController().signal,
  })

  sessions.forget(sessionId)

  // 宿主已经销毁过了，这里再 dispose 一次是多余动作；但活表必须摘掉，否则后续
  // 续聊会投给死会话、回执还报成功。
  assert.equal(fixture.created[0].disposed, false)
  assert.equal(sessions.get(sessionId), undefined)
  assert.equal(sessions.isWorkerSession(sessionId), true)
})

test('派出的 worker 挂进项目工作区：不挂就落在官方树的「未分组」里', async () => {
  const fixture = createFixture()
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  const sessionId = await sessions.spawn({
    name: 'w',
    initialMessage: 'x',
    parentSessionId: 'c',
    workspaceId: 'ws-1',
    signal: new AbortController().signal,
  })
  // 挂载是 fire-and-forget：派工不等它，否则宿主一次慢写就拖住整次派工。
  await new Promise((resolve) => { setTimeout(resolve, 0) })

  assert.deepEqual(fixture.attached, [{ workspaceId: 'ws-1', sessionId }])
})

test('没有工作区可挂时照常派工', async () => {
  const fixture = createFixture({ workspaceExists: false })
  const sessions = createWorkerSessions({ ctx: fixture.ctx })

  const sessionId = await sessions.spawn({
    name: 'w',
    initialMessage: 'x',
    parentSessionId: 'c',
    workspaceId: 'ws-gone',
    signal: new AbortController().signal,
  })
  await new Promise((resolve) => { setTimeout(resolve, 0) })

  assert.match(sessionId, /^worker-/)
  assert.deepEqual(fixture.attached, [])
})

test('挂载失败不拖累派工，只在日志里说明后果', async () => {
  const fixture = createFixture({ attachError: new Error('宿主拒绝挂载') })
  const lines = []
  const sessions = createWorkerSessions({ ctx: fixture.ctx, logger: (line) => lines.push(line) })

  await sessions.spawn({
    name: 'w',
    initialMessage: 'x',
    parentSessionId: 'c',
    workspaceId: 'ws-1',
    signal: new AbortController().signal,
  })
  await new Promise((resolve) => { setTimeout(resolve, 0) })

  assert.equal(lines.some((line) => line.includes('未分组')), true)
})
