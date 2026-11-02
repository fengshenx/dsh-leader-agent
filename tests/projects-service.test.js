import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdir, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectStore } from '../src/host/projects/store.js'
import {
  createCoordinatorSessionWithCtx,
  createProjectService,
  isSessionAttachedToWorkspace,
} from '../src/host/projects/service.js'
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
 * 造一个假的协调者会话工厂。
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

test('没有 sessionController 时也挂 agent preset：否则协调者没有 bash / read', async () => {
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

  const sessionId = await createCoordinatorSessionWithCtx(ctx, '/repo', 'session-x')
  assert.equal(sessionId, 'session-x')
  assert.equal(typeof captured.setup, 'function')
  // preset 投影同样要写，否则 resume 与 UI 都读不到这个会话跑在哪个 preset 上
  assert.equal(captured.meta.agentPreset, 'standard')
  const agentCtx = { scope: 'coordinator' }
  await captured.setup(agentCtx)
  assert.deepEqual(mounts, [agentCtx])
})

test('建项目会建协调者会话并绑定', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const service = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession: factory,
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  assert.equal(project.name, 'alpha')
  assert.equal(project.directory, workspace)
  assert.equal(project.coordinatorSessionId, factory.ids[0])
  assert.deepEqual(factory.calls, [workspace])
})

test('建协调者会话那一刻，注册表里已经有它（工具面按协调者裁）', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  // 工具面在 agent/created 里当场问 isCoordinatorSession()，那个事件在建会话内部
  // 就发出来了——这里用钩子站在同一时刻问一次。收集成数组：标量只留最后一次，
  // 工厂被多调一次也察觉不到。
  const seenAtCreation = []
  const factory = createSessionFactory({
    onCreate: (sessionId) => {
      seenAtCreation.push(service.isCoordinatorSession(sessionId))
    },
  })
  const service = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession: factory,
    sessionExists: async () => true,
  })
  // 真实进程启动时会先把注册表读回内存（此时还没有任何项目）。索引没加载时
  // isCoordinatorSession() 一律放行，那个宽松状态盖住了这里要测的时序。
  await service.loadIndex()

  await service.create({ directory: workspace, name: 'alpha' })
  assert.deepEqual(seenAtCreation, [true])
})

test('项目名缺省取目录末段', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const service = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession: createSessionFactory(),
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
    createCoordinatorSession: factory,
    sessionExists: async () => true,
  })
  // 索引未加载时 isCoordinatorSession() 一律放行，那个宽松会盖住这里要测的残留
  await service.loadIndex()

  await assert.rejects(() => service.create({ directory: workspace }), /建会话失败/)
  assert.deepEqual(await store.list(), [])
  // 预登记的占位要撤掉，否则一个没建成的会话会被一直当成协调者
  assert.equal(service.directoryOfCoordinator(factory.ids[0]), undefined)
  assert.equal(service.isCoordinatorSession(factory.ids[0]), false)
})

test('项目落盘失败时也撤掉占位，不留一个没有项目归属的协调者', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  // 会话已经建成、记录写不进去：这条路径不经过 helper 自己的 catch
  const failingStore = { ...store, insert: async () => { throw new Error('落盘失败') } }
  const service = makeService({
    store: failingStore,
    ctx: createContext(),
    createCoordinatorSession: factory,
    sessionExists: async () => true,
  })
  await service.loadIndex()

  await assert.rejects(() => service.create({ directory: workspace, name: 'alpha' }), /落盘失败/)
  assert.deepEqual(await store.list(), [])
  assert.equal(service.directoryOfCoordinator(factory.ids[0]), undefined)
  assert.equal(service.isCoordinatorSession(factory.ids[0]), false)
})

test('建会话的实现没按契约用传入 id 时当场失败', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  // 占位登记在预生成的 id 上，替身却建了别的会话：工具面已经按普通会话裁过一轮，
  // 继续下去只会留一个用不了的协调者
  let wanted
  const createCoordinatorSession = async (directory, sessionId) => {
    wanted = sessionId
    return 'session-someone-else'
  }
  const service = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession,
    sessionExists: async () => true,
  })
  await service.loadIndex()

  await assert.rejects(
    () => service.create({ directory: workspace, name: 'alpha' }),
    /建会话的实现必须使用传入的 id/,
  )
  assert.deepEqual(await store.list(), [])
  // 预生成 id 的占位也要撤掉，不能留一个「协调者身份指向不存在的会话」的条目
  assert.equal(service.isCoordinatorSession(wanted), false)
  assert.equal(service.directoryOfCoordinator(wanted), undefined)
})

