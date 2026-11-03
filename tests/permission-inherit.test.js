/**
 * worker 会话继承 leader 权限：沙箱模式、审批策略与 `auto` 的 preset 身份。
 *
 * 宿主的 `permissionPresets` 给每个新会话 pin 的是**用户默认** preset，而 worker
 * 是 `agents.create` 建的独立会话——不继承的话，leader 切过的 `danger-full-access`
 * / `never` 不会跟过来，后台 worker 的工具调用会被沙箱拒绝或卡在无人应答的审批上。
 * `auto` 还要额外补 preset 名：它的身份不在 knob 值里，只写 knobs 会让 `derive()`
 * 落到 custom，审查门随之关闭而沙箱已经放开。
 *
 * 返回值描述的是**回读到的实际值**，不是继承目标：写失败或放弃继承时，目标值与
 * worker 真正跑的权限不是一回事。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inheritPermission } from '../src/host/permission-inherit.js'

/**
 * 造一个会话假件，记录 append 到它上面的 knob 事件。
 *
 * `runtime` 模拟宿主的事件折叠：写进会话的覆盖会改变该会话后续读到的有效值，
 * `inheritPermission()` 末尾回读的就是这份状态。
 *
 * @param {string} id - 会话 id
 * @param {object[]} appends - 全局记录表
 * @param {Record<string, object>} [runtime] - 会话 id → 已落盘的覆盖
 * @returns {object} 会话
 */
function makeSession(id, appends, runtime = {}) {
  return {
    id,
    append(type, data) {
      appends.push({ id, type, data })
      runtime[id] ??= {}
      if (type === 'sandbox/mode') runtime[id].sandbox = data.mode
      if (type === 'approval/policy') runtime[id].approval = data.policy
      if (type === 'permission/preset') runtime[id].preset = data.preset
    },
  }
}

/**
 * 断言回执对象里没有值为 `undefined` 的键。
 *
 * 值为 undefined 的键过不了宿主工具结果的 lossless JSON 判定
 * （`snapshotJsonValue` 返回 undefined → `ToolOutputError`），而报错发生在派工
 * 完成之后，会留下一个挂卡的孤儿 worker。
 *
 * @param {object} permission - 回执对象
 * @returns {void}
 */
function assertNoUndefinedKeys(permission) {
  for (const [key, value] of Object.entries(permission)) {
    assert.notEqual(value, undefined, `回执里的 ${key} 不能是 undefined（过不了宿主的 lossless JSON 判定）`)
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
 * @param {Record<string, object>} [options.runtime] - 会话 id → 已落盘的覆盖（读优先）
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
  runtime = {},
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
      // resolveError 只作用在 leader 身上：它模拟「读 leader 失败」，回读 worker 必须还有值。
      if (resolveError !== undefined && session.id === 'leader') throw resolveError
      return { mode: runtime[session.id]?.sandbox ?? sandboxOverrides[session.id] ?? sandboxDefault }
    },
    overrideOf: (session) => runtime[session.id]?.sandbox ?? sandboxOverrides[session.id] ?? (unpinned ? undefined : sandboxDefault),
  }
  const approval = {
    config: { policy: approvalDefault },
    overrideOf: (session) => runtime[session.id]?.approval ?? approvalOverrides[session.id] ?? (unpinned ? undefined : approvalDefault),
  }
  // 简化版 derive()：真实宿主把 knobs 折回配置表，`auto` 身份优先。夹具只需要
  // 回答「worker 现在的实际身份是什么」，回执靠它判断 auto 审查门有没有生效。
  const permissionPresets = {
    current(session) {
      if (presetError !== undefined) throw presetError
      const state = runtime[session.id] ?? {}
      if (state.preset === 'auto') return 'auto'
      if (state.sandbox === 'danger-full-access' && state.approval === 'never') return 'danger-full-access'
      if (state.sandbox === 'workspace-write' && state.approval === 'ask') return 'workspace-write'
      if (state.sandbox === undefined && state.approval === undefined) return presets[session.id] ?? 'workspace-write'
      return 'custom'
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

test('leader 切到 danger-full-access + never 时，worker 继承这两个覆盖', () => {
  const appends = []
  const runtime = {}
  const ctx = makeCtx({
    sandboxOverrides: { leader: 'danger-full-access' },
    approvalOverrides: { leader: 'never' },
    presets: { leader: 'danger-full-access' },
    runtime,
  })

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('leader', appends, runtime),
    toSession: makeSession('worker', appends, runtime),
  })

  assert.deepEqual(permission, {
    sandbox: 'danger-full-access',
    approval: 'never',
    preset: 'danger-full-access',
    skipped: [],
  })
  assert.deepEqual(appends, [
    // `source: 'delegation'` 是宿主给派生子会话的既有标记：这不是用户在这条会话里的选择。
    { id: 'worker', type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } },
    { id: 'worker', type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
  ])
})

