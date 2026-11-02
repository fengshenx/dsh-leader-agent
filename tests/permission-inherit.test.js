/**
 * worker 会话继承协调者权限：沙箱模式与审批策略。
 *
 * 宿主的 `permissionPresets` 给每个新会话 pin 的是**用户默认** preset，而 worker
 * 是 `agents.create` 建的独立会话——不继承的话，协调者切过的 `danger-full-access`
 * / `never` 不会跟过来，后台 worker 的工具调用会被沙箱拒绝或卡在无人应答的审批上。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inheritPermission } from '../src/host/permission-inherit.js'

/**
 * 造一个会话假件，记录 append 到它上面的 knob 事件。
 *
 * @param {string} id - 会话 id
 * @param {object[]} appends - 全局记录表
 * @returns {object} 会话
 */
function makeSession(id, appends) {
  return {
    id,
    append(type, data) {
      appends.push({ id, type, data })
    },
  }
}

/**
 * 造上下文假件，方法面照 `engines.dsh` 下限（0.2.1-rc.2）：`sandboxPolicy` 只有
 * `resolve` / `overrideOf`，`approval` 只有 `overrideOf` 与 `config.policy`。
 *
 * @param {object} [options] - 夹具选项
 * @param {Record<string, string>} [options.sandboxOverrides] - 会话 id → 沙箱覆盖
 * @param {Record<string, string>} [options.approvalOverrides] - 会话 id → 审批覆盖
 * @param {string} [options.sandboxDefault] - 部署默认沙箱模式
 * @param {string} [options.approvalDefault] - 部署默认审批策略
 * @param {boolean} [options.missingSandbox] - 不提供 sandboxPolicy 服务
 * @param {boolean} [options.missingApproval] - 不提供 approval 服务
 * @param {boolean} [options.unpinned] - 会话没有 `permissionPresets` pin 的默认 knobs
 * @param {Error} [options.resolveError] - 让 `resolve()` 抛错
 * @returns {object} 上下文
 */
function makeCtx({
  sandboxOverrides = {},
  approvalOverrides = {},
  sandboxDefault = 'workspace-write',
  approvalDefault = 'ask',
  missingSandbox = false,
  missingApproval = false,
  unpinned = false,
  resolveError,
} = {}) {
  // 默认状态下每个会话都已被 permissionPresets pin 过默认 knobs，`overrideOf`
  // 因此返回部署默认值而不是 undefined——这是宿主上的真实读数。
  const sandboxPolicy = {
    resolve({ session }) {
      if (resolveError !== undefined) throw resolveError
      return { mode: sandboxOverrides[session.id] ?? sandboxDefault }
    },
    overrideOf: (session) => sandboxOverrides[session.id] ?? (unpinned ? undefined : sandboxDefault),
  }
  const approval = {
    config: { policy: approvalDefault },
    overrideOf: (session) => approvalOverrides[session.id] ?? (unpinned ? undefined : approvalDefault),
  }
  return {
    get(key) {
      if (key === 'sandboxPolicy' && !missingSandbox) return sandboxPolicy
      if (key === 'approval' && !missingApproval) return approval
      return undefined
    },
  }
}

test('协调者切到 danger-full-access + never 时，worker 继承这两个覆盖', () => {
  const appends = []
  const ctx = makeCtx({
    sandboxOverrides: { coordinator: 'danger-full-access' },
    approvalOverrides: { coordinator: 'never' },
  })

  const applied = inheritPermission({
    ctx,
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
  })

  assert.deepEqual(applied, ['sandbox/mode', 'approval/policy'])
  assert.deepEqual(appends, [
    // `source: 'delegation'` 是宿主给派生子会话的既有标记：这不是用户在这条会话里的选择。
    { id: 'worker', type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } },
    { id: 'worker', type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
  ])
})

test('两边权限一致时不写事件——默认值相同就不该在 worker 日志里留噪声', () => {
  const appends = []
  const ctx = makeCtx()

  const applied = inheritPermission({
    ctx,
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
  })

  assert.deepEqual(applied, [])
  assert.deepEqual(appends, [])
})

