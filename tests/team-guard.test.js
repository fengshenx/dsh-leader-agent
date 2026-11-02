import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TEAM_BAN_CONTEXT_NAME,
  TEAM_BAN_CONTEXT_ORDER,
  TEAM_BAN_TEXT,
  TEAM_TOOL_NAMES,
  applyTeamGuard,
  isAgentTeamEnabled,
  teamBanFor,
} from '../src/host/team-guard.js'
import { COORDINATOR_CONTEXT_ORDER } from '../src/host/coordinator-context.js'
import { ROLE_CONTEXT_ORDER } from '../src/host/slots/index.js'

/**
 * 建一个假的服务上下文，捕获注册进来的运行时上下文。
 *
 * @param {object} [options] - 选项
 * @param {boolean} [options.team] - 是否假装加载了 agent-team
 * @returns {{ ctx: object, holder: { registered: object | undefined } }} 上下文与注册项持有者
 */
function createFakeCtx({ team = false } = {}) {
  const holder = { registered: undefined }
  const ctx = {
    get: (name) => (team && name === 'agentTeams' ? {} : undefined),
    systemPrompt: {
      context(definition) {
        holder.registered = definition
        return () => {}
      },
    },
    effect(fn) {
      fn()
      return () => {}
    },
  }
  return { ctx, holder }
}

/** 只认一个 id 的判定函数。 */
function only(id, result = true) {
  return (sessionId) => sessionId === id && result
}

test('agentTeams 服务存在即视为启用，缺失时为未启用', () => {
  assert.equal(isAgentTeamEnabled(createFakeCtx({ team: true }).ctx), true)
  assert.equal(isAgentTeamEnabled(createFakeCtx().ctx), false)
  assert.equal(isAgentTeamEnabled({}), false)
})

test('启用时协调者与 worker 都拿到禁令，普通会话没有', () => {
  const common = { enabled: true, isCoordinatorSession: only('coordinator'), isWorkerSession: only('worker') }
  assert.equal(teamBanFor({ sessionId: 'coordinator', ...common }), TEAM_BAN_TEXT)
  assert.equal(teamBanFor({ sessionId: 'worker', ...common }), TEAM_BAN_TEXT)
  assert.equal(teamBanFor({ sessionId: 'plain', ...common }), '')
})

test('未启用时任何会话都不注入', () => {
  const options = { sessionId: 'coordinator', enabled: false, isCoordinatorSession: () => true, isWorkerSession: () => true }
  assert.equal(teamBanFor(options), '')
})

test('没有 worker 判定函数时不影响协调者判定', () => {
  assert.equal(
    teamBanFor({ sessionId: 'coordinator', enabled: true, isCoordinatorSession: () => true }),
    TEAM_BAN_TEXT,
  )
})

test('禁令点名 agent-team 的全部工具，并指向本流程的两个入口', () => {
  for (const name of TEAM_TOOL_NAMES) {
    assert.ok(TEAM_BAN_TEXT.includes(name), `禁令应点名 ${name}`)
  }
  assert.ok(TEAM_BAN_TEXT.includes('spawn_worker'))
  assert.ok(TEAM_BAN_TEXT.includes('message_worker'))
  assert.ok(TEAM_BAN_TEXT.includes('create_card'))
})

test('注册为运行时上下文，排在协调者手册与角色槽位之后', () => {
  const { ctx, holder } = createFakeCtx()
  applyTeamGuard({ ctx, isCoordinatorSession: () => false })
  assert.equal(holder.registered.name, TEAM_BAN_CONTEXT_NAME)
  assert.equal(holder.registered.order, TEAM_BAN_CONTEXT_ORDER)
  assert.ok(TEAM_BAN_CONTEXT_ORDER > COORDINATOR_CONTEXT_ORDER)
  assert.ok(TEAM_BAN_CONTEXT_ORDER > ROLE_CONTEXT_ORDER)
  assert.equal(holder.registered.required, true)
  assert.equal(holder.registered.interpolate, false)
})

test('求值时按会话身份决定注入内容', () => {
  const { ctx, holder } = createFakeCtx({ team: true })
  applyTeamGuard({ ctx, isCoordinatorSession: only('coordinator'), isWorkerSession: only('worker') })
  assert.equal(holder.registered.text({ agent: { id: 'coordinator' } }), TEAM_BAN_TEXT)
  assert.equal(holder.registered.text({ agent: { id: 'worker' } }), TEAM_BAN_TEXT)
  assert.equal(holder.registered.text({ agent: { id: 'plain' } }), '')
  assert.equal(holder.registered.text({}), '')
})

test('求值抛错时返回空串并记日志，不把错误抛给组装流程', () => {
  const messages = []
  const { ctx, holder } = createFakeCtx({ team: true })
  applyTeamGuard({
    ctx,
    isCoordinatorSession: () => { throw new Error('索引坏了') },
    logger: (message) => messages.push(message),
  })
  assert.equal(holder.registered.text({ agent: { id: 'coordinator' } }), '')
  assert.match(messages[0], /渲染 agent-team 禁令失败.*索引坏了/)
})

test('检测到 agent-team 时只告警一次', () => {
  const messages = []
  const { ctx } = createFakeCtx({ team: true })
  const guard = applyTeamGuard({ ctx, isCoordinatorSession: () => false, logger: (message) => messages.push(message) })
  guard.warnOnce()
  guard.warnOnce()
  assert.equal(messages.length, 1)
  assert.match(messages[0], /检测到 agent-team/)
  assert.match(messages[0], /dsh-experimental-agent-team-profile/)
})

test('没有 agent-team 时不告警', () => {
  const messages = []
  const { ctx } = createFakeCtx()
  const guard = applyTeamGuard({ ctx, isCoordinatorSession: () => false, logger: (message) => messages.push(message) })
  guard.warnOnce()
  assert.deepEqual(messages, [])
})
