import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectStore } from '../src/host/projects/store.js'
import {
  createLeaderSessionWithCtx,
  createProjectService,
  sessionExistsWithCtx,
} from '../src/host/projects/service.js'
import { LEADER_UNUSABLE_TOOLS, deniedToolsFor } from '../src/host/tools/gate.js'
import { cleanupTempDirs, makeTempDir } from './helpers/temp-dir.js'

after(cleanupTempDirs)

/**
 * 造一套临时 home 与项目目录。
 * @returns {Promise<{ home: string, workspace: string }>} 路径
 */
async function makeWorkspace() {
  const home = await makeTempDir('dsh-leader-kit-projects-')
  const workspace = await makeTempDir('dsh-leader-kit-work-')
  return { home, workspace }
}

/**
 * 建项目服务。
 *
 * 这个文件的用例都不关心「谁是 worker」，一律按「谁都不是」处理；会话树的分组
 * 判据由 `project-session-index.test.js` 专门覆盖。
 *
 * @param {object} options - 传给 `createProjectService` 的选项
 * @returns {object} 项目服务
 */
function makeService(options) {
  return createProjectService({ isWorkerSession: () => false, ...options })
}

/**
 * 造一个假的 Cordis 上下文。
 * @returns {object} 上下文
 */
function createContext() {
  return {
    get: () => undefined,
  }
}

/**
 * 造一个假的 leader 会话工厂。
 *
 * 与真实实现同一个契约：用调用方传入的 `sessionId` 建会话并原样返回。
 *
 * @param {object} [options] - 选项
 * @param {boolean} [options.fail] - 建会话是否失败
 * @param {(sessionId: string) => void} [options.onCreate] - 建会话时的钩子，用来观察那一刻的注册表状态
 * @returns {((directory: string, sessionId: string) => Promise<string>) & { calls: string[], ids: string[] }} 工厂与记录
 */
function createSessionFactory({ fail = false, onCreate } = {}) {
  const calls = []
  const ids = []
  const factory = async (directory, sessionId) => {
    calls.push(directory)
    ids.push(sessionId)
    onCreate?.(sessionId)
    if (fail) throw new Error('建会话失败')
    return sessionId
  }
  factory.calls = calls
  factory.ids = ids
  return factory
}

test('没有 sessionController 时也挂 agent preset：否则 leader 没有 bash / read', async () => {
  const mounts = []
  let captured
  const ctx = {
    get: (name) => {
      if (name === 'agents') {
        return {
          async create(options) {
            captured = options
            return { agent: { id: options.sessionId } }
          },
        }
      }
      if (name === 'agentPresets') {
        return {
          async resolve(id) { return { id: id ?? 'standard' } },
          async mount(agentCtx) { mounts.push(agentCtx) },
        }
      }
      return undefined
    },
  }

  const sessionId = await createLeaderSessionWithCtx(ctx, '/repo', 'session-x')
  assert.equal(sessionId, 'session-x')
  assert.equal(typeof captured.setup, 'function')
  // preset 投影同样要写，否则 resume 与 UI 都读不到这个会话跑在哪个 preset 上
  assert.equal(captured.meta.agentPreset, 'standard')
  const agentCtx = { scope: 'leader' }
  await captured.setup(agentCtx)
  assert.deepEqual(mounts, [agentCtx])
})

test('建项目会建 leader 会话并绑定', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: factory,
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  assert.equal(project.name, 'alpha')
  assert.equal(project.directory, workspace)
  assert.equal(project.leaderSessionId, factory.ids[0])
  assert.deepEqual(factory.calls, [workspace])
})

test('建 leader 会话那一刻，注册表里已经有它（工具面按 leader 裁）', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  // 工具面在 agent/created 里当场问 isLeaderSession()，那个事件在建会话内部
  // 就发出来了——这里用钩子站在同一时刻问一次。收集成数组：标量只留最后一次，
  // 工厂被多调一次也察觉不到。
  const seenAtCreation = []
  const factory = createSessionFactory({
    onCreate: (sessionId) => {
      seenAtCreation.push(service.isLeaderSession(sessionId))
    },
  })
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: factory,
    sessionExists: async () => true,
  })
  // 真实进程启动时会先把注册表读回内存（此时还没有任何项目）。索引没加载时
  // isLeaderSession() 一律放行，那个宽松状态盖住了这里要测的时序。
  await service.loadIndex()

  await service.create({ directory: workspace, name: 'alpha' })
  assert.deepEqual(seenAtCreation, [true])
})

