import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PROJECT_REMOTE_CONTRIBUTION,
  callProjectRemote,
  codecFor,
  ProjectRemoteError,
  isProjectRemoteReady,
  mountProjectRemote,
  onProjectRemoteReady,
  projectRemoteErrorText,
} from '../src/client/project-remote.js'
import { translator } from './helpers/locale.js'
import {
  PROJECT_REMOTE_METHODS,
  PROJECT_REMOTE_NAMESPACE,
  PROJECT_REMOTE_SERVICE_KEY,
} from '../src/shared/projects.js'

test('客户端贡献覆盖契约里的每个方法，wire 字段名与形参名一致', () => {
  const descriptors = PROJECT_REMOTE_CONTRIBUTION.descriptors
  assert.equal(PROJECT_REMOTE_CONTRIBUTION.package, 'dsh-leader-agent')
  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.method),
    Object.keys(PROJECT_REMOTE_METHODS),
  )
  for (const descriptor of descriptors) {
    assert.equal(descriptor.namespace, PROJECT_REMOTE_NAMESPACE)
    assert.equal(descriptor.service, PROJECT_REMOTE_SERVICE_KEY)
    assert.deepEqual(descriptor.invocation, { kind: 'direct' })
    assert.deepEqual(
      descriptor.parameters.map((parameter) => parameter.wire),
      Object.keys(PROJECT_REMOTE_METHODS[descriptor.method]),
    )
  }
})

test('未知类型一律抛错，原型链键也不会静默退回某个 codec', () => {
  // 'toString' / 'valueOf' / 'constructor' 在普通对象字面量上查得到函数，
  // 那样拼错的类型名会拿一个假 codec 继续跑；表用 Object.create(null) 起才抛。
  for (const type of ['unknown', 'toString', 'valueOf', 'constructor']) {
    assert.throws(() => codecFor(type), TypeError)
  }
  assert.equal(codecFor('string').mode, 'strict')
})

test('每个入参都有严格 codec：宿主拒绝没有严格 codec 的描述符', () => {
  for (const descriptor of PROJECT_REMOTE_CONTRIBUTION.descriptors) {
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.codec.mode, 'strict')
      if (PROJECT_REMOTE_METHODS[descriptor.method][parameter.name] === 'links') {
        const links = [{ label: 'PR', url: 'https://example.com/pull/1' }]
        assert.deepEqual(parameter.codec.create().parse(links), links)
        assert.throws(() => parameter.codec.create().parse('不是数组'), /期望链接数组/)
        continue
      }
      assert.equal(parameter.codec.create().parse('值'), '值')
      assert.throws(() => parameter.codec.create().parse(1), /期望字符串/)
    }
  }
})

test('挂载把贡献交给宿主远程服务', async () => {
  const mounted = []
  const ctx = {
    get(key) {
      return key === 'remote'
        ? { $mount: async (contribution) => { mounted.push(contribution) } }
        : undefined
    },
  }

  await mountProjectRemote(ctx)
  assert.equal(mounted.length, 1)
  assert.equal(mounted[0], PROJECT_REMOTE_CONTRIBUTION)
})

test('宿主没有远程通道时报错', async () => {
  await assert.rejects(
    () => mountProjectRemote({ get: () => undefined }),
    (error) => error instanceof ProjectRemoteError && error.code === 'remote-missing',
  )
})

test('调用把成功结果原样返回', async () => {
  const ctx = {
    get(key) {
      if (key !== 'remote.projects') return undefined
      return { list: async () => ({ ok: true, value: [{ id: 'p1' }] }) }
    },
  }

  assert.deepEqual(await callProjectRemote(ctx, 'list', []), [{ id: 'p1' }])
})

test('调用把业务失败变成异常', async () => {
  const ctx = {
    get(key) {
      if (key !== 'remote.projects') return undefined
      return { list: async () => ({ ok: false, error: { code: 'gateway/internal' } }) }
    },
  }

  await assert.rejects(
    () => callProjectRemote(ctx, 'list', []),
    (error) => error instanceof ProjectRemoteError
      && error.code === 'call-failed'
      && error.method === 'list'
      && error.hostCode === 'gateway/internal'
      && error.detail === '',
  )
})

test('业务失败带上宿主给的原因，用户能照着处理', async () => {
  const ctx = {
    get(key) {
      if (key !== 'remote.projects') return undefined
      return {
        updateCardLinks: async () => ({
          ok: false,
          error: {
            code: 'gateway/internal',
            message: '卡片 c1 已归档，归档是终态，不可再改',
          },
        }),
      }
    },
  }

  await assert.rejects(
    () => callProjectRemote(ctx, 'updateCardLinks', ['c1', []]),
    (error) => {
      assert.equal(error.code, 'call-failed')
      assert.equal(error.detail, '卡片 c1 已归档，归档是终态，不可再改')
      return true
    },
  )
})

test('通道没挂上时报项目通道不可用', async () => {
  await assert.rejects(
    () => callProjectRemote({ get: () => undefined }, 'list', []),
    (error) => error instanceof ProjectRemoteError && error.code === 'namespace-missing',
  )
})

test('通道已挂好时订阅就绪事件会立刻补一次通知', async () => {
  const ctx = {
    get(key) {
      return key === 'remote'
        ? { $mount: async () => {} }
        : undefined
    },
  }
  await mountProjectRemote(ctx)

  let notified = 0
  const unsubscribe = onProjectRemoteReady(() => { notified += 1 })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(notified, 1)

  unsubscribe()
})

test('挂载成功后通道读数变为就绪', async () => {
  const ctx = {
    get(key) {
      return key === 'remote'
        ? { $mount: async () => {} }
        : undefined
    },
  }
  await mountProjectRemote(ctx)
  assert.equal(isProjectRemoteReady(), true)
})

test('通道错误按当前语言映射，宿主原因原样附在句尾', () => {
  const t = translator('en')
  assert.equal(
    projectRemoteErrorText(new ProjectRemoteError('remote-missing'), t, 'project.error.read'),
    'Project channel not ready.',
  )
  assert.equal(
    projectRemoteErrorText(new ProjectRemoteError('namespace-missing'), t, 'project.error.read'),
    'The project channel is unavailable.',
  )
  assert.equal(
    projectRemoteErrorText(
      new ProjectRemoteError('call-failed', { method: 'list', hostCode: 'gateway/internal' }),
      t,
      'project.error.read',
    ),
    'Project channel call failed: list (gateway/internal).',
  )
  assert.equal(
    projectRemoteErrorText(
      new ProjectRemoteError('call-failed', { method: 'list', hostCode: 'gateway/internal', detail: 'host detail' }),
      t,
      'project.error.read',
    ),
    'Project channel call failed: list (gateway/internal). host detail',
  )
  assert.equal(
    projectRemoteErrorText(new Error('boom'), t, 'project.error.read'),
    'Failed to read projects: boom',
  )
})
