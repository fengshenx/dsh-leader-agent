import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createProjectRemote } from '../src/host/projects/remote.js'
import {
  PROJECT_REMOTE_METHODS,
  PROJECT_REMOTE_NAMESPACE,
  PROJECT_REMOTE_SERVICE_KEY,
} from '../src/shared/projects.js'

const DESCRIPTOR_PROPERTY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * 造一个只记录 provide 的假 Cordis 上下文。
 * @returns {{ctx: object, provided: Map<string, object>}} 上下文与登记表
 */
function fakeCtx() {
  const provided = new Map()
  return {
    provided,
    ctx: {
      provide(key, value) {
        provided.set(key, value)
        return () => provided.delete(key)
      },
    },
  }
}

/**
 * 造一个记录调用的假项目服务。
 * @returns {object} 项目服务
 */
function fakeService() {
  const calls = []
  return {
    calls,
    async list() {
      calls.push(['list'])
      return [{ id: 'p1', name: 'demo', directory: '/tmp/demo', coordinatorSessionId: 's1' }]
    },
    async create({ directory, name }) {
      calls.push(['create', directory, name])
      return { id: 'p2', name, directory, coordinatorSessionId: 's2' }
    },
    async remove(id) {
      calls.push(['remove', id])
      return {
        project: { id, name: 'gone', directory: '/tmp/gone', coordinatorSessionId: 's3' },
        workspace: { removed: true },
      }
    },
    async rename(id, name) {
      calls.push(['rename', id, name])
      return { id, name, directory: '/tmp/demo', coordinatorSessionId: 's1' }
    },
    async replaceCoordinator(id) {
      calls.push(['replaceCoordinator', id])
      return { id, name: 'demo', directory: '/tmp/demo', coordinatorSessionId: 's4' }
    },
    async reorder(id, beforeId) {
      calls.push(['reorder', id, beforeId])
    },
    async attachCoordinator(id) {
      calls.push(['attachCoordinator', id])
      return { attached: true, workspaceId: 'w1' }
    },
    async sessionsByProject() {
      calls.push(['sessionsByProject'])
      return [{ projectId: 'p1', sessionIds: ['s1', 's5'] }]
    },
    async resolveProjectOfSession(sessionId) {
      calls.push(['resolveProjectOfSession', sessionId])
      return { id: 'p1', name: 'demo', directory: '/tmp/demo' }
    },
  }
}

/**
 * 造一个记录调用的假卡片存储。
 * @returns {object} 卡片存储
 */
function fakeCards() {
  const calls = []
  return {
    calls,
    async list(filter) {
      calls.push(['list', filter])
      return [{ id: 'c1', number: 1, title: '任务' }]
    },
    async detachSession(sessionId) {
      calls.push(['detachSession', sessionId])
      return { cards: ['c1'], slots: 1 }
    },
    async update(input) {
      calls.push(['update', input])
      return { id: input.id, number: 1, title: '任务', revision: 2, links: input.links }
    },
  }
}

/**
 * 造一个记录调用的假 worker 登记表。
 * @returns {object} 登记表
 */
function fakeWorkers() {
  const calls = []
  return {
    calls,
    async remove(childId) {
      calls.push(['remove', childId])
      return true
    },
  }
}

test('远程服务注册进 Cordis，服务键与命名空间对齐契约', () => {
  const { ctx, provided } = fakeCtx()
  const remote = createProjectRemote({ service: fakeService(), cards: fakeCards(), workers: fakeWorkers(), ctx })

  assert.equal(provided.get(PROJECT_REMOTE_SERVICE_KEY), remote)
  assert.equal(remote.typertRemote.serviceKey, PROJECT_REMOTE_SERVICE_KEY)
  assert.equal(remote.typertRemote.namespace, PROJECT_REMOTE_NAMESPACE)
  // 绑定里的 service 必须指向服务实例本身：宿主拿它与调用时取到的实例比对。
  assert.equal(remote.typertRemote.service, remote)
})

test('漏传卡片库或登记表时装配直接报错，不等到归档才炸', () => {
  const { ctx } = fakeCtx()
  assert.throws(
    () => createProjectRemote({ service: fakeService(), workers: fakeWorkers(), ctx }),
    /cards/,
  )
  assert.throws(
    () => createProjectRemote({ service: fakeService(), cards: fakeCards(), ctx }),
    /workers/,
  )
})

test('原型上的方法标记覆盖契约里的每个方法', () => {
  const { ctx } = fakeCtx()
  const remote = createProjectRemote({ service: fakeService(), cards: fakeCards(), workers: fakeWorkers(), ctx })
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(remote),
    DESCRIPTOR_PROPERTY,
  ).value

  assert.equal(descriptor.version, 1)
  assert.deepEqual(
    descriptor.methods.map((marker) => marker.method),
    Object.keys(PROJECT_REMOTE_METHODS),
  )
  for (const marker of descriptor.methods) {
    assert.deepEqual(marker.invocation, { kind: 'direct' })
  }
})

