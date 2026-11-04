import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdir, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createCanonicalizer, groupSessionsByProject } from '../src/host/projects/session-index.js'
import { createProjectStore } from '../src/host/projects/store.js'
import { createProjectService } from '../src/host/projects/service.js'
import { cleanupTempDirs, makeTempDir } from './helpers/temp-dir.js'

after(cleanupTempDirs)

/**
 * 造一套临时 home 与项目目录。
 * @returns {Promise<{ home: string, workspace: string }>} 路径
 */
async function makeWorkspace() {
  const home = await makeTempDir('dsh-leader-agent-index-')
  const workspace = await makeTempDir('dsh-leader-agent-dir-')
  return { home, workspace }
}

/**
 * 造一个按映射返回归一路径的假归一器。
 * @param {Record<string, string>} mapping - 原始路径到归一路径
 * @returns {(path: string) => Promise<string>} 归一器
 */
function createFakeCanonicalizer(mapping) {
  return async (path) => mapping[path] ?? path
}

/**
 * 造一个按调用方 id 建会话的替身。
 *
 * 与真实实现同一个契约：leader 身份在建会话之前就登记了，所以必须原样用传入的
 * id。id 记在 `ids` 里，供 `sessionQuery` 的会话列表引用。
 *
 * @returns {((directory: string, sessionId: string) => Promise<string>) & { ids: string[] }} 替身
 */
function createSessionFactory() {
  const ids = []
  const factory = async (directory, sessionId) => {
    ids.push(sessionId)
    return sessionId
  }
  factory.ids = ids
  return factory
}

test('worker 会话 cwd 等于项目目录时归属该项目', async () => {
  const grouped = await groupSessionsByProject({
    projects: [{ id: 'p1', directory: '/repo' }],
    sessions: [{ id: 's1', cwd: '/repo' }],
    canonicalize: createFakeCanonicalizer({}),
    isWorkerSession: () => true,
  })
  assert.deepEqual(grouped.get('p1'), ['s1'])
})

test('非 worker 会话不归属项目', async () => {
  // leader 会话的入口在项目行上，用户在项目目录里手动开的会话也不属于项目编排。
  const grouped = await groupSessionsByProject({
    projects: [{ id: 'p1', directory: '/repo' }],
    sessions: [
      { id: 'leader', cwd: '/repo' },
      { id: 'manual', cwd: '/repo' },
    ],
    canonicalize: createFakeCanonicalizer({}),
    isWorkerSession: () => false,
  })
  assert.equal(grouped.has('p1'), false)
})

test('同一物理目录的两种写法归到同一个项目', async () => {
  // macOS 的 /tmp 是 /private/tmp 的符号链接，两种写法指向同一目录
  const grouped = await groupSessionsByProject({
    projects: [{ id: 'p1', directory: '/tmp/demo' }],
    sessions: [
      { id: 'worker-a', cwd: '/tmp/demo' },
      { id: 'worker-b', cwd: '/private/tmp/demo' },
    ],
    canonicalize: createFakeCanonicalizer({
      '/tmp/demo': '/private/tmp/demo',
      '/private/tmp/demo': '/private/tmp/demo',
    }),
    isWorkerSession: () => true,
  })
  assert.deepEqual(grouped.get('p1'), ['worker-a', 'worker-b'])
})

test('子目录里的会话不归属项目', async () => {
  const grouped = await groupSessionsByProject({
    projects: [{ id: 'p1', directory: '/repo' }],
    sessions: [{ id: 's1', cwd: '/repo/sub' }],
    canonicalize: createFakeCanonicalizer({}),
    isWorkerSession: () => true,
  })
  assert.equal(grouped.has('p1'), false)
})

test('没有 cwd 的会话不归属任何项目', async () => {
  const grouped = await groupSessionsByProject({
    projects: [{ id: 'p1', directory: '/repo' }],
    sessions: [{ id: 's1' }],
    canonicalize: createFakeCanonicalizer({}),
    isWorkerSession: () => true,
  })
  assert.equal(grouped.has('p1'), false)
})