test('leader 是 auto 时补写 permission/preset，否则审查门会丢', () => {
  const appends = []
  const runtime = {}
  const ctx = makeCtx({
    sandboxOverrides: { leader: 'danger-full-access' },
    presets: { leader: 'auto' },
    runtime,
  })

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('leader', appends, runtime),
    toSession: makeSession('worker', appends, runtime),
  })

  // auto 的 bundle 是 danger-full-access + ask；approval 与 worker 的默认一致，不写。
  assert.deepEqual(appends, [
    { id: 'worker', type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } },
    // 事件形状照宿主 subagent：只有 preset 名，没有 source。
    { id: 'worker', type: 'permission/preset', data: { preset: 'auto' } },
  ])
  assert.deepEqual(permission, {
    sandbox: 'danger-full-access',
    approval: 'ask',
    preset: 'auto',
    skipped: [],
  })
})

test('leader 是 auto 但沙箱模式没落定时不写 preset 身份，回执报实际值', () => {
  const appends = []
  const logs = []
  const runtime = {}
  const ctx = makeCtx({
    presets: { leader: 'auto' },
    resolveError: new Error('workspace root is not absolute'),
    runtime,
  })

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('leader', appends, runtime),
    toSession: makeSession('worker', appends, runtime),
    logger: (message) => logs.push(message),
  })

  // 身份与 knobs 不一致时 derive() 反推不出 auto；沙箱没写下去就更不该写身份。
  assert.deepEqual(appends, [])
  // 回执必须是 worker 的实际值（部署默认），不是 leader 的 auto bundle。
  assert.equal(permission.sandbox, 'workspace-write')
  assert.equal(permission.approval, 'ask')
  assert.equal(permission.preset, 'workspace-write')
  assert.deepEqual(permission.skipped.map((item) => item.knob), ['sandbox', 'preset'])
})

test('读不到 leader 的 preset 身份时整体放弃继承，回执仍给实际值且不带 undefined', () => {
  const appends = []
  const logs = []
  const runtime = {}
  const ctx = makeCtx({
    sandboxOverrides: { leader: 'danger-full-access' },
    presetError: new Error('permissions session projection is not registered'),
    runtime,
  })

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('leader', appends, runtime),
    toSession: makeSession('worker', appends, runtime),
    logger: (message) => logs.push(message),
  })

  assert.deepEqual(appends, [])
  // 放弃继承不等于不知道实际值：worker 停在部署默认上，回执要如实说。
  assert.equal(permission.sandbox, 'workspace-write')
  assert.equal(permission.approval, 'ask')
  assert.equal('preset' in permission, false)
  assertNoUndefinedKeys(permission)
  assert.deepEqual(permission.skipped, [
    { knob: 'preset', reason: '读不到 leader 的 preset 身份，无法排除 auto，已放弃继承' },
  ])
  assert.match(logs[0], /not registered/)
})

test('两边权限一致时不写事件——默认值相同就不该在 worker 日志里留噪声', () => {
  const appends = []
  const runtime = {}
  const ctx = makeCtx({ runtime })

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('leader', appends, runtime),
    toSession: makeSession('worker', appends, runtime),
  })

  assert.deepEqual(appends, [])
  assert.deepEqual(permission, {
    sandbox: 'workspace-write',
    approval: 'ask',
    preset: 'workspace-write',
    skipped: [],
  })
})

test('只有审批策略被切过时只继承那一个 knob', () => {
  const appends = []
  const runtime = {}
  const ctx = makeCtx({ approvalOverrides: { leader: 'never' }, runtime })

  inheritPermission({
    ctx,
    fromSession: makeSession('leader', appends, runtime),
    toSession: makeSession('worker', appends, runtime),
  })

  assert.deepEqual(appends.map((item) => item.type), ['approval/policy'])
})

test('组合里没有 permissionPresets 时仍按部署默认显式落权限，回执不带 preset 键', () => {
  const appends = []
  const runtime = {}
  const ctx = makeCtx({
    sandboxDefault: 'danger-full-access',
    approvalDefault: 'never',
    unpinned: true,
    missingPresets: true,
    runtime,
  })

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('leader', appends, runtime),
    toSession: makeSession('worker', appends, runtime),
  })

  assert.equal(permission.sandbox, 'danger-full-access')
  assert.equal(permission.approval, 'never')
  // 没有 permissionPresets 时 `preset` 的键必须缺席而不是 `undefined`：
  // 后者过不了宿主工具结果的 lossless 判定，报错发生在派工完成之后。
  assert.equal('preset' in permission, false)
  assertNoUndefinedKeys(permission)
  assert.deepEqual(appends.map((item) => item.data), [
    { mode: 'danger-full-access', source: 'delegation' },
    { policy: 'never', source: 'delegation' },
  ])
})

test('组合里没有权限旋钮时返回 undefined，不影响派工', () => {
  const appends = []
  const permission = inheritPermission({
    ctx: makeCtx({ missingSandbox: true, missingApproval: true }),
    fromSession: makeSession('leader', appends),
    toSession: makeSession('worker', appends),
  })

  assert.equal(permission, undefined)
  assert.deepEqual(appends, [])
})