test('换协调者时改绑失败也撤掉占位，旧协调者身份不变', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  // update 只在改绑时被调用（ctx 没有工作区服务，建项目阶段不会碰它）
  const failingStore = { ...store, update: async () => { throw new Error('改绑失败') } }
  const service = makeService({
    store: failingStore,
    ctx: createContext(),
    createCoordinatorSession: factory,
    sessionExists: async () => true,
  })
  await service.loadIndex()
  const project = await service.create({ directory: workspace, name: 'alpha' })

  await assert.rejects(() => service.replaceCoordinator(project.id), /改绑失败/)
  assert.equal(service.directoryOfCoordinator(factory.ids[0]), workspace)
  assert.equal(service.directoryOfCoordinator(factory.ids[1]), undefined)
  assert.equal((await store.get(project.id)).coordinatorSessionId, factory.ids[0])
})

test('换新协调者时，新会话在建立那一刻也已经登记', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const seen = []
  const factory = createSessionFactory({
    onCreate: (sessionId) => {
      seen.push(service.directoryOfCoordinator(sessionId))
    },
  })
  const service = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession: factory,
    sessionExists: async () => true,
  })
  await service.loadIndex()
  const project = await service.create({ directory: workspace, name: 'alpha' })
  await service.replaceCoordinator(project.id)

  assert.deepEqual(seen, [workspace, workspace])
})

test('并发换协调者：落选的新会话进退役列表，不留能派工的孤儿', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const service = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession: factory,
    sessionExists: async () => true,
  })
  await service.loadIndex()
  const project = await service.create({ directory: workspace, name: 'alpha' })

  // 两个 tab 各点一次「换新协调者」：两次调用各读同一份快照、各建一个会话。
  await Promise.all([
    service.replaceCoordinator(project.id),
    service.replaceCoordinator(project.id),
  ])

  const stored = await store.get(project.id)
  const current = stored.coordinatorSessionId
  const retired = stored.retiredCoordinatorSessionIds ?? []
  assert.equal(factory.ids.length, 3)
  // 每条建出来的会话都有明确去处：要么是当前协调者，要么在退役列表里
  for (const sessionId of factory.ids) {
    assert.ok(
      sessionId === current || retired.includes(sessionId),
      `${sessionId} 既不是当前协调者，也不在退役列表里`,
    )
  }
  // 索引与落盘记录一致：只有当前协调者还能派工、还会被注入协调者手册
  for (const sessionId of factory.ids) {
    assert.equal(service.isCoordinatorSession(sessionId), sessionId === current)
    assert.equal(service.directoryOfCoordinator(sessionId), sessionId === current ? workspace : undefined)
  }
})

test('并发换协调者：索引对齐落盘记录，不依赖两次写入的完成顺序', async () => {
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
    createCoordinatorSession: factory,
    sessionExists: async () => true,
  })
  await service.loadIndex()
  const project = await service.create({ directory: workspace, name: 'alpha' })

  await Promise.all([
    service.replaceCoordinator(project.id),
    service.replaceCoordinator(project.id),
  ])

  const recorded = await base.get(project.id)
  assert.equal(factory.ids.length, 3)
  // 索引只认落盘的那个协调者：晚到的同步不能把已被退役的会话写回索引
  for (const sessionId of factory.ids) {
    assert.equal(
      service.isCoordinatorSession(sessionId),
      sessionId === recorded.coordinatorSessionId,
      `${sessionId} 与落盘记录 ${recorded.coordinatorSessionId} 不一致`,
    )
  }
})