test('旧字段名的注册表仍能恢复 leader 身份与工具面', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  await mkdir(join(home, 'dsh-leader-kit'), { recursive: true })
  await writeFile(store.file, `${JSON.stringify({
    version: 1,
    projects: [{
      id: 'project-legacy',
      name: 'alpha',
      directory: workspace,
      coordinatorSessionId: 'session-legacy',
      retiredCoordinatorSessionIds: ['session-retired'],
      createdAt: 1,
      updatedAt: 1,
    }],
  }, null, 2)}\n`, 'utf8')

  const service = makeService({ store, ctx: createContext() })
  await service.loadIndex()

  assert.equal(service.isLeaderSession('session-legacy'), true)
  assert.equal(service.directoryOfLeader('session-legacy'), workspace)
  // 退役会话是项目里的普通会话，不是现任 leader。
  assert.equal(service.isLeaderSession('session-retired'), false)

  // 身份恢复之后工具面才按 leader 裁剪：缺这一步，老 leader 会被当成普通会话，
  // 派工、发消息、写卡整条动作链都会被 deny 掉。
  const denied = deniedToolsFor({
    agent: { id: 'session-legacy' },
    isLeaderSession: (id) => service.isLeaderSession(id),
    isWorkerSession: () => false,
  })
  assert.deepEqual(denied, [...LEADER_UNUSABLE_TOOLS])
  assert.equal(denied.includes('spawn_worker'), false)
})

test('项目名缺省取目录末段', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  const project = await service.create({ directory: workspace })
  assert.equal(project.name, join(workspace).split(/[\\/]/).pop())
})

test('建会话失败时不落盘', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory({ fail: true })
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: factory,
    sessionExists: async () => true,
  })
  // 索引未加载时 isLeaderSession() 一律放行，那个宽松会盖住这里要测的残留
  await service.loadIndex()

  await assert.rejects(() => service.create({ directory: workspace }), /建会话失败/)
  assert.deepEqual(await store.list(), [])
  // 预登记的占位要撤掉，否则一个没建成的会话会被一直当成 leader
  assert.equal(service.directoryOfLeader(factory.ids[0]), undefined)
  assert.equal(service.isLeaderSession(factory.ids[0]), false)
})

test('项目落盘失败时也撤掉占位，不留一个没有项目归属的 leader', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  // 会话已经建成、记录写不进去：这条路径不经过 helper 自己的 catch
  const failingStore = { ...store, insert: async () => { throw new Error('落盘失败') } }
  const service = makeService({
    store: failingStore,
    ctx: createContext(),
    createLeaderSession: factory,
    sessionExists: async () => true,
  })
  await service.loadIndex()

  await assert.rejects(() => service.create({ directory: workspace, name: 'alpha' }), /落盘失败/)
  assert.deepEqual(await store.list(), [])
  assert.equal(service.directoryOfLeader(factory.ids[0]), undefined)
  assert.equal(service.isLeaderSession(factory.ids[0]), false)
})

test('建会话的实现没按契约用传入 id 时当场失败', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  // 占位登记在预生成的 id 上，替身却建了别的会话：工具面已经按普通会话裁过一轮，
  // 继续下去只会留一个用不了的 leader
  let wanted
  const createLeaderSession = async (directory, sessionId) => {
    wanted = sessionId
    return 'session-someone-else'
  }
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession,
    sessionExists: async () => true,
  })
  await service.loadIndex()

  await assert.rejects(
    () => service.create({ directory: workspace, name: 'alpha' }),
    /建会话的实现必须使用传入的 id/,
  )
  assert.deepEqual(await store.list(), [])
  // 预生成 id 的占位也要撤掉，不能留一个「leader 身份指向不存在的会话」的条目
  assert.equal(service.isLeaderSession(wanted), false)
  assert.equal(service.directoryOfLeader(wanted), undefined)
})

