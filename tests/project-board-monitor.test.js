import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBoardWatch } from '../src/client/project-board-monitor.js'

/**
 * 造一条走项目通道的假调用。
 * @param {object} options - 选项
 * @param {object} [options.project] - 会话所属项目；不给就是不属于任何项目
 * @param {object[]} [options.cards] - 项目当前卡片
 * @returns {{ callRemote: Function, setCards: (cards: object[]) => void }} 假调用与卡片 setter
 */
function createRemote({
  project = { id: 'p1', name: '项目一', leaderSessionId: 'session-1' },
  cards = [],
} = {}) {
  let current = cards
  let currentProject = project
  return {
    callRemote: async (method) => {
      if (method === 'resolveProject') return currentProject
      if (method === 'boardCards') return current
      throw new Error(`未预期的远程方法：${method}`)
    },
    setCards: (next) => { current = next },
    setProject: (next) => { currentProject = next },
  }
}

test('第一轮只建立基线，项目里已有的卡不弹看板', async () => {
  const remote = createRemote({ cards: [{ id: 'c1' }, { id: 'c2' }] })
  let revealed = 0
  const watch = createBoardWatch({
    callRemote: remote.callRemote,
    onNewCard: () => { revealed += 1 },
  })
  watch.followSession('session-1')
  await watch.poll()
  assert.equal(revealed, 0)
})

test('项目里多了一张卡就报新卡', async () => {
  const remote = createRemote({ cards: [{ id: 'c1' }] })
  let revealed = 0
  const watch = createBoardWatch({
    callRemote: remote.callRemote,
    onNewCard: () => { revealed += 1 },
  })
  watch.followSession('session-1')
  await watch.poll()
  remote.setCards([{ id: 'c1' }, { id: 'c2' }])
  await watch.poll()
  assert.equal(revealed, 1)
})

test('改卡不算新卡：只有内容变化不该打扰用户', async () => {
  const remote = createRemote({ cards: [{ id: 'c1', revision: 1 }] })
  let revealed = 0
  const watch = createBoardWatch({
    callRemote: remote.callRemote,
    onNewCard: () => { revealed += 1 },
  })
  watch.followSession('session-1')
  await watch.poll()
  remote.setCards([{ id: 'c1', revision: 2 }])
  await watch.poll()
  assert.equal(revealed, 0)
})

test('会话不属于任何项目时不监视', async () => {
  const remote = createRemote({ project: undefined })
  let revealed = 0
  const watch = createBoardWatch({
    callRemote: remote.callRemote,
    onNewCard: () => { revealed += 1 },
  })
  watch.followSession('session-1')
  await watch.poll()
  assert.equal(revealed, 0)
})

test('leader 会话已失效时不监视：新卡不弹看板也不取卡', async () => {
  const remote = createRemote({
    project: { id: 'p1', name: '项目一', leaderSessionId: 'session-1', leaderAlive: false },
    cards: [{ id: 'c1' }],
  })
  let revealed = 0
  let fetched = 0
  const watch = createBoardWatch({
    callRemote: async (method, args) => {
      if (method === 'boardCards') fetched += 1
      return remote.callRemote(method, args)
    },
    onNewCard: () => { revealed += 1 },
  })
  watch.followSession('session-1')
  await watch.poll()
  remote.setCards([{ id: 'c1' }, { id: 'c2' }])
  await watch.poll()
  assert.equal(revealed, 0)
  assert.equal(fetched, 0)
})

test('运行中 leader 失效：复核后不再弹看板', async () => {
  const remote = createRemote({ cards: [{ id: 'c1' }] })
  let revealed = 0
  const watch = createBoardWatch({
    callRemote: remote.callRemote,
    onNewCard: () => { revealed += 1 },
  })
  watch.followSession('session-1')
  await watch.poll()
  // 复核间隔 15 轮；先跑 14 轮把计数推到复核点前
  for (let index = 0; index < 14; index += 1) await watch.poll()
  remote.setProject({ id: 'p1', name: '项目一', leaderSessionId: 'session-1', leaderAlive: false })
  await watch.poll()
  remote.setCards([{ id: 'c1' }, { id: 'c2' }])
  await watch.poll()
  assert.equal(revealed, 0)
})

test('屏幕会话不是项目 leader 时不监视：新卡不弹看板也不取卡', async () => {
  const remote = createRemote({
    project: { id: 'p1', name: '项目一', leaderSessionId: 'leader-1' },
    cards: [{ id: 'c1' }],
  })
  let revealed = 0
  let fetched = 0
  const watch = createBoardWatch({
    callRemote: async (method, args) => {
      if (method === 'boardCards') fetched += 1
      return remote.callRemote(method, args)
    },
    onNewCard: () => { revealed += 1 },
  })
  watch.followSession('worker-1')
  await watch.poll()
  remote.setCards([{ id: 'c1' }, { id: 'c2' }])
  await watch.poll()
  assert.equal(revealed, 0)
  assert.equal(fetched, 0)
})

test('换会话后重建基线：新会话的项目里已有的卡不弹看板', async () => {
  const projects = {
    'session-1': { id: 'p1', name: '项目一', leaderSessionId: 'session-1' },
    'session-2': { id: 'p2', name: '项目二', leaderSessionId: 'session-2' },
  }
  const remote = createRemote({ cards: [{ id: 'c1' }] })
  let revealed = 0
  const watch = createBoardWatch({
    callRemote: async (method, args) => (method === 'resolveProject'
      ? projects[args[0]]
      : remote.callRemote(method, args)),
    onNewCard: () => { revealed += 1 },
  })
  watch.followSession('session-1')
  await watch.poll()
  watch.followSession('session-2')
  await watch.poll()
  assert.equal(revealed, 0)
})

test('通道未就绪时不放弃：下一轮会重试解析项目', async () => {
  let ready = false
  const remote = createRemote({ cards: [{ id: 'c1' }] })
  let revealed = 0
  const watch = createBoardWatch({
    callRemote: async (method, args) => {
      if (!ready) throw new Error('项目通道不可用')
      return remote.callRemote(method, args)
    },
    onNewCard: () => { revealed += 1 },
  })
  watch.followSession('session-1')
  await assert.rejects(() => watch.poll(), /项目通道不可用/)
  // 通道就绪后再轮一轮：项目解析成功，基线建立
  ready = true
  await watch.poll()
  assert.equal(revealed, 0)
  // 再多一张卡 → 报新卡
  remote.setCards([{ id: 'c1' }, { id: 'c2' }])
  await watch.poll()
  assert.equal(revealed, 1)
})
