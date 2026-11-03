import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LEADER_VIEW_TARGET,
  activateLeaderView,
  collectLeaderSessionIds,
  createLeaderSessionIndex,
  createLeaderViewDefinition,
} from '../src/client/leader-view-logic.js'

test('视图定义的目标 id 固定', () => {
  assert.equal(createLeaderViewDefinition().target, LEADER_VIEW_TARGET)
})

test('视图定义激活即生效', () => {
  const definition = createLeaderViewDefinition()
  assert.equal(definition.isActive(definition.create().empty), true)
})

test('视图构建器的快照恒定：replace 与 apply 给出同一个值', () => {
  const builder = createLeaderViewDefinition().create()
  const replaced = builder.replace({ nodes: [], timeline: {} })
  const applied = builder.apply({ upserts: [], timeline: {} })
  assert.equal(replaced, builder.empty)
  assert.equal(applied, builder.empty)
})

test('会话索引：订阅即刻收到当前名单', () => {
  const index = createLeaderSessionIndex()
  const seen = []
  index.subscribe((ids) => seen.push([...ids]))
  index.update(['s-1'])
  assert.deepEqual(seen, [[], ['s-1']])
})

test('会话索引：名单没变时不通知', () => {
  const index = createLeaderSessionIndex()
  index.update(['s-1'])
  const seen = []
  index.subscribe((ids) => seen.push([...ids]))
  index.update(['s-1'])
  assert.deepEqual(seen, [['s-1']])
})

test('会话索引：退订后不再收到通知', () => {
  const index = createLeaderSessionIndex()
  const seen = []
  const unsubscribe = index.subscribe((ids) => seen.push([...ids]))
  unsubscribe()
  index.update(['s-1'])
  assert.deepEqual(seen, [[]])
})

test('从项目列表里取 leader 会话 id', () => {
  assert.deepEqual(collectLeaderSessionIds([
    { id: 'p-1', leaderSessionId: 's-1' },
    { id: 'p-2', leaderSessionId: '' },
    { id: 'p-3' },
  ]), ['s-1'])
})

test('项目列表不是数组时取不到 leader 会话', () => {
  assert.deepEqual(collectLeaderSessionIds(undefined), [])
  assert.deepEqual(collectLeaderSessionIds({}), [])
})

test('会话已绑定时激活 leader 视图目标', () => {
  const activated = []
  const conversation = {
    binding: (sessionId) => ({ activate: (target) => activated.push([sessionId, target]) }),
  }
  assert.equal(activateLeaderView(conversation, 's-1'), true)
  assert.deepEqual(activated, [['s-1', LEADER_VIEW_TARGET]])
})

test('会话还没绑定时不激活', () => {
  const conversation = {
    binding: () => { throw new Error('unknown session') },
  }
  assert.equal(activateLeaderView(conversation, 's-1'), false)
})

test('会话视图服务缺失时不激活', () => {
  assert.equal(activateLeaderView(undefined, 's-1'), false)
  assert.equal(activateLeaderView({}, 's-1'), false)
})