test('换 leader 时改绑失败也撤掉占位，旧 leader 身份不变', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  // update 只在改绑时被调用（ctx 没有工作区服务，建项目阶段不会碰它）
  const failingStore = { ...store, update: async () => { throw new Error('改绑失败') } }
  const service = makeService({
    store: failingStore,
    ctx: createContext(),
    createLeaderSession: factory,
    sessionExists: async () => true,
  })
  await service.loadIndex()
  const project = await service.create({ directory: workspace, name: 'alpha' })

  await assert.rejects(() => service.replaceLeader(project.id), /改绑失败/)
  assert.equal(service.directoryOfLeader(factory.ids[0]), workspace)
  assert.equal(service.directoryOfLeader(factory.ids[1]), undefined)
  assert.equal((await store.get(project.id)).leaderSessionId, factory.ids[0])
})

test('换新 leader 时，新会话在建立那一刻也已经登记', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const seen = []
  const factory = createSessionFactory({
    onCreate: (sessionId) => {
      seen.push(service.directoryOfLeader(sessionId))
    },
  })
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: factory,
    sessionExists: async () => true,
  })
  await service.loadIndex()
  const project = await service.create({ directory: workspace, name: 'alpha' })
  await service.replaceLeader(project.id)

  assert.deepEqual(seen, [workspace, workspace])
})

test('并发换 leader：落选的新会话进退役列表，不留能派工的孤儿', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: factory,
    sessionExists: async () => true,
  })
  await service.loadIndex()
  const project = await service.create({ directory: workspace, name: 'alpha' })

  // 两个 tab 各点一次「换新 leader」：两次调用各读同一份快照、各建一个会话。
  await Promise.all([
    service.replaceLeader(project.id),
    service.replaceLeader(project.id),
  ])

  const stored = await store.get(project.id)
  const current = stored.leaderSessionId
  const retired = stored.retiredLeaderSessionIds ?? []
  assert.equal(factory.ids.length, 3)
  // 每条建出来的会话都有明确去处：要么是当前 leader，要么在退役列表里
  for (const sessionId of factory.ids) {
    assert.ok(
      sessionId === current || retired.includes(sessionId),
      `${sessionId} 既不是当前 leader，也不在退役列表里`,
    )
  }
  // 索引与落盘记录一致：只有当前 leader 还能派工、还会被注入 leader 手册
  for (const sessionId of factory.ids) {
    assert.equal(service.isLeaderSession(sessionId), sessionId === current)
    assert.equal(service.directoryOfLeader(sessionId), sessionId === current ? workspace : undefined)
  }
})

test('并发换 leader：索引对齐落盘记录，不依赖两次写入的完成顺序', async () => {
  const { home, workspace } = await makeWorkspace()
  const base = createProjectStore({ home })
  // 把第一次 update 的兑现推迟到第二次之后。真实 store 是串行的，完成顺序恰好等于
  // 写入顺序；索引若按各自 update 的返回值对齐，就等于把正确性押在这个顺序上。
  let updateCalls = 0
  const store = {
    ...base,
    async update(id, updates) {
      updateCalls += 1
      const call = updateCalls
      const result = await base.update(id, updates)
      if (call === 1) await new Promise((resolve) => { setTimeout(resolve, 20) })
      return result
    },
  }
  const factory = createSessionFactory()
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: factory,
    sessionExists: async () => true,
  })
  await service.loadIndex()
  const project = await service.create({ directory: workspace, name: 'alpha' })

  await Promise.all([
    service.replaceLeader(project.id),
    service.replaceLeader(project.id),
  ])

  const recorded = await base.get(project.id)
  assert.equal(factory.ids.length, 3)
  // 索引只认落盘的那个 leader：晚到的同步不能把已被退役的会话写回索引
  for (const sessionId of factory.ids) {
    assert.equal(
      service.isLeaderSession(sessionId),
      sessionId === recorded.leaderSessionId,
      `${sessionId} 与落盘记录 ${recorded.leaderSessionId} 不一致`,
    )
  }
})

