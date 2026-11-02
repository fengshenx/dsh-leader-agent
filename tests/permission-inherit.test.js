/**
 * worker 会话继承协调者权限：沙箱模式、审批策略与 `auto` 的 preset 身份。
 *
 * 宿主的 `permissionPresets` 给每个新会话 pin 的是**用户默认** preset，而 worker
 * 是 `agents.create` 建的独立会话——不继承的话，协调者切过的 `danger-full-access`
 * / `never` 不会跟过来，后台 worker 的工具调用会被沙箱拒绝或卡在无人应答的审批上。
 * `auto` 还要额外补 preset 名：它的身份不在 knob 值里，只写 knobs 会让 `derive()`
 * 落到 custom，审查门随之关闭而沙箱已经放开。
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
 * `resolve` / `overrideOf`，`approval` 只有 `overrideOf` 与 `config.policy`，
 * `permissionPresets` 只有 `current`。
 *
 * @param {object} [options] - 夹具选项
 * @param {Record<string, string>} [options.sandboxOverrides] - 会话 id → 沙箱覆盖
 * @param {Record<string, string>} [options.approvalOverrides] - 会话 id → 审批覆盖
 * @param {Record<string, string>} [options.presets] - 会话 id → 当前 preset 名
 * @param {string} [options.sandboxDefault] - 部署默认沙箱模式
 * @param {string} [options.approvalDefault] - 部署默认审批策略
 * @param {boolean} [options.missingSandbox] - 不提供 sandboxPolicy 服务
 * @param {boolean} [options.missingApproval] - 不提供 approval 服务
 * @param {boolean} [options.missingPresets] - 不提供 permissionPresets 服务
 * @param {boolean} [options.unpinned] - 会话没有 `permissionPresets` pin 的默认 knobs
 * @param {Error} [options.resolveError] - 让 `resolve()` 抛错
 * @param {Error} [options.presetError] - 让 `current()` 抛错
 * @returns {object} 上下文
 */
function makeCtx({
  sandboxOverrides = {},
  approvalOverrides = {},
  presets = {},
  sandboxDefault = 'workspace-write',
  approvalDefault = 'ask',
  missingSandbox = false,
  missingApproval = false,
  missingPresets = false,
  unpinned = false,
  resolveError,
  presetError,
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
  const permissionPresets = {
    current(session) {
      if (presetError !== undefined) throw presetError
      return presets[session.id] ?? 'workspace-write'
    },
  }
  return {
    get(key) {
      if (key === 'sandboxPolicy' && !missingSandbox) return sandboxPolicy
      if (key === 'approval' && !missingApproval) return approval
      if (key === 'permissionPresets' && !missingPresets) return permissionPresets
      return undefined
    },
  }
}

test('协调者切到 danger-full-access + never 时，worker 继承这两个覆盖', () => {
  const appends = []
  const ctx = makeCtx({
    sandboxOverrides: { coordinator: 'danger-full-access' },
    approvalOverrides: { coordinator: 'never' },
    presets: { coordinator: 'danger-full-access' },
  })

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
  })

  assert.equal(permission.sandbox, 'danger-full-access')
  assert.equal(permission.approval, 'never')
  assert.equal(permission.preset, 'danger-full-access')
  assert.deepEqual(permission.skipped, [])
  assert.deepEqual(appends, [
    // `source: 'delegation'` 是宿主给派生子会话的既有标记：这不是用户在这条会话里的选择。
    { id: 'worker', type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } },
    { id: 'worker', type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
  ])
})

test('协调者是 auto 时补写 permission/preset，否则审查门会丢', () => {
  const appends = []
  const ctx = makeCtx({
    sandboxOverrides: { coordinator: 'danger-full-access' },
    presets: { coordinator: 'auto' },
  })

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
  })

  // auto 的 bundle 是 danger-full-access + ask；approval 与 worker 的默认一致，不写。
  assert.deepEqual(appends, [
    { id: 'worker', type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } },
    // 事件形状照宿主 subagent：只有 preset 名，没有 source。
    { id: 'worker', type: 'permission/preset', data: { preset: 'auto' } },
  ])
  assert.equal(permission.preset, 'auto')
  assert.deepEqual(permission.skipped, [])
})

test('协调者是 auto 但沙箱模式没落定时不写 preset 身份，worker 留在更严的默认上', () => {
  const appends = []
  const logs = []
  const ctx = makeCtx({
    presets: { coordinator: 'auto' },
    resolveError: new Error('workspace root is not absolute'),
  })

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
    logger: (message) => logs.push(message),
  })

  // 身份与 knobs 不一致时 derive() 反推不出 auto；沙箱没写下去就更不该写身份。
  assert.deepEqual(appends, [])
  assert.equal(permission.preset, 'auto')
  assert.deepEqual(permission.skipped.map((item) => item.knob), ['sandbox', 'preset'])
})