test('换协调者成功后触发接管，改绑失败时不触发', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const changes = []
  const service = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
    onCoordinatorReplaced: async (change) => { changes.push(change) },
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })
  // 建项目不是换人，接管不该跑
  assert.deepEqual(changes, [])
  await service.replaceCoordinator(project.id)
  // 只给项目 id：接管要按当前落盘记录算退役集与接手方，不吃调用方那次写下的值
  assert.deepEqual(changes, [{ projectId: project.id }])

  const failingStore = { ...store, update: async () => { throw new Error('改绑失败') } }
  const failingChanges = []
  const failing = makeService({
    store: failingStore,
    ctx: createContext(),
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
    onCoordinatorReplaced: async (change) => { failingChanges.push(change) },
  })
  await failing.loadIndex()
  await assert.rejects(() => failing.replaceCoordinator(project.id), /改绑失败/)
  assert.deepEqual(failingChanges, [])
})

test('目录不存在时拒绝建项目', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const service = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession: createSessionFactory(),
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
    createCoordinatorSession: createSessionFactory(),
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
    createCoordinatorSession: createSessionFactory(),
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
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  await assert.rejects(() => service.create({ directory: workspace, name: '  ' }), /项目名不能为空/)
  await assert.rejects(
    () => service.create({ directory: workspace, name: 'x'.repeat(201) }),
    /项目名过长/,
  )
})

test('列表标注协调者会话是否还在', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const service = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession: factory,
    // 只有第一个项目的协调者会话还在
    sessionExists: async (sessionId) => sessionId === factory.ids[0],
  })

  await service.create({ directory: workspace, name: 'alpha' })
  await service.create({ directory: workspace, name: 'beta' })
  const projects = await service.list()
  assert.equal(projects.length, 2)
  assert.equal(projects[0].coordinatorAlive, true)
  assert.equal(projects[1].coordinatorAlive, false)
})

test('归档的协调者会话按失效处理', async () => {
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
    createCoordinatorSession: factory,
    sessionExists: async () => true,
  })

  const created = await service.create({ directory: workspace, name: 'alpha' })
  assert.equal(created.coordinatorSessionId, factory.ids[0])
  const projects = await service.list()
  assert.equal(projects[0].coordinatorAlive, false)
  const resolved = await service.resolveProjectOfSession(factory.ids[0])
  assert.equal(resolved.coordinatorAlive, false)
})

test('协调者索引在增删改后保持同步', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const service = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession: factory,
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  assert.equal(service.directoryOfCoordinator(factory.ids[0]), workspace)

  await service.replaceCoordinator(project.id)
  assert.equal(service.directoryOfCoordinator(factory.ids[0]), undefined)
  assert.equal(service.directoryOfCoordinator(factory.ids[1]), workspace)

  await service.remove(project.id)
  assert.equal(service.directoryOfCoordinator(factory.ids[1]), undefined)
})

test('重启后从注册表重建协调者索引', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const first = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession: factory,
    sessionExists: async () => true,
  })
  await first.create({ directory: workspace, name: 'alpha' })

  const second = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  await second.loadIndex()
  assert.equal(second.directoryOfCoordinator(factory.ids[0]), workspace)
})

test('换新协调者会改绑，旧会话不再指向项目', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const service = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession: factory,
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  const updated = await service.replaceCoordinator(project.id)
  assert.equal(updated.coordinatorSessionId, factory.ids[1])
  assert.equal(await service.getByCoordinator(factory.ids[0]), undefined)
  assert.equal((await service.getByCoordinator(factory.ids[1])).id, project.id)
})

test('删除项目一并移除插件注册的工作区，协调者会话保留', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const registry = createWorkspaceRegistry()
  const factory = createSessionFactory()
  const service = makeService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
    createCoordinatorSession: factory,
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  assert.equal(registry.list().length, 1)
  const result = await service.remove(project.id)
  assert.equal(result.project.coordinatorSessionId, factory.ids[0])
  assert.deepEqual(result.workspace, { removed: true })
  assert.equal(registry.list().length, 0)
  assert.deepEqual(await service.list(), [])
})

test('删除项目不碰复用的用户工作区', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const userWorkspace = {
    id: 'ws-user',
    path: await realpath(workspace),
    title: '我自己的工作区',
    sessionIds: [],
    attachSession: async () => {},
  }
  const registry = createWorkspaceRegistry({ workspaces: [userWorkspace] })
  const service = makeService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  const result = await service.remove(project.id)
  // 复用的用户工作区不在项目记录里，删除时没有东西可摘：是 skipped，不是失败。
  assert.deepEqual(result.workspace, { removed: false, skipped: true })
  assert.equal(registry.list().length, 1)
  assert.deepEqual(await service.list(), [])
})