test('方法的形参名与契约一致——宿主按源码里的形参名建 wire 字段', () => {
  const { ctx } = fakeCtx()
  const remote = createProjectRemote({ service: fakeService(), cards: fakeCards(), workers: fakeWorkers(), ctx })

  for (const [method, expected] of Object.entries(PROJECT_REMOTE_METHODS)) {
    const source = Function.prototype.toString.call(remote[method])
    const open = source.indexOf('(')
    const close = source.indexOf(')', open + 1)
    const names = source.slice(open + 1, close).split(',').map((part) => part.trim()).filter(Boolean)
    assert.deepEqual(names, Object.keys(expected), `${method} 的形参名与契约不一致`)
  }
})

test('方法把调用转给项目服务', async () => {
  const { ctx } = fakeCtx()
  const service = fakeService()
  const cards = fakeCards()
  const workers = fakeWorkers()
  const remote = createProjectRemote({ service, cards, workers, ctx })

  assert.deepEqual(await remote.list(), [
    { id: 'p1', name: 'demo', directory: '/tmp/demo', coordinatorSessionId: 's1' },
  ])
  assert.deepEqual(await remote.create('/tmp/x', 'x'), {
    id: 'p2', name: 'x', directory: '/tmp/x', coordinatorSessionId: 's2',
  })
  assert.deepEqual(await remote.rename('p1', '新名'), {
    id: 'p1', name: '新名', directory: '/tmp/demo', coordinatorSessionId: 's1',
  })
  assert.deepEqual(await remote.replaceCoordinator('p1'), {
    id: 'p1', name: 'demo', directory: '/tmp/demo', coordinatorSessionId: 's4',
  })
  // 拖拽改序与「把协调者会话挂到项目工作区」都是纯转发，返回值形态一并守住
  await remote.reorder('p1', 'p2')
  assert.deepEqual(service.calls.at(-1), ['reorder', 'p1', 'p2'])
  assert.deepEqual(await remote.attachCoordinator('p1'), { attached: true, workspaceId: 'w1' })
  assert.deepEqual(service.calls.at(-1), ['attachCoordinator', 'p1'])
  assert.deepEqual(await remote.sessionsByProject(), [
    { projectId: 'p1', sessionIds: ['s1', 's5'] },
  ])
  assert.deepEqual(await remote.deleteProject('p1'), { removed: true, workspaceRemoved: true })
  assert.deepEqual(service.calls.at(-1), ['remove', 'p1'])
  // 看板取数走卡片存储，按项目过滤
  assert.deepEqual(await remote.boardCards('p1'), [{ id: 'c1', number: 1, title: '任务' }])
  assert.deepEqual(cards.calls.at(-1), ['list', { projectId: 'p1' }])
  // 会话归属项目由项目服务判定
  assert.deepEqual(await remote.resolveProject('s1'), { id: 'p1', name: 'demo', directory: '/tmp/demo' })
  assert.deepEqual(service.calls.at(-1), ['resolveProjectOfSession', 's1'])
  // 归档后的收尾：摘卡 + 摘派工登记，两处都要走到
  assert.deepEqual(await remote.detachSession('s5'), { cards: ['c1'], slots: 1, worker: true, disposed: false })
  assert.deepEqual(cards.calls.at(-1), ['detachSession', 's5'])
  assert.deepEqual(workers.calls.at(-1), ['remove', 's5'])
})

