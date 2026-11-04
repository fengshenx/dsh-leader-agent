import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../src/host/index.js'
import {
  LEADER_CONTEXT_FILE,
  LEADER_CONTEXT_NAME,
} from '../src/host/leader-context.js'
import { PROJECT_REMOTE_SERVICE_KEY } from '../src/shared/projects.js'

/**
 * 建一个假的服务上下文，只给装配期真正会碰到的宿主 API 面。
 *
 * `get()` 只提供 `sessions`（`agent/created` 之外唯一被读路径用到的服务）：`cwd`
 * 故意与项目目录不同，用来暴露「按会话 cwd 取手册」这类错位判据。
 *
 * @param {Map<string, string>} sessionCwds - 会话 id → 会话 cwd
 * @param {object} [extraServices] - 额外的宿主服务；`sessions` 由本夹具提供，不在这里传
 * @returns {object} 假上下文与捕获到的注册项
 */
function createFakeHost(sessionCwds, extraServices = {}) {
  const holder = {
    contexts: new Map(),
    handlers: new Map(),
    provided: new Map(),
    tools: new Map(),
  }
  const ctx = {
    skills: {
      registerProvider(factory) {
        holder.skillsProvider = factory()
      },
    },
    tools: {
      register(tool) {
        holder.tools.set(tool.name, tool)
      },
    },
    systemPrompt: {
      context(definition) {
        holder.contexts.set(definition.name, definition)
        return () => {}
      },
    },
    effect(fn) {
      fn()
      return () => {}
    },
    get(name) {
      if (name in extraServices) return extraServices[name]
      if (name !== 'sessions') return undefined
      return {
        get(sessionId) {
          const cwd = sessionCwds.get(sessionId)
          return cwd === undefined ? undefined : { header: { cwd } }
        },
      }
    },
    on(event, handler) {
      holder.handlers.set(event, handler)
      // 宿主的 `ctx.on` 一定返回 disposer：插件卸载时派工器会调用它解除订阅。
      return () => {
        holder.handlers.delete(event)
      }
    },
    provide(key, value) {
      holder.provided.set(key, value)
    },
    // 宿主的 `ctx.inject(deps, callback)` 在依赖就绪后以子上下文执行回调；依赖缺失时
    // 回调永不执行，与真实 cordis 一致。
    inject(deps, callback) {
      if (deps.every((name) => ctx.get(name) !== undefined)) callback(ctx)
      return { dispose() {} }
    },
    logger: { warn() {} },
  }
  return { ctx, holder }
}

test('装配层：手册目录只认 leader 会话的项目目录，不认会话 cwd', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-home-'))
  const projectDirectory = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-project-'))
  const sessionDirectory = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-session-'))
  const previousHome = process.env.DSH_HOME
  // cwd 故意都指向会话目录：按 cwd 取目录的错判据会读到那里。
  const { ctx, holder } = createFakeHost(new Map([
    ['session-plain', sessionDirectory],
    ['session-leader', sessionDirectory],
  ]))
  process.env.DSH_HOME = home
  try {
    await writeFile(join(projectDirectory, LEADER_CONTEXT_FILE), '项目手册正文。', 'utf8')
    await writeFile(join(sessionDirectory, LEADER_CONTEXT_FILE), '会话目录的手册不该被注入。', 'utf8')
    await mkdir(join(home, 'dsh-leader-agent'), { recursive: true })
    await writeFile(join(home, 'dsh-leader-agent', 'projects.json'), JSON.stringify({
      version: 1,
      projects: [{
        id: 'project-1',
        name: 'p1',
        directory: projectDirectory,
        leaderSessionId: 'session-leader',
      }],
    }), 'utf8')

    // 两个会话的 cwd 都落在会话目录里：错判据（按 isLeaderSession 放行、
    // 按 cwd 取目录）会读到会话目录的手册，正确判据只认项目注册表里的指针。
    apply(ctx)
    const definition = holder.contexts.get(LEADER_CONTEXT_NAME)
    assert.ok(definition, 'leader 手册上下文没有注册')
    // 索引还没重建完的那一轮：任何会话都不注入，而不是把「宽松放行」当目录判据。
    assert.equal(definition.text({ agent: { id: 'session-plain' } }), '')

    // 项目索引是异步重建的，等它就绪再断言，否则所有会话都拿不到目录。
    await holder.provided.get(PROJECT_REMOTE_SERVICE_KEY).projects.awaitIndex()

    assert.equal(definition.text({ agent: { id: 'session-plain' } }), '')
    const text = definition.text({ agent: { id: 'session-leader' } })
    assert.match(text, /项目手册正文。/)
    assert.doesNotMatch(text, /会话目录的手册不该被注入。/)
  } finally {
    holder.handlers.get('dispose')?.()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(projectDirectory, { recursive: true, force: true })
    await rm(sessionDirectory, { recursive: true, force: true })
  }
})

