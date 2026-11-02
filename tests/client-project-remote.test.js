import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PROJECT_REMOTE_CONTRIBUTION,
  callProjectRemote,
  mountProjectRemote,
  onProjectRemoteReady,
} from '../src/client/project-remote.js'
import {
  PROJECT_REMOTE_METHODS,
  PROJECT_REMOTE_NAMESPACE,
  PROJECT_REMOTE_SERVICE_KEY,
} from '../src/shared/projects.js'

test('客户端贡献覆盖契约里的每个方法，wire 字段名与形参名一致', () => {
  const descriptors = PROJECT_REMOTE_CONTRIBUTION.descriptors
  assert.equal(PROJECT_REMOTE_CONTRIBUTION.package, 'dsh-leader-kit')
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
  await assert.rejects(() => mountProjectRemote({ get: () => undefined }), /宿主未提供远程调用通道/)
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

  await assert.rejects(() => callProjectRemote(ctx, 'list', []), /gateway\/internal/)
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
      assert.match(error.message, /已归档/)
      return true
    },
  )
})

test('通道没挂上时报项目通道不可用', async () => {
  await assert.rejects(() => callProjectRemote({ get: () => undefined }, 'list', []), /项目通道不可用/)
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