test('只露出一半权限服务时记日志、把缺口交给 skipped，仍继承在的那一半', () => {
  const appends = []
  const logs = []
  const runtime = {}
  const permission = inheritPermission({
    ctx: makeCtx({ missingApproval: true, sandboxOverrides: { leader: 'danger-full-access' }, runtime }),
    fromSession: makeSession('leader', appends, runtime),
    toSession: makeSession('worker', appends, runtime),
    logger: (message) => logs.push(message),
  })

  assert.deepEqual(appends.map((item) => item.type), ['sandbox/mode'])
  assert.equal(permission.sandbox, 'danger-full-access')
  assert.equal('approval' in permission, false)
  assertNoUndefinedKeys(permission)
  assert.deepEqual(permission.skipped, [{ knob: 'approval', reason: '当前组合未启用 approval 服务' }])
  assert.match(logs[0], /权限服务只露出一半/)
})

test('读 leader 审批策略抛错时降级为日志与 skipped，沙箱模式照旧继承', () => {
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
    fromSession: makeSession('leader', appends),
    toSession: makeSession('worker', appends),
    logger: (message) => logs.push(message),
  })

  assert.deepEqual(appends.map((item) => item.type), ['sandbox/mode'])
  assert.equal(permission.sandbox, 'danger-full-access')
  assertNoUndefinedKeys(permission)
  assert.deepEqual(permission.skipped, [{ knob: 'approval', reason: '读 leader 的审批策略失败，worker 保持默认' }])
  assert.match(logs[0], /permissions are not ready/)
})

test('读 worker 当前覆盖抛错时仍写入目标值', () => {
  const appends = []
  let workerMode = 'workspace-write'
  const ctx = {
    get(key) {
      if (key !== 'sandboxPolicy') return undefined
      return {
        resolve: ({ session }) => ({ mode: session.id === 'leader' ? 'danger-full-access' : workerMode }),
        overrideOf: () => {
          throw new Error('projection not registered')
        },
      }
    },
  }
  const worker = {
    id: 'worker',
    append(type, data) {
      appends.push({ id: 'worker', type, data })
      if (type === 'sandbox/mode') workerMode = data.mode
    },
  }

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('leader', appends),
    toSession: worker,
  })

  assert.equal(permission.sandbox, 'danger-full-access')
  assert.deepEqual(appends, [
    { id: 'worker', type: 'sandbox/mode', data: { mode: 'danger-full-access', source: 'delegation' } },
  ])
})

test('写覆盖事件失败时回执报 worker 的实际值，不是继承目标', () => {
  const logs = []
  const runtime = {}
  const ctx = makeCtx({
    sandboxOverrides: { leader: 'danger-full-access' },
    approvalOverrides: { leader: 'never' },
    presets: { leader: 'danger-full-access' },
    runtime,
  })
  const worker = {
    id: 'worker',
    append() {
      throw new Error('session is closed')
    },
  }

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('leader', [], runtime),
    toSession: worker,
    logger: (message) => logs.push(message),
  })

  // 写失败时沙箱/审批都还停在部署默认上：回执不能再说「完全访问、无审批」。
  assert.equal(permission.sandbox, 'workspace-write')
  assert.equal(permission.approval, 'ask')
  assert.deepEqual(permission.skipped.map((item) => item.knob), ['sandbox', 'approval'])
  assert.equal(logs.length, 2)
  assert.match(logs[0], /session is closed/)
})

test('auto 身份写失败时回执不谎称「先经审查」', () => {
  const logs = []
  const runtime = {}
  const ctx = makeCtx({
    sandboxOverrides: { leader: 'danger-full-access' },
    presets: { leader: 'auto' },
    runtime,
  })
  const worker = {
    id: 'worker',
    append() {
      throw new Error('session is closed')
    },
  }

  const permission = inheritPermission({
    ctx,
    fromSession: makeSession('leader', [], runtime),
    toSession: worker,
    logger: (message) => logs.push(message),
  })

  // 沙箱与身份都没写进去：实际身份是部署默认的 workspace-write，不是 auto。
  assert.equal(permission.preset, 'workspace-write')
  assert.equal(permission.sandbox, 'workspace-write')
  assert.deepEqual(permission.skipped.map((item) => item.knob), ['sandbox', 'preset'])
})

test('读 leader 沙箱模式抛错时降级为日志与 skipped，审批策略照旧继承', () => {
  const appends = []
  const logs = []
  const runtime = {}
  const permission = inheritPermission({
    ctx: makeCtx({
      resolveError: new Error('workspace root is not absolute'),
      approvalOverrides: { leader: 'never' },
      runtime,
    }),
    fromSession: makeSession('leader', appends, runtime),
    toSession: makeSession('worker', appends, runtime),
    logger: (message) => logs.push(message),
  })

  assert.deepEqual(appends.map((item) => item.type), ['approval/policy'])
  assert.equal(permission.sandbox, 'workspace-write')
  assert.equal(permission.approval, 'never')
  assert.deepEqual(permission.skipped, [{ knob: 'sandbox', reason: '读 leader 的沙箱模式失败，worker 保持默认' }])
  assert.match(logs[0], /workspace root is not absolute/)
})
