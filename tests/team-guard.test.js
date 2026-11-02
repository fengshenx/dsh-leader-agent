import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TEAM_BAN_CONTEXT_NAME,
  TEAM_BAN_CONTEXT_ORDER,
  TEAM_BAN_GUIDANCE,
  TEAM_BAN_TEXT_COORDINATOR,
  TEAM_BAN_TEXT_WORKER,
  TEAM_TOOL_NAMES,
  applyTeamGuard,
  isAgentTeamEnabled,
  teamBanFor,
} from '../src/host/team-guard.js'
import { COORDINATOR_ONLY_TOOLS, COORDINATOR_UNUSABLE_TOOLS } from '../src/host/tools/gate.js'
import { COORDINATOR_CONTEXT_ORDER } from '../src/host/coordinator-context.js'
import { ROLE_CONTEXT_ORDER } from '../src/host/slots/index.js'

/** 宿主 rc.2 的 `CONTEXT_ORDERS`：SUBAGENT_DELEGATION 排在团队身份之前。 */
const HOST_SUBAGENT_DELEGATION_ORDER = 120

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

test('启用时协调者与 worker 各拿自己的禁令，普通会话没有', () => {
  const common = { enabled: true, isCoordinatorSession: only('coordinator'), isWorkerSession: only('worker') }
  assert.equal(teamBanFor({ sessionId: 'coordinator', ...common }), TEAM_BAN_TEXT_COORDINATOR)
  assert.equal(teamBanFor({ sessionId: 'worker', ...common }), TEAM_BAN_TEXT_WORKER)
  assert.equal(teamBanFor({ sessionId: 'plain', ...common }), '')
  assert.notEqual(TEAM_BAN_TEXT_COORDINATOR, TEAM_BAN_TEXT_WORKER)
})

test('未启用时任何会话都不注入', () => {
  const options = { sessionId: 'coordinator', enabled: false, isCoordinatorSession: () => true, isWorkerSession: () => true }
  assert.equal(teamBanFor(options), '')
})

test('没有 worker 判定函数时不影响协调者判定', () => {
  assert.equal(
    teamBanFor({ sessionId: 'coordinator', enabled: true, isCoordinatorSession: () => true }),
    TEAM_BAN_TEXT_COORDINATOR,
  )
})

test('两份禁令都点名 agent-team 的全部工具', () => {
  for (const text of [TEAM_BAN_TEXT_COORDINATOR, TEAM_BAN_TEXT_WORKER]) {
    for (const name of TEAM_TOOL_NAMES) {
      assert.ok(text.includes(name), `禁令应点名 ${name}`)
    }
  }
})

test('每个角色的推荐入口都在自己的工具面里', () => {
  const texts = { coordinator: TEAM_BAN_TEXT_COORDINATOR, worker: TEAM_BAN_TEXT_WORKER }
  for (const [role, names] of Object.entries(TEAM_BAN_GUIDANCE)) {
    const denied = role === 'coordinator' ? COORDINATOR_UNUSABLE_TOOLS : COORDINATOR_ONLY_TOOLS
    for (const name of names) {
      assert.ok(!denied.includes(name), `${role} 的推荐入口 ${name} 不该在自己被 deny 的清单里`)
      assert.ok(texts[role].includes(name), `${role} 的禁令应给出入口 ${name}`)
    }
  }
})

test('worker 的禁令不点名协调者专属工具：照做只会 tool-not-found', () => {
  // 协调者侧不能套同一条规则：它被 deny 的 send_message / list_agents / interrupt_agent
  // 同时也是团队工具名，必须在「不要用」里点名。
  for (const name of COORDINATOR_ONLY_TOOLS) {
    assert.ok(!TEAM_BAN_TEXT_WORKER.includes(name), `worker 禁令不该出现 ${name}`)
  }
})

test('注册为运行时上下文，排在协调者手册与角色槽位之后、宿主的委派说明之前', () => {
  const { ctx, holder } = createFakeCtx()
  applyTeamGuard({ ctx, isCoordinatorSession: () => false })
  assert.equal(holder.registered.name, TEAM_BAN_CONTEXT_NAME)
  assert.equal(holder.registered.order, TEAM_BAN_CONTEXT_ORDER)
  assert.equal(TEAM_BAN_CONTEXT_ORDER, 106)
  assert.ok(TEAM_BAN_CONTEXT_ORDER > COORDINATOR_CONTEXT_ORDER)
  assert.ok(TEAM_BAN_CONTEXT_ORDER > ROLE_CONTEXT_ORDER)
  // 越过 120 就排到宿主 SUBAGENT_DELEGATION 与 agent-team 的 TEAM_IDENTITY 之后，
  // 禁令的意图（先读环境约束）失效。精确值 + 上界两头都守。
  assert.ok(TEAM_BAN_CONTEXT_ORDER < HOST_SUBAGENT_DELEGATION_ORDER)
  assert.equal(holder.registered.required, true)
  assert.equal(holder.registered.interpolate, false)
})

test('求值时按会话身份决定注入内容', () => {
  const { ctx, holder } = createFakeCtx({ team: true })
  applyTeamGuard({ ctx, isCoordinatorSession: only('coordinator'), isWorkerSession: only('worker') })
  assert.equal(holder.registered.text({ agent: { id: 'coordinator' } }), TEAM_BAN_TEXT_COORDINATOR)
  assert.equal(holder.registered.text({ agent: { id: 'worker' } }), TEAM_BAN_TEXT_WORKER)
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