test('装配层：skill provider 读包内 .agents/skills', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-home-'))
  const previousHome = process.env.DSH_HOME
  const { ctx, holder } = createFakeHost(new Map())
  process.env.DSH_HOME = home
  try {
    apply(ctx)
    assert.ok(holder.skillsProvider, 'skill provider 没有注册')
    // 路径拼错时 provider 读盘失败会静默返回空候选，这条断言守的是搬迁后的真实位置。
    const names = (await holder.skillsProvider.list()).map(candidate => candidate.name).sort()
    assert.deepEqual(names, ['e2e-scenarios', 'init-leader-agent', 'leader-mode'])
  } finally {
    holder.handlers.get('dispose')?.()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

/**
 * 往隔离的 DSH_HOME 里写一份项目注册表。
 * @param {string} home - DSH_HOME
 * @param {object[]} projects - 项目记录
 * @returns {Promise<void>}
 */
async function writeProjectIndex(home, projects) {
  await mkdir(join(home, 'dsh-leader-agent'), { recursive: true })
  await writeFile(
    join(home, 'dsh-leader-agent', 'projects.json'),
    JSON.stringify({ version: 1, projects }),
    'utf8',
  )
}

test('装配层：工作区服务就绪后把项目 leader 从工作区里摘掉', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-home-'))
  const projectDirectory = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-project-'))
  const previousHome = process.env.DSH_HOME
  const detached = []
  const workspace = {
    id: 'workspace-1',
    path: projectDirectory,
    async detachSession(sessionId) {
      detached.push(sessionId)
    },
  }
  const { ctx, holder } = createFakeHost(new Map(), {
    workspaceRegistry: { list: () => [workspace], get: () => workspace },
  })
  process.env.DSH_HOME = home
  try {
    await writeProjectIndex(home, [{
      id: 'project-1',
      name: 'p1',
      directory: projectDirectory,
      leaderSessionId: 'session-leader',
    }])
    apply(ctx)
    // 迁移排在 worker 登记表读盘之后，等它跑到。
    for (let attempt = 0; attempt < 100 && detached.length === 0; attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 20) })
    }
    assert.deepEqual(detached, ['session-leader'])
  } finally {
    holder.handlers.get('dispose')?.()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(projectDirectory, { recursive: true, force: true })
  }
})

test('装配层：普通会话写卡被拒，leader 放行', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-home-'))
  const projectDirectory = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-project-'))
  const previousHome = process.env.DSH_HOME
  // 普通会话的 cwd 就在项目目录里：归属解析会认它，写卡仍要按身份拒。
  const { ctx, holder } = createFakeHost(new Map([['session-plain', projectDirectory]]))
  process.env.DSH_HOME = home
  try {
    await writeProjectIndex(home, [{
      id: 'project-1',
      name: 'p1',
      directory: projectDirectory,
      leaderSessionId: 'session-leader',
    }])
    apply(ctx)
    const service = holder.provided.get(PROJECT_REMOTE_SERVICE_KEY).projects
    assert.equal(await service.awaitIndex(), true)

    const createCard = holder.tools.get('create_card')
    assert.ok(createCard, 'create_card 没有注册')
    // 装配漏传 canWriteCards 时先红：工具工厂会当场拒绝启动，写卡闸不会静默失效。
    await assert.rejects(
      () => createCard.execute(
        { title: '普通会话的卡' },
        { agent: { id: 'session-plain' }, signal: undefined },
      ),
      /只有 leader 与 worker 能写卡/,
    )
    const created = await createCard.execute(
      { title: 'leader 的卡' },
      { agent: { id: 'session-leader' }, signal: undefined },
    )
    assert.equal(created.card.projectId, 'project-1')
  } finally {
    holder.handlers.get('dispose')?.()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(projectDirectory, { recursive: true, force: true })
  }
})

test('装配层：真实换 leader 之后，退役会话写卡被拒、新会话放行', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-home-'))
  const projectDirectory = await mkdtemp(join(tmpdir(), 'dsh-leader-agent-project-'))
  const previousHome = process.env.DSH_HOME
  const { ctx, holder } = createFakeHost(new Map([['session-old', projectDirectory]]), {
    // 换 leader 要建一条新会话；建会话的实现必须使用调用方传入的 id。
    agents: {
      async create(options) {
        return { agent: { id: options.sessionId } }
      },
    },
  })
  process.env.DSH_HOME = home
  try {
    await writeProjectIndex(home, [{
      id: 'project-1',
      name: 'p1',
      directory: projectDirectory,
      leaderSessionId: 'session-old',
    }])
    apply(ctx)
    const service = holder.provided.get(PROJECT_REMOTE_SERVICE_KEY).projects
    assert.equal(await service.awaitIndex(), true)

    const createCard = holder.tools.get('create_card')
    const updateCard = holder.tools.get('update_card')
    const created = await createCard.execute(
      { title: '换人前的卡' },
      { agent: { id: 'session-old' }, signal: undefined },
    )

    const updated = await service.replaceLeader('project-1')
    const next = updated.leaderSessionId
    assert.notEqual(next, 'session-old')
    assert.equal(service.isLeaderSession('session-old'), false)

    // 退役者手里的写入工具要到下次会话重建才收走：执行时闸必须兜住。
    await assert.rejects(
      () => createCard.execute(
        { title: '退役者建的卡' },
        { agent: { id: 'session-old' }, signal: undefined },
      ),
      /只有 leader 与 worker 能写卡/,
    )
    await assert.rejects(
      () => updateCard.execute(
        { id: created.card.id, title: '退役者改的标题' },
        { agent: { id: 'session-old' }, signal: undefined },
      ),
      /只有 leader 与 worker 能写卡/,
    )
    const after = await updateCard.execute(
      { id: created.card.id, title: '新 leader 改的标题' },
      { agent: { id: next }, signal: undefined },
    )
    assert.equal(after.card.title, '新 leader 改的标题')
  } finally {
    holder.handlers.get('dispose')?.()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(projectDirectory, { recursive: true, force: true })
  }
})