test('读不到协调者的 preset 身份时整体放弃继承，避免把 auto 写成裸 knobs', () => {
  const appends = []
  const logs = []
  const ctx = makeCtx({
    sandboxOverrides: { coordinator: 'danger-full-access' },
    presetError: new Error('permissions session projection is not registered'),
  })

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
    logger: (message) => logs.push(message),
  })

  assert.deepEqual(appends, [])
  assert.equal(permission.sandbox, undefined)
  assert.deepEqual(permission.skipped, [
    { knob: 'preset', reason: '读不到协调者的 preset 身份，无法排除 auto，已放弃继承' },
  ])
  assert.match(logs[0], /not registered/)
})

test('两边权限一致时不写事件——默认值相同就不该在 worker 日志里留噪声', () => {
  const appends = []
  const ctx = makeCtx()

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
  })

  assert.deepEqual(appends, [])
  assert.deepEqual(permission.skipped, [])
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
  const ctx = makeCtx({
    sandboxDefault: 'danger-full-access',
    approvalDefault: 'never',
    unpinned: true,
    missingPresets: true,
  })

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
  })

  assert.equal(permission.sandbox, 'danger-full-access')
  assert.equal(permission.approval, 'never')
  assert.deepEqual(appends.map((item) => item.data), [
    { mode: 'danger-full-access', source: 'delegation' },
    { policy: 'never', source: 'delegation' },
  ])
})

test('组合里没有权限旋钮时返回 undefined，不影响派工', () => {
  const appends = []
  const permission = inheritPermission({
    ctx: makeCtx({ missingSandbox: true, missingApproval: true }),
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
  })

  assert.equal(permission, undefined)
  assert.deepEqual(appends, [])
})

test('只露出一半权限服务时记日志、把缺口交给 skipped，仍继承在的那一半', () => {
  const appends = []
  const logs = []
  const permission = inheritPermission({
    ctx: makeCtx({ missingApproval: true, sandboxOverrides: { coordinator: 'danger-full-access' } }),
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
    logger: (message) => logs.push(message),
  })

  assert.deepEqual(appends.map((item) => item.type), ['sandbox/mode'])
  assert.deepEqual(permission.skipped, [{ knob: 'approval', reason: '当前组合未启用 approval 服务' }])
  assert.match(logs[0], /权限服务只露出一半/)
})

test('读协调者审批策略抛错时降级为日志与 skipped，沙箱模式照旧继承', () => {
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

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
    logger: (message) => logs.push(message),
  })

  assert.deepEqual(appends.map((item) => item.type), ['sandbox/mode'])
  assert.deepEqual(permission.skipped, [{ knob: 'approval', reason: '读协调者的审批策略失败，worker 保持默认' }])
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

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
  })

  assert.equal(permission.sandbox, 'danger-full-access')
  assert.deepEqual(appends, [
    { id: 'worker', type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } },
  ])
})

test('写覆盖事件失败时只记日志并把缺口交给 skipped，不抛给派工', () => {
  const logs = []
  const ctx = makeCtx({
    sandboxOverrides: { coordinator: 'danger-full-access' },
    approvalOverrides: { coordinator: 'never' },
    presets: { coordinator: 'danger-full-access' },
  })
  const worker = {
    id: 'worker',
    append() {
      throw new Error('session is closed')
    },
  }

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('coordinator', []),
    toSession: worker,
    logger: (message) => logs.push(message),
  })

  assert.equal(permission.sandbox, 'danger-full-access')
  assert.deepEqual(permission.skipped.map((item) => item.knob), ['sandbox', 'approval'])
  assert.equal(logs.length, 2)
  assert.match(logs[0], /session is closed/)
})

test('读协调者沙箱模式抛错时降级为日志与 skipped，审批策略照旧继承', () => {
  const appends = []
  const logs = []
  const permission = inheritPermission({
    ctx: makeCtx({ resolveError: new Error('workspace root is not absolute'), approvalOverrides: { coordinator: 'never' } }),
    fromSession: makeSession('coordinator', appends),
    toSession: makeSession('worker', appends),
    logger: (message) => logs.push(message),
  })

  assert.deepEqual(appends.map((item) => item.type), ['approval/policy'])
  assert.deepEqual(permission.skipped, [{ knob: 'sandbox', reason: '读协调者的沙箱模式失败，worker 保持默认' }])
  assert.match(logs[0], /workspace root is not absolute/)
})