test('两个项目指向同一目录时先注册的那个持有会话', async () => {
  const grouped = await groupSessionsByProject({
    projects: [
      { id: 'p1', directory: '/repo' },
      { id: 'p2', directory: '/repo' },
    ],
    sessions: [{ id: 's1', cwd: '/repo' }],
    canonicalize: createFakeCanonicalizer({}),
    isWorkerSession: () => true,
  })
  assert.deepEqual(grouped.get('p1'), ['s1'])
  assert.equal(grouped.has('p2'), false)
})

test('归一器对同一路径只解析一次', async () => {
  let calls = 0
  const canonicalize = createCanonicalizer(async (path) => {
    calls += 1
    return path
  })
  await canonicalize('/repo')
  await canonicalize('/repo')
  assert.equal(calls, 1)
})

test('归一器在路径解析失败时回落原路径', async () => {
  const canonicalize = createCanonicalizer(async () => {
    throw new Error('路径不存在')
  })
  assert.equal(await canonicalize('/gone'), '/gone')
})

test('服务按项目聚合会话', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const query = {
    listSessions: async () => [
      { header: { id: factory.ids[0], cwd: workspace } },
      { header: { id: 'session-worker', cwd: workspace, origin: 'subagent' } },
      { header: { id: 'session-elsewhere', cwd: join(workspace, '..'), origin: 'subagent' } },
    ],
  }
  const service = createProjectService({
    store,
    ctx: { get: (key) => (key === 'sessionQuery' ? query : undefined) },
    createLeaderSession: factory,
    sessionExists: async () => true,
    isWorkerSession: (id) => id === 'session-worker',
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })

  const grouped = await service.sessionsByProject()
  // 保住判别力：会话没建成就拿不到 id，listSessions 里的 leader 条目会变成 undefined
  // 而被过滤掉，用例照样绿
  assert.equal(factory.ids.length, 1)
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0].projectId, project.id)
  assert.deepEqual(grouped[0].sessionIds, ['session-worker'])
})

test('服务在没有 sessionQuery 时返回空映射', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const service = createProjectService({
    store,
    ctx: { get: () => undefined },
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
    isWorkerSession: () => true,
  })
  await service.create({ directory: workspace, name: 'alpha' })
  assert.deepEqual(await service.sessionsByProject(), [])
})

test('真实符号链接目录按 realpath 归一后归属同一项目', async (t) => {
  const { home, workspace } = await makeWorkspace()
  const link = join(home, 'link-to-workspace')
  // Windows 上建目录符号链接要开发者模式或管理员权限，受限 token 下是 EPERM/EACCES；
  // 那是环境限制，不是被测逻辑失败。
  try {
    await symlink(workspace, link)
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error
    t.skip(`本机建不了目录符号链接（${error.code}），跳过 realpath 归一验证`)
    return
  }
  const canonical = await realpath(workspace)

  const store = createProjectStore({ home })
  const service = createProjectService({
    store,
    ctx: {
      get: (key) => (key === 'sessionQuery'
        ? {
            listSessions: async () => [
              { header: { id: 'via-real', cwd: canonical } },
              { header: { id: 'via-link', cwd: link } },
            ],
          }
        : undefined),
    },
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
    isWorkerSession: () => true,
  })
  const project = await service.create({ directory: link, name: 'alpha' })

  const grouped = await service.sessionsByProject()
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0].projectId, project.id)
  assert.deepEqual(grouped[0].sessionIds.sort(), ['via-link', 'via-real'])
})

test('项目目录下新建的子目录不改变归属', async () => {
  const { home, workspace } = await makeWorkspace()
  await mkdir(join(workspace, 'nested'), { recursive: true })
  const store = createProjectStore({ home })
  const service = createProjectService({
    store,
    ctx: {
      get: (key) => (key === 'sessionQuery'
        ? { listSessions: async () => [{ header: { id: 's1', cwd: join(workspace, 'nested') } }] }
        : undefined),
    },
    createLeaderSession: createSessionFactory(),
    sessionExists: async () => true,
    isWorkerSession: () => true,
  })
  await service.create({ directory: workspace, name: 'alpha' })

  assert.deepEqual(await service.sessionsByProject(), [])
})

