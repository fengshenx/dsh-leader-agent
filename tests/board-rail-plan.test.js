import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  RAIL_LANE_HOT,
  RAIL_LANE_MUTED,
  RAIL_LANE_WARN,
  planRailLanes,
  railBranchPath,
  railLaneKind,
  railNodeState,
  railTickPath,
} from '../src/client/board-rail-plan.js'

test('只有执行中与需注意改变线的语义，其余都是静态绑定', () => {
  assert.equal(railLaneKind('running'), RAIL_LANE_HOT)
  assert.equal(railLaneKind('attention'), RAIL_LANE_WARN)
  for (const status of ['waiting', 'unread', 'idle', 'unknown', 'none', undefined]) {
    assert.equal(railLaneKind(status), RAIL_LANE_MUTED)
  }
})

test('节点状态只分三档', () => {
  assert.equal(railNodeState('running'), 'running')
  assert.equal(railNodeState('attention'), 'attention')
  assert.equal(railNodeState('waiting'), 'idle')
  assert.equal(railNodeState(undefined), 'idle')
})

test('tick 从主干拐进卡面左缘', () => {
  assert.equal(
    railTickPath({ trunkX: 20, fromY: 10, cy: 30, cardX: 44 }),
    'M20,10 L20,30 L44,30',
  )
})

test('支线是两端水平的 S 弯，短间距也保留弯度', () => {
  assert.equal(
    railBranchPath({ cardRight: 300, cy: 50, slotX: 330, slotY: 60 }),
    'M300,50 C315,50 315,60 330,60',
  )
  assert.equal(
    railBranchPath({ cardRight: 300, cy: 50, slotX: 308, slotY: 60 }),
    'M300,50 C310,50 298,60 308,60',
  )
})

test('每一行一条 tick，有执行者才多出支线', () => {
  const lanes = planRailLanes({
    trunkX: 20,
    leaderY: 10,
    rows: [
      { status: 'running', cardX: 44, cardRight: 300, cy: 50, slots: [{ x: 320, y: 50 }] },
      { status: 'attention', cardX: 44, cardRight: 300, cy: 120 },
    ],
  })
  assert.deepEqual(lanes.map((lane) => lane.id), ['tick:0', 'branch:0:0', 'tick:1'])
  assert.deepEqual(lanes.map((lane) => lane.kind), [RAIL_LANE_HOT, RAIL_LANE_HOT, RAIL_LANE_WARN])
  assert.equal(lanes[0].d, 'M20,10 L20,50 L44,50')
  assert.equal(lanes[1].d, 'M300,50 C310,50 310,50 320,50')
  assert.equal(lanes[2].d, 'M20,50 L20,120 L44,120')
})

test('坐标取一位小数，路径字符串稳定', () => {
  const lanes = planRailLanes({
    trunkX: 20.1234,
    leaderY: 10.9876,
    rows: [{ status: 'running', cardX: 44.4444, cardRight: 300.5555, cy: 50.6666, slots: [] }],
  })
  assert.equal(lanes[0].d, 'M20.1,11 L20.1,50.7 L44.4,50.7')
})

test('没有行时没有线', () => {
  assert.deepEqual(planRailLanes({ trunkX: 20, leaderY: 10, rows: [] }), [])
})
