import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  boardViewState,
  fetchBoardCards,
  fetchProjectSessions,
  fetchSlotLabels,
  isBoardEntryVisible,
  isBoardViewable,
  isLeaderProject,
  isProjectSession,
  isRetiredLeaderSession,
  newCardIds,
  resolveBoardAccess,
  resolveProject,
  sameProjectSummary,
} from '../src/client/project-board-data.js'

test('解析项目：通道返回项目就返回，返回空就说没有项目', async () => {
  const project = await resolveProject(async () => ({ id: 'p1', name: '项目一' }), 'session-1')
  assert.equal(project.id, 'p1')
  assert.equal(await resolveProject(async () => undefined, 'session-1'), undefined)
  assert.equal(await resolveProject(async () => null, 'session-1'), undefined)
})

test('解析项目：会话 id 为空时不发远程调用', async () => {
  let called = 0
  const resolve = async () => { called += 1; return undefined }
  assert.equal(await resolveProject(resolve, ''), undefined)
  assert.equal(called, 0)
})

test('看板只认项目 leader：worker 与同目录普通会话都不算', () => {
  const project = { id: 'p1', name: '项目一', leaderSessionId: 'leader-1' }
  assert.equal(isLeaderProject(project, 'leader-1'), true)
  assert.equal(isLeaderProject(project, 'worker-1'), false)
  assert.equal(isLeaderProject(project, 'plain-1'), false)
  assert.equal(isLeaderProject({ id: 'p1' }, 'leader-1'), false)
  assert.equal(isLeaderProject({ id: 'p1', leaderSessionId: '' }, ''), false)
  assert.equal(isLeaderProject(undefined, 'leader-1'), false)
})

test('看板视图状态：归属、身份与存活收敛成六种出口', () => {
  const base = { id: 'p1', name: '项目一', leaderSessionId: 'leader-1' }
  assert.equal(boardViewState(undefined, 'leader-1', false), 'no-project')
  // leader 失效优先于身份：项目会话与旧 leader 本人都该看到「去换新 leader」
  assert.equal(boardViewState({ ...base, leaderAlive: false }, 'leader-1', false), 'leader-dead')
  assert.equal(boardViewState({ ...base, leaderAlive: false }, 'worker-1', true), 'leader-dead')
  assert.equal(boardViewState({ ...base, leaderAlive: false }, 'worker-1', false), 'leader-dead')
  // 项目 worker 可看；同目录的普通会话不可看
  assert.equal(boardViewState({ ...base, leaderAlive: true }, 'worker-1', true), 'worker')
  assert.equal(boardViewState({ ...base, leaderAlive: true }, 'worker-1', false), 'not-viewable')
  assert.equal(boardViewState({ ...base, leaderAlive: true }, 'plain-1', false), 'not-viewable')
  assert.equal(boardViewState({ ...base, leaderAlive: true }, 'leader-1', false), 'leader')
  // leader 本人不会被 worker 参数改判
  assert.equal(boardViewState(base, 'leader-1', true), 'leader')
  // 存活状态未知按「还在」处理
  assert.equal(boardViewState(base, 'leader-1', false), 'leader')
})

test('看板视图状态：身份未判定时走 pending，不落进 not-viewable', () => {
  const base = { id: 'p1', name: '项目一', leaderSessionId: 'leader-1' }
  // worker 表那趟还没回来：既不能说「不是项目会话」，也不能说可看
  assert.equal(boardViewState(base, 'worker-1', undefined), 'pending')
  assert.equal(boardViewState({ ...base, leaderAlive: false }, 'worker-1', undefined), 'pending')
  // leader 身份由项目摘要直接给出，不需要等 worker 表
  assert.equal(boardViewState(base, 'leader-1', undefined), 'leader')
  // pending 不是可看状态：卡片取数不能抢跑
  assert.equal(isBoardViewable(base, 'worker-1', undefined), false)
})