test('宿主没有工作区服务时删项目：工作区跳过，不当成失败', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const service = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  const result = await service.remove(project.id)
  assert.deepEqual(result.workspace, { removed: false, skipped: true })
  assert.deepEqual(await service.list(), [])
})

test('记录里的工作区已不在宿主里：跳过并清掉悬空归属', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const service = makeService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? createWorkspaceRegistry() : undefined) },
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  await store.update(project.id, { workspaceId: 'ws-gone' })
  assert.deepEqual(await service.removeWorkspace(project.id), { removed: false, skipped: true })
  // 悬空归属顺手清掉，不再挡住下次注册。
  assert.equal((await service.get(project.id)).workspaceId, undefined)
})

test('宿主工作区服务不支持删除：项目照删，原因带回', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const registry = createWorkspaceRegistry()
  delete registry.delete
  const service = makeService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  const result = await service.remove(project.id)
  assert.equal(result.workspace.removed, false)
  assert.notEqual(result.workspace.skipped, true)
  assert.match(result.workspace.reason, /不支持删除/)
  // 工作区留在宿主里，用户仍可在官方面板手动删。
  assert.equal(registry.list().length, 1)
  assert.deepEqual(await service.list(), [])
})

test('工作区在检查之后被别的调用摘掉：跳过而不是失败', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const registry = createWorkspaceRegistry()
  // 并发删同一个项目时，list 里还在、delete 时已经被另一个调用摘掉——rc.2 的
  // `delete` 对未知 id 返回 false。
  registry.delete = async () => false
  const service = makeService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  assert.deepEqual(await service.removeWorkspace(project.id), { removed: false, skipped: true })
  assert.equal((await service.get(project.id)).workspaceId, undefined)
})

test('删除不存在的项目返回 undefined', async () => {
  const { home } = await makeWorkspace()
  const service = makeService({
    store: createProjectStore({ home }),
    ctx: createContext(),
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  assert.equal(await service.remove('missing'), undefined)
})

/**
 * 造一个假的宿主工作区注册表。
 *
 * @param {object} [options] - 选项
 * @param {object[]} [options.workspaces] - 已有工作区
 * @param {string} [options.createFails] - 注册目录时的报错信息
 * @returns {object} 注册表与调用记录
 */
function createWorkspaceRegistry({ workspaces = [], createFails } = {}) {
  const created = []
  const attached = []
  const registry = {
    list: () => workspaces,
    delete: async (id) => {
      const index = workspaces.findIndex((item) => item.id === id)
      if (index === -1) return false
      workspaces.splice(index, 1)
      return true
    },
    create: async (path, title) => {
      if (createFails !== undefined) throw new Error(createFails)
      const workspace = {
        id: `ws-${created.length + 1}`,
        path,
        title,
        sessionIds: [],
        setTitle: async (next) => {
          workspace.title = next
        },
        attachSession: async (sessionId) => {
          attached.push({ workspaceId: workspace.id, sessionId })
          workspace.sessionIds.push(sessionId)
        },
      }
      workspaces.push(workspace)
      created.push({ path, title })
      return workspace
    },
  }
  registry.created = created
  registry.attached = attached
  return registry
}

test('attachCoordinator 把协调者会话挂到项目目录的工作区', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const registry = createWorkspaceRegistry()
  const factory = createSessionFactory()
  const service = makeService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
    createCoordinatorSession: factory,
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  const result = await service.attachCoordinator(project.id)
  assert.equal(result.attached, true)
  assert.equal(result.workspaceId, 'ws-1')
  assert.equal(registry.created.length, 1)
  assert.equal(registry.created[0].title, join(workspace).split(/[\\/]/).pop())
  assert.deepEqual(registry.attached, [{ workspaceId: 'ws-1', sessionId: factory.ids[0] }])
})

test('attachCoordinator 复用已存在的工作区，不重复注册，也不把它算成项目的工作区', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const existing = {
    id: 'ws-existing',
    path: await realpath(workspace),
    title: '已有',
    sessionIds: [],
    attachSession: async () => {},
  }
  const registry = createWorkspaceRegistry({ workspaces: [existing] })
  const service = makeService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  const result = await service.attachCoordinator(project.id)
  assert.equal(result.attached, true)
  // 返回的是「项目自己的」工作区：复用来的工作区不在项目记录里。
  assert.equal(result.workspaceId, undefined)
  assert.equal(registry.created.length, 0)
})