test('只有审批策略被切过时只继承那一个 knob', () => {
  const appends = []
  const ctx = makeCtx({ approvalOverrides: { coordinator: 'never' } })

  inheritPermission({
    ctx,
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
  })

  assert.deepEqual(appends.map((item) => item.type), ['approval/policy'])
})

test('组合里没有 permissionPresets（会话无 knobs）时，仍按部署默认值显式落权限', () => {
  const appends = []
  const ctx = makeCtx({ sandboxDefault: 'danger-full-access', approvalDefault: 'never', unpinned: true })

  const applied = inheritPermission({
    ctx,
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
  })

  assert.deepEqual(applied, ['sandbox/mode', 'approval/policy'])
  assert.deepEqual(appends.map((item) => item.data), [
    { mode: 'danger-full-access', source: 'delegation' },
    { policy: 'never', source: 'delegation' },
  ])
})

test('组合里没有权限旋钮时静默跳过，不影响派工', () => {
  const appends = []
  const applied = inheritPermission({
    ctx: makeCtx({ missingSandbox: true, missingApproval: true }),
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
  })

  assert.deepEqual(applied, [])
  assert.deepEqual(appends, [])
})

test('只露出一半权限服务时记日志，仍继承在的那一半', () => {
  const appends = []
  const logs = []
  const applied = inheritPermission({
    ctx: makeCtx({ missingApproval: true, sandboxOverrides: { coordinator: 'danger-full-access' } }),
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
    logger: (message) => logs.push(message),
  })

  assert.deepEqual(applied, ['sandbox/mode'])
  assert.equal(logs.length, 1)
  assert.match(logs[0], /权限服务只露出一半/)
})

test('读协调者审批策略抛错时降级为 logger，沙箱模式照旧继承', () => {
  const appends = []
  const logs = []
  const ctx = {
    get(key) {
      if (key === 'sandboxPolicy') {
        return {
          resolve: () => ({ mode: 'danger-full-access' }),
          overrideOf: () => 'workspace-write',
        }
      }
      if (key === 'approval') {
        return {
          config: { policy: 'ask' },
          overrideOf: () => {
            throw new Error('permissions are not ready')
          },
        }
      }
      return undefined
    },
  }

  const applied = inheritPermission({
    ctx,
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
    logger: (message) => logs.push(message),
  })

  assert.deepEqual(applied, ['sandbox/mode'])
  assert.equal(logs.length, 1)
  assert.match(logs[0], /permissions are not ready/)
})

test('读 worker 当前覆盖抛错时仍写入目标值', () => {
  const appends = []
  const ctx = {
    get(key) {
      if (key !== 'sandboxPolicy') return undefined
      return {
        resolve: ({ session }) => ({ mode: session.id === 'coordinator' ? 'danger-full-access' : 'workspace-write' }),
        overrideOf: () => {
          throw new Error('projection not registered')
        },
      }
    },
  }

  const applied = inheritPermission({
    ctx,
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
  })

  assert.deepEqual(applied, ['sandbox/mode'])
  assert.deepEqual(appends, [
    { id: 'worker', type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } },
  ])
})

test('写覆盖事件失败时只记日志，不抛给派工', () => {
  const logs = []
  const ctx = makeCtx({
    sandboxOverrides: { coordinator: 'danger-full-access' },
    approvalOverrides: { coordinator: 'never' },
  })
  const worker = {
    id: 'worker',
    append() {
      throw new Error('session is closed')
    },
  }

  const applied = inheritPermission({
    ctx,
    fromSession: makeSession('coordinator', []),
    toSession: worker,
    logger: (message) => logs.push(message),
  })

  assert.deepEqual(applied, [])
  assert.equal(logs.length, 2)
  assert.match(logs[0], /session is closed/)
})

test('读协调者沙箱模式抛错时降级为 logger，审批策略照旧继承', () => {
  const appends = []
  const logs = []
  const applied = inheritPermission({
    ctx: makeCtx({ resolveError: new Error('workspace root is not absolute'), approvalOverrides: { coordinator: 'never' } }),
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
    logger: (message) => logs.push(message),
  })

  assert.deepEqual(applied, ['approval/policy'])
  assert.equal(logs.length, 1)
  assert.match(logs[0], /workspace root is not absolute/)
})