test('看板可看性：leader 与项目 worker 可看，普通会话不可看', () => {
  const base = { id: 'p1', name: '项目一', leaderSessionId: 'leader-1' }
  assert.equal(isBoardViewable({ ...base, leaderAlive: true }, 'leader-1', false), true)
  assert.equal(isBoardViewable({ ...base, leaderAlive: true }, 'worker-1', true), true)
  // 存活状态未知时按「还在」处理，不误报失效
  assert.equal(isBoardViewable(base, 'leader-1', false), true)
  assert.equal(isBoardViewable({ ...base, leaderAlive: false }, 'leader-1', false), false)
  assert.equal(isBoardViewable({ ...base, leaderAlive: false }, 'worker-1', true), false)
  assert.equal(isBoardViewable({ ...base, leaderAlive: true }, 'worker-1', false), false)
  assert.equal(isBoardViewable({ ...base, leaderAlive: true }, 'plain-1', false), false)
  assert.equal(isBoardViewable(undefined, 'leader-1', false), false)
})

test('入口可见性：只有项目会话有入口，leader 失效时仍保留出口', () => {
  const base = { id: 'p1', name: '项目一', leaderSessionId: 'leader-1' }
  assert.equal(isBoardEntryVisible(base, 'leader-1', false), true)
  assert.equal(isBoardEntryVisible(base, 'worker-1', true), true)
  // 同目录里的普通会话没有看板入口
  assert.equal(isBoardEntryVisible(base, 'plain-1', false), false)
  assert.equal(isBoardEntryVisible(base, 'worker-1', false), false)
  assert.equal(isBoardEntryVisible(undefined, 'leader-1', false), false)
  // 身份没问出来之前不画：宁可晚一拍，也不能先对普通会话撒谎
  assert.equal(isBoardEntryVisible(base, 'worker-1', undefined), false)
})

test('入口可见性：leader 失效时，三条会话出口各归各位', () => {
  const base = { id: 'p1', name: '项目一', leaderSessionId: 'leader-1' }
  const dead = { ...base, leaderAlive: false }
  // 旧 leader 本人：入口留着，点开是「去左栏换新 leader」的引导
  assert.equal(isBoardEntryVisible(dead, 'leader-1', false), true)
  // 项目 worker：同样留着出口
  assert.equal(isBoardEntryVisible(dead, 'worker-1', true), true)
  // 同目录的普通会话：看板面板会给失效引导（#19 的有意设计），但入口不该画
  assert.equal(isBoardEntryVisible(dead, 'plain-1', false), false)
})

test('退役 leader 不是项目会话：没有看板入口，面板按普通会话处理', () => {
  const base = {
    id: 'p1',
    name: '项目一',
    leaderSessionId: 'leader-1',
    leaderAlive: true,
    retiredLeaderSessionIds: ['retired-1'],
  }
  assert.equal(isRetiredLeaderSession(base, 'retired-1'), true)
  assert.equal(isRetiredLeaderSession(base, 'leader-1'), false)
  assert.equal(isRetiredLeaderSession({ id: 'p1' }, 'retired-1'), false)
  assert.equal(isRetiredLeaderSession(base, ''), false)
  // 项目会话表把它和 worker 列在一起：身份不能再按 worker 用
  assert.equal(boardViewState(base, 'retired-1', true), 'not-viewable')
  assert.equal(boardViewState(base, 'retired-1', false), 'not-viewable')
  // 退役身份来自项目摘要，不必等会话表问回来
  assert.equal(boardViewState(base, 'retired-1', undefined), 'not-viewable')
  // leader 后来又失效了也不把它当项目会话：出口留给项目会话
  assert.equal(boardViewState({ ...base, leaderAlive: false }, 'retired-1', true), 'not-viewable')
  assert.equal(isBoardViewable(base, 'retired-1', true), false)
  assert.equal(isBoardEntryVisible(base, 'retired-1', true), false)
  assert.equal(isBoardEntryVisible(base, 'retired-1', undefined), false)
  // 当前 leader 与 worker 不受影响
  assert.equal(isBoardEntryVisible(base, 'leader-1', false), true)
  assert.equal(isBoardEntryVisible(base, 'worker-1', true), true)
})