test('换 leader 成功后触发接管，改绑失败时不触发', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const changes = []
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
    onLeaderReplaced: async (change) => { changes.push(change) },
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })
  // 建项目不是换人，接管不该跑
  assert.deepEqual(changes, [])
  await service.replaceLeader(project.id)
  // 只给项目 id：接管要按当前落盘记录算退役集与接手方，不吃调用方那次写下的值
  assert.deepEqual(changes, [{ projectId: project.id }])

  const failingStore = { ...store, update: async () => { throw new Error('改绑失败') } }
  const failingChanges = []
  const failing = makeService({
    store: failingStore,
    ctx: createContext(),
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
    onLeaderReplaced: async (change) => { failingChanges.push(change) },
  })
  await failing.loadIndex()
  await assert.rejects(() => failing.replaceLeader(project.id), /改绑失败/)
  assert.deepEqual(failingChanges, [])
})

test('目录不存在时拒绝建项目', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  await assert.rejects(
    () => service.create({ directory: join(workspace, 'missing') }),
    /项目目录不存在或不可访问/,
  )
})

test('目录不是绝对路径时拒绝建项目', async () => {
  const { home } = await makeWorkspace()
  const store = createProjectStore({ home })
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  await assert.rejects(() => service.create({ directory: 'relative/path' }), /必须是绝对路径/)
})

test('目录指向文件时拒绝建项目', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  const file = join(workspace, 'file.txt')
  await mkdir(workspace, { recursive: true })
  await (await import('node:fs/promises')).writeFile(file, 'x', 'utf8')

  await assert.rejects(() => service.create({ directory: file }), /不是目录/)
})

test('项目名不能为空或过长', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  await assert.rejects(() => service.create({ directory: workspace, name: '  ' }), /项目名不能为空/)
  await assert.rejects(
    () => service.create({ directory: workspace, name: 'x'.repeat(201) }),
    /项目名过长/,
  )
})

test('列表标注 leader 会话是否还在', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: factory,
    // 只有第一个项目的 leader 会话还在
    sessionExists: async (sessionId) => sessionId === factory.ids[0],
  })

  await service.create({ directory: workspace, name: 'alpha' })
  await service.create({ directory: workspace, name: 'beta' })
  const projects = await service.list()
  assert.equal(projects.length, 2)
  assert.equal(projects[0].leaderAlive, true)
  assert.equal(projects[1].leaderAlive, false)
})

test('归档的 leader 会话按失效处理', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const service = makeService({
    store,
    // 归档只往工作区注册表里加 id，会话记录还在；存活判定不能只看会话是否存在。
    // 会话 id 由 service 预生成，所以引用替身的记录而不是写死一个。
    ctx: {
      get: (name) => (name === 'workspaceRegistry'
        ? { archivedSessionIds: factory.ids }
        : undefined),
    },
    createLeaderSession: factory,
    sessionExists: async () => true,
  })

  const created = await service.create({ directory: workspace, name: 'alpha' })
  assert.equal(created.leaderSessionId, factory.ids[0])
  const projects = await service.list()
  assert.equal(projects[0].leaderAlive, false)
  const resolved = await service.resolveProjectOfSession(factory.ids[0])
  assert.equal(resolved.leaderAlive, false)
})

test('leader 索引在增删改后保持同步', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: factory,
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  assert.equal(service.directoryOfLeader(factory.ids[0]), workspace)

  await service.replaceLeader(project.id)
  assert.equal(service.directoryOfLeader(factory.ids[0]), undefined)
  assert.equal(service.directoryOfLeader(factory.ids[1]), workspace)

  await service.remove(project.id)
  assert.equal(service.directoryOfLeader(factory.ids[1]), undefined)
})

test('重启后从注册表重建 leader 索引', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const first = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: factory,
    sessionExists: async () => true,
  })
  await first.create({ directory: workspace, name: 'alpha' })

  const second = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  await second.loadIndex()
  assert.equal(second.directoryOfLeader(factory.ids[0]), workspace)
})

test('换新 leader 会改绑，旧会话不再指向项目', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: factory,
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  const updated = await service.replaceLeader(project.id)
  assert.equal(updated.leaderSessionId, factory.ids[1])
  assert.equal(await service.getByLeader(factory.ids[0]), undefined)
  assert.equal((await service.getByLeader(factory.ids[1])).id, project.id)
})

