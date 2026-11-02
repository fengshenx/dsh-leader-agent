import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../src/host/index.js'
import {
  COORDINATOR_CONTEXT_FILE,
  COORDINATOR_CONTEXT_NAME,
} from '../src/host/coordinator-context.js'
import { PROJECT_REMOTE_SERVICE_KEY } from '../src/shared/projects.js'

/**
 * 建一个假的服务上下文，只给装配期真正会碰到的宿主 API 面。
 *
 * `get()` 只提供 `sessions`（`agent/created` 之外唯一被读路径用到的服务）：`cwd`
 * 故意与项目目录不同，用来暴露「按会话 cwd 取手册」这类错位判据。
 *
 * @param {Map<string, string>} sessionCwds - 会话 id → 会话 cwd
 * @returns {object} 假上下文与捕获到的注册项
 */
function createFakeHost(sessionCwds) {
  const holder = {
    contexts: new Map(),
    handlers: new Map(),
    provided: new Map(),
  }
  const ctx = {
    skills: {
      registerProvider(factory) {
        holder.skillsProvider = factory()
      },
    },
    tools: { register() {} },
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
    logger: { warn() {} },
  }
  return { ctx, holder }
}

test('装配层：手册目录只认协调者会话的项目目录，不认会话 cwd', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-kit-home-'))
  const projectDirectory = await mkdtemp(join(tmpdir(), 'dsh-leader-kit-project-'))
  const sessionDirectory = await mkdtemp(join(tmpdir(), 'dsh-leader-kit-session-'))
  const previousHome = process.env.DSH_HOME
  // cwd 故意都指向会话目录：按 cwd 取目录的错判据会读到那里。
  const { ctx, holder } = createFakeHost(new Map([
    ['session-plain', sessionDirectory],
    ['session-coordinator', sessionDirectory],
  ]))
  process.env.DSH_HOME = home
  try {
    await writeFile(join(projectDirectory, COORDINATOR_CONTEXT_FILE), '项目手册正文。', 'utf8')
    await writeFile(join(sessionDirectory, COORDINATOR_CONTEXT_FILE), '会话目录的手册不该被注入。', 'utf8')
    await mkdir(join(home, 'dsh-leader-kit'), { recursive: true })
    await writeFile(join(home, 'dsh-leader-kit', 'projects.json'), JSON.stringify({
      version: 1,
      projects: [{
        id: 'project-1',
        name: 'p1',
        directory: projectDirectory,
        coordinatorSessionId: 'session-coordinator',
      }],
    }), 'utf8')

    // 两个会话的 cwd 都落在会话目录里：错判据（按 isCoordinatorSession 放行、
    // 按 cwd 取目录）会读到会话目录的手册，正确判据只认项目注册表里的指针。
    apply(ctx)
    const definition = holder.contexts.get(COORDINATOR_CONTEXT_NAME)
    assert.ok(definition, '协调者手册上下文没有注册')
    // 索引还没重建完的那一轮：任何会话都不注入，而不是把「宽松放行」当目录判据。
    assert.equal(definition.text({ agent: { id: 'session-plain' } }), '')

    // 项目索引是异步重建的，等它就绪再断言，否则所有会话都拿不到目录。
    await holder.provided.get(PROJECT_REMOTE_SERVICE_KEY).projects.awaitIndex()

    assert.equal(definition.text({ agent: { id: 'session-plain' } }), '')
    const text = definition.text({ agent: { id: 'session-coordinator' } })
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
  const home = await mkdtemp(join(tmpdir(), 'dsh-leader-kit-home-'))
  const previousHome = process.env.DSH_HOME
  const { ctx, holder } = createFakeHost(new Map())
  process.env.DSH_HOME = home
  try {
    apply(ctx)
    assert.ok(holder.skillsProvider, 'skill provider 没有注册')
    // 路径拼错时 provider 读盘失败会静默返回空候选，这条断言守的是搬迁后的真实位置。
    const names = (await holder.skillsProvider.list()).map(candidate => candidate.name).sort()
    assert.deepEqual(names, ['init-project', 'leader-mode'])
  } finally {
    holder.handlers.get('dispose')?.()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