test('项目会话表：按项目归组，非数组当空表', async () => {
  const table = await fetchProjectSessions(async () => [
    { projectId: 'p1', sessionIds: ['w1', 'w2'] },
    { projectId: 'p2', sessionIds: ['w3'] },
    { projectId: '', sessionIds: ['bad'] },
    { projectId: 'p3', sessionIds: 'not-an-array' },
  ])
  assert.equal(isProjectSession('p1', 'w1', table), true)
  assert.equal(isProjectSession('p2', 'w1', table), false)
  assert.equal(isProjectSession('p1', 'plain-1', table), false)
  assert.equal(isProjectSession('missing', 'w1', table), false)
  assert.equal(isProjectSession('p1', '', table), false)
  // 项目 id 为空、sessionIds 不是数组的条目都不进表
  assert.equal(table.has(''), false)
  assert.equal(table.has('p3'), false)
  assert.deepEqual(await fetchProjectSessions(async () => 'not-an-array'), new Map())
  assert.deepEqual(await fetchProjectSessions(async () => undefined), new Map())
})

/**
 * 造一个项目通道假件：按方法名回值或抛错，并记录调用顺序。
 *
 * @param {Record<string, unknown>} answers - 方法名到返回值；`Error` 表示抛出
 * @returns {{ calls: string[], callRemote: (method: string, args: unknown[]) => Promise<unknown> }} 假件
 */
function fakeRemote(answers) {
  const calls = []
  const callRemote = async (method) => {
    calls.push(method)
    const answer = answers[method]
    if (answer instanceof Error) throw answer
    return answer
  }
  return { calls, callRemote }
}

test('解析看板访问权：leader 不问 worker 表，worker 与普通会话都问', async () => {
  const project = { id: 'p1', name: '项目一', leaderSessionId: 'leader-1' }
  const groups = [{ projectId: 'p1', sessionIds: ['worker-1'] }]

  const leader = fakeRemote({ resolveProject: project, sessionsByProject: groups })
  assert.deepEqual(await resolveBoardAccess(leader.callRemote, 'leader-1'), { project, worker: false })
  // leader 身份由项目摘要直接给出，不必再问 worker 表
  assert.deepEqual(leader.calls, ['resolveProject'])

  const worker = fakeRemote({ resolveProject: project, sessionsByProject: groups })
  assert.deepEqual(await resolveBoardAccess(worker.callRemote, 'worker-1'), { project, worker: true })
  assert.deepEqual(worker.calls, ['resolveProject', 'sessionsByProject'])

  const plain = fakeRemote({ resolveProject: project, sessionsByProject: groups })
  assert.deepEqual(await resolveBoardAccess(plain.callRemote, 'plain-1'), { project, worker: false })
})

test('解析看板访问权：退役 leader 虽在项目会话表里，也不算 worker', async () => {
  const project = {
    id: 'p1',
    name: '项目一',
    leaderSessionId: 'leader-1',
    retiredLeaderSessionIds: ['retired-1'],
  }
  const groups = [{ projectId: 'p1', sessionIds: ['worker-1', 'retired-1'] }]

  const retired = fakeRemote({ resolveProject: project, sessionsByProject: groups })
  assert.deepEqual(await resolveBoardAccess(retired.callRemote, 'retired-1'), { project, worker: false })
  // 退役身份来自项目摘要，不必再问会话表
  assert.deepEqual(retired.calls, ['resolveProject'])

  const worker = fakeRemote({ resolveProject: project, sessionsByProject: groups })
  assert.deepEqual(await resolveBoardAccess(worker.callRemote, 'worker-1'), { project, worker: true })
})