test('换新 leader 前先确认项目目录还在', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  await rm(workspace, { recursive: true, force: true })

  await assert.rejects(() => service.replaceLeader(project.id), /项目目录不存在或不可访问/)
})

test('删除项目只删记录：目录、会话与工作区都保留', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const workspaces = [{
    id: 'ws-1',
    path: await realpath(workspace),
    title: 'alpha',
    sessionIds: [],
    detachSession: async () => {},
  }]
  const registry = { list: () => workspaces }
  const service = makeService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
    createLeaderSession: factory,
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  const result = await service.remove(project.id)
  assert.equal(result.project.leaderSessionId, factory.ids[0])
  // 项目不拥有工作区：记录删掉，用户在 dsh 里的工作区原样留着。
  assert.equal(registry.list().length, 1)
  assert.deepEqual(await service.list(), [])
  // 项目目录也没有被碰过。
  assert.equal(await realpath(workspace), await realpath(workspace))
})

test('建项目不注册工作区', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const created = []
  const registry = {
    list: () => created,
    create: async (path, title) => {
      created.push({ id: `ws-${created.length + 1}`, path, title, sessionIds: [] })
      return created.at(-1)
    },
  }
  const service = makeService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  assert.equal(created.length, 0)
  assert.equal(project.workspaceId, undefined)
})

test('启动迁移把项目会话从工作区里摘掉，用户手动开的会话不动', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  // 假件照宿主语义实现：`detachSession` 只在会话确实在账上时改记录并落盘
  // （`mutate` 遇 unchanged 不写）。幂等要钉在「第二遍零写盘」上，而不是「返回同一个数」。
  const workspaces = [{
    id: 'ws-1',
    path: await realpath(workspace),
    accounts: new Set(['session-leader', 'worker-1', 'user-opened']),
    writes: 0,
    async detachSession(sessionId) {
      if (!this.accounts.has(sessionId)) return
      this.accounts.delete(sessionId)
      this.writes += 1
    },
  }]
  const service = createProjectService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? { list: () => workspaces } : undefined) },
    createLeaderSession: factory,
    sessionExists: async () => true,
    isWorkerSession: (sessionId) => sessionId === 'worker-1',
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })
  workspaces[0].accounts = new Set([project.leaderSessionId, 'worker-1', 'user-opened'])

  assert.equal(await service.detachFromWorkspaces({ workerIds: ['worker-1'] }), 2)
  assert.equal(workspaces[0].writes, 2)
  // 幂等：第二遍不再写盘（宿主 `mutate` 遇 unchanged 不落盘），用户会话始终不动。
  assert.equal(await service.detachFromWorkspaces({ workerIds: ['worker-1'] }), 2)
  assert.equal(workspaces[0].writes, 2)
  assert.deepEqual([...workspaces[0].accounts], ['user-opened'])
})

test('启动迁移不碰用户手动分组到别的工作区的项目会话', async () => {
  const { home, workspace } = await makeWorkspace()
  const other = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const detached = { 'ws-project': [], 'ws-other': [] }
  const workspaces = [
    {
      id: 'ws-project',
      path: await realpath(workspace),
      detachSession: async (sessionId) => { detached['ws-project'].push(sessionId) },
    },
    {
      id: 'ws-other',
      path: await realpath(other.workspace),
      detachSession: async (sessionId) => { detached['ws-other'].push(sessionId) },
    },
  ]
  const service = createProjectService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? { list: () => workspaces } : undefined) },
    createLeaderSession: factory,
    sessionExists: async () => true,
    isWorkerSession: (sessionId) => sessionId === 'worker-1',
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })

  // 用户把 leader 与 worker 手动分组到另一个工作区：那是他的分组选择，迁移不该抹掉。
  assert.equal(await service.detachFromWorkspaces({ workerIds: ['worker-1'] }), 2)
  assert.deepEqual(detached['ws-project'].sort(), [project.leaderSessionId, 'worker-1'].sort())
  assert.deepEqual(detached['ws-other'], [])
})