test('attachCoordinator 对已挂载的会话是幂等的', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const registry = createWorkspaceRegistry()
  const service = makeService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  await service.attachCoordinator(project.id)
  await service.attachCoordinator(project.id)
  assert.equal(registry.attached.length, 1)
})

test('attachCoordinator 在宿主没有工作区服务时不报错', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const service = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  const result = await service.attachCoordinator(project.id)
  assert.equal(result.attached, false)
  assert.match(result.reason, /工作区/)
})

test('attachCoordinator 挂载失败时返回原因而不抛出', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const registry = createWorkspaceRegistry()
  registry.create = async () => ({
    id: 'ws-1',
    path: workspace,
    title: 'alpha',
    sessionIds: [],
    attachSession: async () => {
      throw new Error('会话目录与工作区不一致')
    },
  })
  const service = makeService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  const result = await service.attachCoordinator(project.id)
  assert.equal(result.attached, false)
  assert.match(result.reason, /会话目录与工作区不一致/)
})

test('项目列表标注协调者会话是否已挂到工作区', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const registry = createWorkspaceRegistry()
  const service = makeService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  assert.equal((await service.list())[0].coordinatorAttached, false)
  await service.attachCoordinator(project.id)
  assert.equal((await service.list())[0].coordinatorAttached, true)
  assert.equal((await service.get(project.id)).coordinatorAttached, true)
})

test('isSessionAttachedToWorkspace 判定会话归属', async () => {
  const registry = createWorkspaceRegistry({
    workspaces: [{ id: 'ws-1', path: '/tmp/demo', title: 'demo', sessionIds: ['session-a'] }],
  })
  const ctx = { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) }
  assert.equal(isSessionAttachedToWorkspace(ctx, 'session-a'), true)
  assert.equal(isSessionAttachedToWorkspace(ctx, 'session-b'), false)
  assert.equal(isSessionAttachedToWorkspace(createContext(), 'session-a'), false)
})

test('建协调者会话时传 workspaceId 而不是 cwd，并把 sessionId 一起传下去', async () => {
  const registry = createWorkspaceRegistry()
  const calls = []
  const ctx = {
    get: (key) => {
      if (key === 'workspaceRegistry') return registry
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
  const sessionId = await createCoordinatorSessionWithCtx(ctx, '/tmp/demo', 'session-given')
  assert.equal(sessionId, 'session-given')
  assert.deepEqual(calls, [{ workspaceId: 'ws-1', sessionId: 'session-given' }])
})

test('宿主没有工作区服务时建协调者会话退回 cwd', async () => {
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
  await createCoordinatorSessionWithCtx(ctx, '/tmp/demo', 'session-given')
  assert.deepEqual(calls, [{ cwd: '/tmp/demo', sessionId: 'session-given' }])
})

test('插件注册的工作区记进项目记录', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const registry = createWorkspaceRegistry()
  const service = makeService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  await service.attachCoordinator(project.id)
  assert.equal((await service.get(project.id)).workspaceId, 'ws-1')
})

test('复用用户自己加的工作区不记进项目记录', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const userWorkspace = {
    id: 'ws-user',
    path: await realpath(workspace),
    title: '我自己的工作区',
    sessionIds: [],
    attachSession: async () => {},
  }
  const registry = createWorkspaceRegistry({ workspaces: [userWorkspace] })
  const service = makeService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  await service.attachCoordinator(project.id)
  assert.equal((await service.get(project.id)).workspaceId, undefined)
  assert.equal(userWorkspace.title, '我自己的工作区')
})

test('项目列表带出对应的工作区 id', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const registry = createWorkspaceRegistry()
  const service = makeService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  // 建项目时注册的工作区当场就记进记录，归属不会丢。
  assert.equal((await service.list())[0].workspaceId, 'ws-1')
})