test('解析看板访问权：不属于项目就不问 worker 表', async () => {
  const remote = fakeRemote({ resolveProject: undefined })
  assert.deepEqual(await resolveBoardAccess(remote.callRemote, 'plain-1'), { project: undefined, worker: false })
  assert.deepEqual(remote.calls, ['resolveProject'])
})

test('解析看板访问权：worker 表失败按「不是 worker」兜底', async () => {
  const project = { id: 'p1', name: '项目一', leaderSessionId: 'leader-1' }
  const remote = fakeRemote({
    resolveProject: project,
    sessionsByProject: new Error('项目通道调用失败：sessionsByProject（boom）'),
  })
  assert.deepEqual(await resolveBoardAccess(remote.callRemote, 'worker-1'), { project, worker: false })
})

test('解析看板访问权：项目解析失败照常抛出', async () => {
  const remote = fakeRemote({ resolveProject: new Error('项目通道不可用') })
  await assert.rejects(() => resolveBoardAccess(remote.callRemote, 's-1'), /项目通道不可用/)
})

test('项目摘要比较：名字、leader 或存活状态变了才算变化', () => {
  const base = { id: 'p1', leaderSessionId: 'c1', leaderAlive: true }
  assert.equal(sameProjectSummary(base, { ...base }), true)
  assert.equal(sameProjectSummary(base, { ...base, leaderAlive: false }), false)
  assert.equal(sameProjectSummary(base, { ...base, leaderSessionId: 'c2' }), false)
  // 重命名也要算变化：否则看板上的项目名会一直停在旧值
  assert.equal(sameProjectSummary(base, { ...base, name: '改名' }), false)
  assert.equal(sameProjectSummary(undefined, undefined), true)
  assert.equal(sameProjectSummary(undefined, base), false)
})

test('取项目卡片：通道返回数组才认，非数组当空列表', async () => {
  const cards = await fetchBoardCards(async () => [{ id: 'c1' }], 'p1')
  assert.equal(cards.length, 1)
  assert.deepEqual(await fetchBoardCards(async () => 'not-an-array', 'p1'), [])
  assert.deepEqual(await fetchBoardCards(async () => [{ id: 'c1' }], ''), [])
})

test('取槽位显示名：只留非空字符串条目，空项目 id 不发调用', async () => {
  let call
  const labels = await fetchSlotLabels(async (method, args) => {
    call = [method, args]
    return { dev: '开发', review: '审核', audit: '', bad: 3 }
  }, 'p1')
  assert.deepEqual(call, ['projectSlots', ['p1']])
  assert.deepEqual(labels, { dev: '开发', review: '审核' })
  assert.deepEqual(await fetchSlotLabels(async () => ({}), ''), {})
  assert.deepEqual(await fetchSlotLabels(async () => null, 'p1'), {})
  assert.deepEqual(await fetchSlotLabels(async () => ['dev'], 'p1'), {})
})

test('新增卡片 id：只看多出来的卡，改卡不算新增', () => {
  const before = [{ id: 'a', revision: 1 }, { id: 'b', revision: 1 }]
  // 内容变化：id 没变，不是新增
  assert.deepEqual(newCardIds(before, [{ id: 'a', revision: 2 }, { id: 'b', revision: 1 }]), [])
  // 多了一张卡
  assert.deepEqual(
    newCardIds(before, [{ id: 'a', revision: 1 }, { id: 'b', revision: 1 }, { id: 'c', revision: 0 }]),
    ['c'],
  )
  // 少了一张卡不是新增（卡片被归档不算「刚建的」）
  assert.deepEqual(newCardIds(before, [{ id: 'a', revision: 1 }]), [])
})

test('新增卡片 id：缺 id 的条目不算新增', () => {
  assert.deepEqual(newCardIds([], [{ title: '没有 id' }]), [])
})