test('迁移按 realpath 认目录：符号链接写法的工作区照样能摘净老挂载', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const detached = []
  // 宿主注册表里存的是 canonical 路径，项目记录里是用户给的原始路径；两者写法可能
  // 不同（macOS 的 /tmp 指向 /private/tmp）。判据必须归一后再比，否则老挂载漏摘。
  const workspaces = [{
    id: 'ws-1',
    path: await realpath(workspace),
    detachSession: async (sessionId) => { detached.push(sessionId) },
  }]
  const service = createProjectService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? { list: () => workspaces } : undefined) },
    createLeaderSession: factory,
    sessionExists: async () => true,
    isWorkerSession: (sessionId) => sessionId === 'worker-1',
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })

  assert.equal(await service.detachFromWorkspaces({ workerIds: ['worker-1'] }), 2)
  assert.deepEqual(detached.sort(), [project.leaderSessionId, 'worker-1'].sort())
})

test('迁移从注册表取工作区实体：list 只给 id 时也能摘', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const detached = []
  const entities = new Map([['ws-1', {
    id: 'ws-1',
    path: await realpath(workspace),
    detachSession: async (sessionId) => { detached.push(sessionId) },
  }]])
  const registry = {
    // 列表项没有 path、也没有 detachSession：实体要经 get 取。
    list: () => [{ id: 'ws-1', sessionIds: ['session-leader', 'worker-1'] }],
    get: (id) => entities.get(id),
  }
  const service = createProjectService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
    createLeaderSession: factory,
    sessionExists: async () => true,
    isWorkerSession: (sessionId) => sessionId === 'worker-1',
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })

  assert.equal(await service.detachFromWorkspaces({ workerIds: ['worker-1'] }), 2)
  assert.deepEqual(detached.sort(), [project.leaderSessionId, 'worker-1'].sort())
})

test('建项目落盘失败时撤销刚建的 leader 会话', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const disposed = []
  const service = makeService({
    store: { ...store, insert: async () => { throw new Error('写盘失败') } },
    ctx: {
      get: (key) => (key === 'agents'
        ? { get: (sessionId) => ({ dispose: async () => { disposed.push(sessionId) } }) }
        : undefined),
    },
    createLeaderSession: factory,
    sessionExists: async () => true,
  })

  await assert.rejects(() => service.create({ directory: workspace, name: 'alpha' }), /写盘失败/)
  // 会话已经建出来了却没登记成项目：不撤销就留一个孤儿 leader。
  assert.deepEqual(disposed, [factory.ids[0]])
})

test('撤销 leader 会话失败只记日志，不掩盖原始错误', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const lines = []
  const service = makeService({
    store: { ...store, insert: async () => { throw new Error('写盘失败') } },
    ctx: {
      get: (key) => (key === 'agents'
        ? { get: () => ({ dispose: async () => { throw new Error('停不掉') } }) }
        : undefined),
    },
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
    logger: (line) => lines.push(line),
  })

  await assert.rejects(() => service.create({ directory: workspace, name: 'alpha' }), /写盘失败/)
  assert.equal(lines.some((line) => line.includes('撤销 leader 会话') && line.includes('停不掉')), true)
})

test('删除不存在的项目返回 undefined', async () => {
  const { home } = await makeWorkspace()
  const service = makeService({
    store: createProjectStore({ home }),
    ctx: createContext(),
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  assert.equal(await service.remove('missing'), undefined)
})

test('建 leader 会话只传 cwd 与 sessionId，不碰工作区', async () => {
  const calls = []
  const ctx = {
    get: (key) => {
      if (key === 'sessionController') {
        return {
          create: async (options) => {
            calls.push(options)
            return { sessionId: options.sessionId }
          },
        }
      }
      return undefined
    },
  }
  const sessionId = await createLeaderSessionWithCtx(ctx, '/tmp/demo', 'session-given')
  assert.equal(sessionId, 'session-given')
  assert.deepEqual(calls, [{ cwd: '/tmp/demo', sessionId: 'session-given' }])
})

test('建项目不发起任何模型调用', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: factory,
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  assert.equal(project.leaderSessionId, factory.ids[0])
  assert.equal((await store.list()).length, 1)
})

test('解析会话所属项目：leader 会话按注册表指针，worker 按 cwd 相同', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const sessions = {
    get: (id) => ({
      'session-worker': { header: { cwd: workspace } },
      'session-elsewhere': { header: { cwd: '/somewhere/else' } },
    })[id],
  }
  const service = makeService({
    store,
    ctx: { get: (name) => (name === 'sessions' ? sessions : undefined) },
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })

  // leader 会话：注册表里的指针
  const leader = await service.resolveProjectOfSession(project.leaderSessionId)
  assert.equal(leader.id, project.id)
  assert.equal(leader.name, 'alpha')
  assert.equal(leader.leaderAlive, true)
  // worker 会话：cwd 与项目目录相同
  const worker = await service.resolveProjectOfSession('session-worker')
  assert.equal(worker.id, project.id)
  // 目录不同的会话不归属任何项目
  assert.equal(await service.resolveProjectOfSession('session-elsewhere'), undefined)
  assert.equal(await service.resolveProjectOfSession('session-unknown'), undefined)
})