test('从宿主移除项目工作区会清掉记录', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const registry = createWorkspaceRegistry()
  const service = makeService({
    store,
    ctx: { get: (key) => (key === 'workspaceRegistry' ? registry : undefined) },
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  await service.attachCoordinator(project.id)
  const removed = await service.removeWorkspace(project.id)
  assert.equal(removed.removed, true)
  assert.equal(registry.list().length, 0)
  assert.equal((await service.get(project.id)).workspaceId, undefined)
  // 再移除一次：已经摘过了，没有东西可摘是 skipped，不是失败。
  assert.deepEqual(await service.removeWorkspace(project.id), { removed: false, skipped: true })
})

test('建项目不发起任何模型调用', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const service = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession: factory,
    sessionExists: async () => true,
  })

  const project = await service.create({ directory: workspace, name: 'alpha' })
  assert.equal(project.coordinatorSessionId, factory.ids[0])
  assert.equal((await store.list()).length, 1)
})

test('解析会话所属项目：协调者会话按注册表指针，worker 按 cwd 相同', async () => {
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
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })

  // 协调者会话：注册表里的指针
  const coordinator = await service.resolveProjectOfSession(project.coordinatorSessionId)
  assert.equal(coordinator.id, project.id)
  assert.equal(coordinator.name, 'alpha')
  assert.equal(coordinator.coordinatorAlive, true)
  // worker 会话：cwd 与项目目录相同
  const worker = await service.resolveProjectOfSession('session-worker')
  assert.equal(worker.id, project.id)
  // 目录不同的会话不归属任何项目
  assert.equal(await service.resolveProjectOfSession('session-elsewhere'), undefined)
  assert.equal(await service.resolveProjectOfSession('session-unknown'), undefined)
})

test('解析会话所属项目：协调者会话已失效时如实报告', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const service = makeService({
    store,
    ctx: createContext(),
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => false,
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })
  const resolved = await service.resolveProjectOfSession(project.coordinatorSessionId)
  assert.equal(resolved.id, project.id)
  assert.equal(resolved.coordinatorAlive, false)
})

test('解析会话所属项目：符号链接写法与项目目录相同也算同一个项目', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const link = join(home, 'link-to-workspace')
  await symlink(workspace, link)
  const sessions = { get: () => ({ header: { cwd: link } }) }
  const service = makeService({
    store,
    ctx: { get: (name) => (name === 'sessions' ? sessions : undefined) },
    createCoordinatorSession: createSessionFactory(),
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
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })
  await service.remove(project.id)
  assert.equal(await service.resolveProjectOfSession(project.coordinatorSessionId), undefined)
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
    coordinatorSessionId: 'session-restart',
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
    getByCoordinator: (sessionId) => base.getByCoordinator(sessionId),
  }
  const sessions = { get: () => ({ header: { cwd: workspace } }) }
  const service = makeService({
    store,
    ctx: { get: (name) => (name === 'sessions' ? sessions : undefined) },
    createCoordinatorSession: createSessionFactory(),
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

test('isCoordinatorSession 同步认出建项目时定下的协调者', async () => {
  const { home, workspace } = await makeWorkspace()
  const service = makeService({
    store: createProjectStore({ home }),
    ctx: createContext(),
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  await service.loadIndex()
  const project = await service.create({ directory: workspace, name: 'alpha' })
  assert.equal(service.isCoordinatorSession(project.coordinatorSessionId), true)
  assert.equal(service.isCoordinatorSession('session-other'), false)
  assert.equal(service.isCoordinatorSession(''), false)
  assert.equal(service.isCoordinatorSession(undefined), false)
})

test('isCoordinatorSession 在索引未重建时保守放行', async () => {
  const { home, workspace } = await makeWorkspace()
  const base = createProjectStore({ home })
  await base.insert({
    id: 'p-restart',
    name: '重启前建的项目',
    directory: workspace,
    coordinatorSessionId: 'session-restart',
    createdAt: 1,
    updatedAt: 1,
  })
  const service = makeService({
    store: base,
    ctx: createContext(),
    createCoordinatorSession: createSessionFactory(),
    sessionExists: async () => true,
  })
  // 还没 loadIndex：注册表里的协调者问不出来，不能判成「不是协调者」
  assert.equal(service.isCoordinatorSession('session-restart'), true)
  assert.equal(service.isCoordinatorSession('session-anyone'), true)
  await service.loadIndex()
  assert.equal(service.isCoordinatorSession('session-restart'), true)
  assert.equal(service.isCoordinatorSession('session-anyone'), false)
})