test('给了 worker 判定时按判定收会话，不看会话头的 origin', async () => {
  // worker 现在是普通根会话，会话头没有 origin 标记，只能按登记判定。
  const grouped = await groupSessionsByProject({
    projects: [{ id: 'p1', directory: '/repo' }],
    sessions: [
      { id: 'worker-root', cwd: '/repo' },
      { id: 'subagent-legacy', cwd: '/repo', origin: 'subagent' },
    ],
    canonicalize: createFakeCanonicalizer({}),
    isWorkerSession: (id) => id === 'worker-root',
  })
  assert.deepEqual(grouped.get('p1'), ['worker-root'])
})

test('服务把 worker 判定透传给分组', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const service = createProjectService({
    store,
    ctx: {
      get: (key) => (key === 'sessionQuery'
        ? {
            listSessions: async () => [
              { header: { id: factory.ids[0], cwd: workspace } },
              { header: { id: 'worker-root', cwd: workspace } },
            ],
          }
        : undefined),
    },
    createLeaderSession: factory,
    sessionExists: async () => true,
    isWorkerSession: (id) => id === 'worker-root',
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })

  const grouped = await service.sessionsByProject()
  assert.equal(factory.ids.length, 1)
  assert.deepEqual(grouped, [{ projectId: project.id, sessionIds: ['worker-root'] }])
})

test('换下的 leader 列在项目下，与 worker 同列', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const sessions = []
  const service = createProjectService({
    store,
    ctx: {
      get: (key) => (key === 'sessionQuery'
        ? { listSessions: async () => sessions.map((id) => ({ header: { id, cwd: workspace } })) }
        : undefined),
    },
    createLeaderSession: factory,
    sessionExists: async () => true,
    isWorkerSession: (id) => id === 'worker-root',
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })
  sessions.push(factory.ids[0], 'worker-root')
  const updated = await service.replaceLeader(project.id)
  sessions.push(updated.leaderSessionId)

  const grouped = await service.sessionsByProject()
  // 当前 leader 仍不列（入口在项目行上），换下的那个跟着 worker 走
  assert.deepEqual(grouped, [{
    projectId: project.id,
    sessionIds: ['worker-root', factory.ids[0]],
  }])
})

test('连续换 leader：退役列表只增不重，当前 leader 不在其中', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  const service = createProjectService({
    store,
    ctx: { get: () => undefined },
    createLeaderSession: factory,
    sessionExists: async () => true,
    isWorkerSession: () => false,
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })
  await service.replaceLeader(project.id)
  const updated = await service.replaceLeader(project.id)

  assert.deepEqual(updated.retiredLeaderSessionIds, factory.ids.slice(0, 2))
  assert.equal(updated.leaderSessionId, factory.ids[2])
  assert.equal(updated.retiredLeaderSessionIds.includes(updated.leaderSessionId), false)
})

test('退役会话已从会话库消失时不再列出', async () => {
  const { home, workspace } = await makeWorkspace()
  const store = createProjectStore({ home })
  const factory = createSessionFactory()
  let sessions = []
  const service = createProjectService({
    store,
    ctx: {
      get: (key) => (key === 'sessionQuery'
        ? { listSessions: async () => sessions.map((id) => ({ header: { id, cwd: workspace } })) }
        : undefined),
    },
    createLeaderSession: factory,
    sessionExists: async () => true,
    isWorkerSession: () => false,
  })
  const project = await service.create({ directory: workspace, name: 'alpha' })
  const updated = await service.replaceLeader(project.id)
  // 退役那条的会话记录被宿主清掉了，只剩当前 leader
  sessions = [updated.leaderSessionId]

  assert.deepEqual(await service.sessionsByProject(), [])
})