test('解析会话所属项目：leader 会话已失效时如实报告', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => false,
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })
  const resolved = await service.resolveProjectOfSession(project.leaderSessionId)
  assert.equal(resolved.id, project.id)
  assert.equal(resolved.leaderAlive, false)
})

test('解析会话所属项目：符号链接写法与项目目录相同也算同一个项目', async (t) => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const link = join(home, 'link-to-workspace')
  // 同 project-session-index：Windows 上目录符号链接要特权，建不了就跳过而不是报失败。
  try {
    await symlink(workspace, link)
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error
    t.skip(`本机建不了目录符号链接（${error.code}），跳过符号链接归属验证`)
    return
  }
  const sessions = { get: () => ({ header: { cwd: link } }) }
  const service = makeService({
    store,
    ctx: { get: (name) => (name === 'sessions' ? sessions : undefined) },
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })
  const resolved = await service.resolveProjectOfSession('session-linked')
  assert.equal(resolved.id, project.id)
})

test('删项目后原会话不再归属任何项目', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const sessions = { get: () => ({ header: { cwd: workspace } }) }
  const service = makeService({
    store,
    ctx: { get: (name) => (name === 'sessions' ? sessions : undefined) },
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })
  await service.remove(project.id)
  assert.equal(await service.resolveProjectOfSession(project.leaderSessionId), undefined)
  assert.equal(await service.resolveProjectOfSession('session-worker'), undefined)
})

