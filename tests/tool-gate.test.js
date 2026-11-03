import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CARD_WRITE_TOOLS,
  LEADER_ONLY_TOOLS,
  LEADER_UNUSABLE_TOOLS,
  PLAIN_SESSION_DENY_TOOLS,
  WORKER_DENY_TOOLS,
  applyToolGate,
  canWriteCardsFor,
  deniedToolsFor,
} from '../src/host/tools/gate.js'

/**
 * 造一个 agent 假件，并记录作用域上的 restrict 调用。
 *
 * 方法面照 `engines.dsh` 的下限（0.2.1-rc.2）构造：只有 `restrict` / `get` /
 * `schemas`。夹具多给一个宿主方法就会掩盖版本缺口——`definitions()` 是
 * 0.2.2-alpha.2 才加的，在 0.2.1-rc.2 上调用是 TypeError，而那个调用落在
 * `agent/created` 上，会让每个会话创建都失败。
 *
 * @param {string} id - 会话 id
 * @param {string[]} [registered] - 该作用域里已注册的全局工具名，默认包含三件宿主工具
 * @returns {object} agent
 */
function makeAgent(id, registered = [
  'list_agents', 'send_message', 'interrupt_agent', 'read', 'write',
  'spawn_worker', 'message_worker', 'read_worker_session', 'list_cards',
  'create_card', 'update_card',
]) {
  const restrictions = []
  const names = new Set(registered)
  return {
    id,
    ctx: {
      tools: {
        // 照宿主的真实行为：名单里有当前组合没有的全局工具名就抛错。
        restrict: (filter) => {
          const unknown = filter.deny.filter((name) => !names.has(name))
          if (unknown.length > 0) {
            throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map((name) => `"${name}"`).join(', ')}; known global tools: ${[...names].sort().join(', ')}`)
          }
          restrictions.push(filter)
          return () => {}
        },
        get: (name) => (names.has(name) ? { name } : undefined),
        schemas: () => registered.map((name) => ({ name })),
      },
    },
    restrictions,
  }
}

test('leader 拿不到收作业的工具，也拿不到对 worker 无效的三件宿主工具', () => {
  const denied = deniedToolsFor({
    agent: makeAgent('leader-1'),
    isLeaderSession: (id) => id === 'leader-1',
    isWorkerSession: () => false,
  })
  // 三件宿主 subagent 工具对根会话 worker 全部无效，其中一个还返回假成功回执，
  // 从工具面直接摘掉比只在文档里叮嘱可靠。
  assert.deepEqual(denied, [...LEADER_UNUSABLE_TOOLS])
})

test('worker 看不到派工、全库查询与建卡，但保留改卡', () => {
  const denied = deniedToolsFor({
    agent: makeAgent('worker-1'),
    isLeaderSession: () => false,
    isWorkerSession: (id) => id === 'worker-1',
  })
  assert.deepEqual(denied, [...WORKER_DENY_TOOLS])
  // 建卡与派工是 leader 的一条动作链；worker 只在自己的卡上写回状态。
  assert.ok(denied.includes('create_card'))
  assert.ok(!denied.includes('update_card'))
})

test('普通会话没有派工、全库查询与卡片写入', () => {
  const denied = deniedToolsFor({
    agent: makeAgent('plain-1'),
    isLeaderSession: () => false,
    isWorkerSession: () => false,
  })
  // 卡片是项目里的任务事实：普通会话建的卡没有槽位、没有 leader 认领，只会污染看板。
  assert.deepEqual(denied, [...PLAIN_SESSION_DENY_TOOLS])
  assert.deepEqual(denied.filter((name) => CARD_WRITE_TOOLS.includes(name)), [...CARD_WRITE_TOOLS])
})

test('read_worker_session 只给 leader：worker 与普通会话的工具面都摘掉它', () => {
  const workerDenied = deniedToolsFor({
    agent: makeAgent('worker-1'),
    isLeaderSession: () => false,
    isWorkerSession: (id) => id === 'worker-1',
  })
  const plainDenied = deniedToolsFor({
    agent: makeAgent('plain-1'),
    isLeaderSession: () => false,
    isWorkerSession: () => false,
  })
  // 断言写字面量而不是比 WORKER_DENY_TOOLS：名单推导的断言会跟着名单一起缩，
  // 把工具从 LEADER_ONLY_TOOLS 里删掉时仍然全绿，钉不住工具面这条承诺。
  assert.ok(workerDenied.includes('read_worker_session'))
  assert.ok(plainDenied.includes('read_worker_session'))

  const leaderDenied = deniedToolsFor({
    agent: makeAgent('leader-1'),
    isLeaderSession: (id) => id === 'leader-1',
    isWorkerSession: () => false,
  })
  assert.ok(!leaderDenied.includes('read_worker_session'))
})

test('缺 worker 判定时按普通会话处理，不误判成 worker', () => {
  const denied = deniedToolsFor({
    agent: makeAgent('whatever'),
    isLeaderSession: () => false,
  })
  assert.deepEqual(denied, [...PLAIN_SESSION_DENY_TOOLS])
})

test('applyToolGate 只对受限角色调 restrict，并在作用域上留下限制', () => {
  const leader = makeAgent('c')
  applyToolGate({
    agent: leader,
    isLeaderSession: (id) => id === 'c',
    isWorkerSession: () => false,
  })
  assert.deepEqual(leader.restrictions, [{ deny: [...LEADER_UNUSABLE_TOOLS] }])

  const worker = makeAgent('w')
  const workerDenied = applyToolGate({
    agent: worker,
    isLeaderSession: () => false,
    isWorkerSession: () => true,
  })
  assert.deepEqual(worker.restrictions, [{ deny: [...WORKER_DENY_TOOLS] }])
  assert.deepEqual(workerDenied, [...WORKER_DENY_TOOLS])

  const plain = makeAgent('p')
  const plainDenied = applyToolGate({
    agent: plain,
    isLeaderSession: () => false,
    isWorkerSession: () => false,
  })
  assert.deepEqual(plain.restrictions, [{ deny: [...PLAIN_SESSION_DENY_TOOLS] }])
  assert.deepEqual(plainDenied, [...PLAIN_SESSION_DENY_TOOLS])
})

test('三件宿主工具改由 preset 子树注册时仍然被 deny', () => {
  // `get(name)` 省略 scope 只看全局层；web-app 把这三件在宿主平面 disabled，
  // 改由 preset 子树注册——用 get 探测会把它们全判成「不存在」，限制失效。
  const leader = makeAgent('c')
  leader.ctx.tools.get = () => undefined

  const denied = applyToolGate({
    agent: leader,
    isLeaderSession: (id) => id === 'c',
    isWorkerSession: () => false,
  })

  assert.deepEqual(denied, [...LEADER_UNUSABLE_TOOLS])
  assert.deepEqual(leader.restrictions, [{ deny: [...LEADER_UNUSABLE_TOOLS] }])
})

test('restrict 抛的不是「未知工具名」时照常抛出，不吞装配错误', () => {
  const leader = makeAgent('c')
  leader.ctx.tools.restrict = () => {
    throw new Error('tools.restrict() requires a scoped context (agent.ctx)')
  }

  assert.throws(
    () => applyToolGate({
      agent: leader,
      isLeaderSession: (id) => id === 'c',
      isWorkerSession: () => false,
    }),
    /scoped context/,
  )
})

test('宿主没装 subagent 控制工具时跳过那三件，不拿未注册的工具名去 restrict', () => {
  // `restrict()` 对没注册过的全局工具名直接报错，而这三件来自可被禁用的宿主组合。
  const leader = makeAgent('c', ['read', 'write', 'spawn_worker', 'message_worker', 'list_cards'])
  const denied = applyToolGate({
    agent: leader,
    isLeaderSession: (id) => id === 'c',
    isWorkerSession: () => false,
  })
  assert.deepEqual(denied, [])
  assert.deepEqual(leader.restrictions, [])
})

test('只依赖 engines 下限的 tools 方法面', () => {
  // 0.2.1-rc.2 的 ToolsService 没有 definitions()。这个调用落在 agent/created 上，
  // 一旦用上就是每个会话创建都 TypeError——而且夹具给了假方法就测不出来。
  const leader = makeAgent('c')
  assert.equal(typeof leader.ctx.tools.definitions, 'undefined')
  assert.doesNotThrow(() => applyToolGate({
    agent: leader,
    isLeaderSession: (id) => id === 'c',
    isWorkerSession: () => false,
  }))
})

test('三组名单互不重叠，改名时不会悄悄互相覆盖', () => {
  const overlap = LEADER_ONLY_TOOLS.filter((name) => LEADER_UNUSABLE_TOOLS.includes(name))
  assert.deepEqual(overlap, [])
  // 卡片写入与「只有 leader 能用」是两条独立的规则：worker 保留前者、没有后者。
  const cardOverlap = CARD_WRITE_TOOLS.filter((name) => LEADER_ONLY_TOOLS.includes(name))
  assert.deepEqual(cardOverlap, [])
})

test('写卡身份判定：worker 直接放行，不等项目索引', async () => {
  let waits = 0
  const allowed = await canWriteCardsFor({
    sessionId: 'worker-1',
    isLeaderSession: () => false,
    isWorkerSession: (id) => id === 'worker-1',
    awaitIndex: async () => { waits += 1; return false },
  })
  // worker 是进程内的内存集合，不依赖项目注册表：索引读不出来也不该牵连它。
  assert.equal(allowed, true)
  assert.equal(waits, 0)
})

test('写卡身份判定：索引未就绪时拒绝，不吃 isLeaderSession 的宽松放行', async () => {
  const sessionId = 'plain-1'
  const allowed = await canWriteCardsFor({
    sessionId,
    // 索引未就绪时真实实现对所有会话返回 true——这里照抄那个宽松行为。
    isLeaderSession: () => true,
    isWorkerSession: () => false,
    awaitIndex: async () => false,
  })
  // 问不出身份就不给写：卡片会落盘并归属到项目，与派工同口径 fail closed。
  assert.equal(allowed, false)
})

test('写卡身份判定：索引就绪后只认当前 leader', async () => {
  const options = {
    isWorkerSession: () => false,
    awaitIndex: async () => true,
  }
  assert.equal(await canWriteCardsFor({
    sessionId: 'leader-1',
    isLeaderSession: (id) => id === 'leader-1',
    ...options,
  }), true)
  assert.equal(await canWriteCardsFor({
    sessionId: 'plain-1',
    isLeaderSession: (id) => id === 'leader-1',
    ...options,
  }), false)
})