test('项目的槽位显示名来自 SLOTS.md 的 label，未声明的槽位不下发', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-leader-kit-slots-remote-'))
  try {
    await writeFile(join(directory, 'SLOTS.md'), [
      '---',
      'slots:',
      '  dev:',
      '    label: 开发',
      '---',
      '## dev',
      '你是实现者。',
      '## audit',
      '你是审计者。',
    ].join('\n'), 'utf8')
    const { ctx } = fakeCtx()
    const service = {
      async get(id) {
        return id === 'p1' ? { id, name: 'demo', directory } : undefined
      },
    }
    const remote = createProjectRemote({ service, cards: fakeCards(), workers: fakeWorkers(), ctx })
    assert.deepEqual(await remote.projectSlots('p1'), { dev: '开发' })
    // 项目不存在时返回空字典：标签是装饰信息，取不到不让看板报错。
    assert.deepEqual(await remote.projectSlots('missing'), {})
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('删除项目带回工作区移除结果，项目不存在时明确返回未删除', async () => {
  const { ctx } = fakeCtx()
  const service = fakeService()
  const remote = createProjectRemote({ service, cards: fakeCards(), workers: fakeWorkers(), ctx })

  assert.deepEqual(await remote.deleteProject('p1'), { removed: true, workspaceRemoved: true })
  service.remove = async () => undefined
  // `notFound` 让客户端把重复删除当幂等成功收尾，而不是报「删除失败」。
  assert.deepEqual(await remote.deleteProject('p1'), {
    removed: false,
    workspaceRemoved: false,
    notFound: true,
    reason: '项目不存在。',
  })
})

test('工作区没删掉时把原因带回来，项目照样算删了', async () => {
  const { ctx } = fakeCtx()
  const service = fakeService()
  service.remove = async () => ({
    project: { id: 'p1' },
    workspace: { removed: false, reason: '当前宿主的工作区服务不支持删除。' },
  })
  const remote = createProjectRemote({ service, cards: fakeCards(), workers: fakeWorkers(), ctx })

  assert.deepEqual(await remote.deleteProject('p1'), {
    removed: true,
    workspaceRemoved: false,
    reason: '当前宿主的工作区服务不支持删除。',
  })
})

test('没有工作区可移除时报 skipped 而不是失败原因', async () => {
  const { ctx } = fakeCtx()
  const service = fakeService()
  service.remove = async () => ({
    project: { id: 'p1' },
    workspace: { removed: false, skipped: true },
  })
  const remote = createProjectRemote({ service, cards: fakeCards(), workers: fakeWorkers(), ctx })

  // 带 reason 会被客户端渲染成「工作区未移除」，把正常删除说成失败。
  assert.deepEqual(await remote.deleteProject('p1'), {
    removed: true,
    workspaceRemoved: false,
    skipped: true,
  })
})

test('归档 worker 会话时顺带销毁常驻 agent', async () => {
  const { ctx } = fakeCtx()
  const disposed = []
  const workerSessions = {
    async dispose(sessionId) {
      disposed.push(sessionId)
      return true
    },
  }
  const remote = createProjectRemote({
    service: fakeService(),
    cards: fakeCards(),
    workers: fakeWorkers(),
    workerSessions,
    ctx,
  })

  const result = await remote.detachSession('s5')

  // 归档只从列表里摘掉是不够的：常驻会话不 dispose 就还在内存里跑、还在写日志。
  assert.deepEqual(disposed, ['s5'])
  assert.equal(result.disposed, true)
})

test('改链接：trim、丢空行、补 id 后整体替换', async () => {
  const { ctx } = fakeCtx()
  const cards = fakeCards()
  const remote = createProjectRemote({ service: fakeService(), cards, workers: fakeWorkers(), ctx })

  const updated = await remote.updateCardLinks('c1', [
    { id: 'l1', label: ' PR ', url: ' https://github.com/o/r/pull/1 ', purpose: ' 交付 ' },
    { label: '   ' },
    { label: 'Issue', url: '' },
  ])

  const [input] = cards.calls.at(-1).slice(1)
  assert.equal(input.id, 'c1')
  assert.deepEqual(input.links.map((link) => link.label), ['PR', 'Issue'])
  // 已有 id 保留，新增条目由宿主补一个稳定 id
  assert.equal(input.links[0].id, 'l1')
  assert.equal(typeof input.links[1].id, 'string')
  assert.notEqual(input.links[1].id, '')
  assert.equal(input.links[0].url, 'https://github.com/o/r/pull/1')
  assert.equal(input.links[0].purpose, '交付')
  // 空 url 不落空串字段
  assert.equal('url' in input.links[1], false)
  assert.deepEqual(updated.links, input.links)
})

test('改链接把非规范 http(s) 地址归一化后落盘', async () => {
  const { ctx } = fakeCtx()
  const cards = fakeCards()
  const remote = createProjectRemote({ service: fakeService(), cards, workers: fakeWorkers(), ctx })

  await remote.updateCardLinks('c1', [
    { label: '简写', url: 'http:example.test/mr/1' },
    { label: '单斜杠', url: 'https:/example.test/mr/2' },
    { label: '换行', url: 'https://exa\nmple.test/mr/3' },
  ])

  const [input] = cards.calls.at(-1).slice(1)
  assert.deepEqual(input.links.map((link) => link.url), [
    'http://example.test/mr/1',
    'https://example.test/mr/2',
    'https://example.test/mr/3',
  ])
})

test('改链接拒绝空 id 与非 http(s) 的 URL，不碰卡片库', async () => {
  const { ctx } = fakeCtx()
  const cards = fakeCards()
  const remote = createProjectRemote({ service: fakeService(), cards, workers: fakeWorkers(), ctx })

  await assert.rejects(() => remote.updateCardLinks('', []), /id 不能为空/)
  // 浏览器侧会先拦一次，但写通道不能把客户端校验当边界：javascript: 落到
  // `<a href>` 上就是可执行的注入面。
  await assert.rejects(
    () => remote.updateCardLinks('c1', [{ label: '恶意', url: 'javascript:alert(1)' }]),
    /http\(s\) 绝对地址/,
  )
  assert.deepEqual(cards.calls, [])
})