test('索引重建完成前判定归属：等重建，不静悄悄地丢归属', async () => {
  const { home, workspace } = await makeWorkspace()
  const base = createProjectStore({ home })
  // 先落一条项目记录，再建服务：模拟「进程重启，索引还没重建完」
  await base.insert({
    id: 'p-restart',
    name: '重启前建的项目',
    directory: workspace,
    leaderSessionId: 'session-restart',
    createdAt: 1,
    updatedAt: 1,
  })
  // 把 list 卡住：重建在飞，归属判定必须等它
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const store = {
    list: async () => { await gate; return base.list() },
    get: (id) => base.get(id),
    insert: (draft) => base.insert(draft),
    update: (id, patch) => base.update(id, patch),
    remove: (id) => base.remove(id),
    getByLeader: (sessionId) => base.getByLeader(sessionId),
  }
  const sessions = { get: () => ({ header: { cwd: workspace } }) }
  const service = makeService({
    store,
    ctx: { get: (name) => (name === 'sessions' ? sessions : undefined) },
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  // 重建在飞（不 await），同时问归属
  const rebuilding = service.loadIndex()
  const pending = service.resolveProjectOfSession('session-restart')
  release()
  await rebuilding
  const resolved = await pending
  assert.equal(resolved.id, 'p-restart')
})

test('isLeaderSession 同步认出建项目时定下的 leader', async () => {
  const { home, workspace } = await makeWorkspace()
  const service = makeService({
    store: createProjectStore({ home }),
    ctx: createContext(),
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  await service.loadIndex()
  const project = await service.create({ directory: workspace, name: 'alpha' })
  assert.equal(service.isLeaderSession(project.leaderSessionId), true)
  assert.equal(service.isLeaderSession('session-other'), false)
  assert.equal(service.isLeaderSession(''), false)
  assert.equal(service.isLeaderSession(undefined), false)
})

test('isLeaderSession 在索引未重建时保守放行', async () => {
  const { home, workspace } = await makeWorkspace()
  const base = createProjectStore({ home })
  await base.insert({
    id: 'p-restart',
    name: '重启前建的项目',
    directory: workspace,
    leaderSessionId: 'session-restart',
    createdAt: 1,
    updatedAt: 1,
  })
  const service = makeService({
    store: base,
    ctx: createContext(),
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  // 还没 loadIndex：注册表里的 leader 问不出来，不能判成「不是 leader」
  assert.equal(service.isLeaderSession('session-restart'), true)
  assert.equal(service.isLeaderSession('session-anyone'), true)
  await service.loadIndex()
  assert.equal(service.isLeaderSession('session-restart'), true)
  assert.equal(service.isLeaderSession('session-anyone'), false)
})

test('读不存在的项目返回 undefined', async () => {
  const { home } = await makeWorkspace()
  const service = makeService({
    store: createProjectStore({ home }),
    ctx: createContext(),
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  assert.equal(await service.get('missing'), undefined)
  assert.equal(await service.getByLeader('session-missing'), undefined)
})

test('改名与排序落到注册表', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const service = makeService({
    store,
    ctx: createContext(),
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  const first = await service.create({ directory: workspace, name: 'alpha' })
  const second = await service.create({ directory: workspace, name: 'beta' })

  assert.equal((await service.rename(first.id, 'gamma')).name, 'gamma')
  await service.reorder(second.id, first.id)
  assert.deepEqual((await service.list()).map((project) => project.id), [second.id, first.id])
})

test('两个项目指向同一目录：删掉一个后目录归属回到另一个', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const service = makeService({
    store,
    ctx: {
      get: (key) => (key === 'sessions'
        ? { get: (sessionId) => ({ header: { id: sessionId, cwd: workspace } }) }
        : undefined),
    },
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  const first = await service.create({ directory: workspace, name: 'alpha' })
  const second = await service.create({ directory: workspace, name: 'beta' })
  await service.remove(first.id)

  // 卡片按目录归属：剩下的那个项目要接管这个目录。
  const resolved = await service.resolveProjectOfSession('user-opened')
  assert.equal(resolved?.id, second.id)
})

test('没有可用的建会话服务时明确报错', async () => {
  const ctx = { get: () => undefined }
  await assert.rejects(
    () => createLeaderSessionWithCtx(ctx, '/tmp/demo', 'session-1'),
    /既没有 sessionController 也没有 agents 服务/,
  )
})

test('没有会话查询服务时，会话是否存在报「不知道」', async () => {
  assert.equal(await sessionExistsWithCtx({ get: () => undefined }, 'session-1'), undefined)
  assert.equal(
    await sessionExistsWithCtx({ get: () => ({ listSessions: async () => [{ header: { id: 'session-1' } }] }) }, 'session-1'),
    true,
  )
  assert.equal(
    await sessionExistsWithCtx({ get: () => ({ listSessions: async () => [] }) }, 'session-2'),
    false,
  )
})

test('没有工作区服务时迁移是空操作', async () => {
  const { home } = await makeWorkspace()
  const service = makeService({
    store: createProjectStore({ home }),
    ctx: createContext(),
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  assert.equal(await service.detachFromWorkspaces(), 0)
})

test('迁移摘除失败只记日志，不影响其余会话', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const detached = []
  const lines = []
  const workspaces = [{
    id: 'ws-1',
    path: await realpath(workspace),
    sessionIds: [],
    async detachSession(sessionId) {
      if (sessionId === 'worker-1') throw new Error('宿主拒绝')
      detached.push(sessionId)
    },
  }]
  const service = createProjectService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? { list: () => workspaces } : undefined) },
    createLeaderSession: factory,
    sessionExists: async () => true,
    isWorkerSession: (sessionId) => sessionId === 'worker-1',
    logger: (line) => lines.push(line),
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })
  workspaces[0].sessionIds = [project.leaderSessionId, 'worker-1']

  assert.equal(await service.detachFromWorkspaces({ workerIds: ['worker-1'] }), 1)
  assert.deepEqual(detached, [project.leaderSessionId])
  assert.equal(lines.some((line) => line.includes('worker-1') && line.includes('宿主拒绝')), true)
})
