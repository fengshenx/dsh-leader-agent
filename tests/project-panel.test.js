import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  basenameOf,
  buildProjectMenuItems,
  classifyDeletionResult,
  collectExcludedSessionIds,
  collectHiddenWorkspaceIds,
  currentSessionIdOf,
  defaultProjectName,
  describeDeletionNotice,
  describeProjectRemoval,
  isProjectOpenable,
  isProjectCurrent,
  moveProjectBefore,
  openCoordinatorSession,
  planProjectRename,
  projectDropAnchor,
  projectSectionLayout,
  quietWorkspaceOf,
  selectProjectSessionRows,
  isArchiveActiveRefusal,
  validateProjectName,
} from '../src/client/project-panel-logic.js'

test('目录末段在两种分隔符下都能取到', () => {
  assert.equal(basenameOf('/work/alpha'), 'alpha')
  assert.equal(basenameOf('C:\\work\\alpha'), 'alpha')
  assert.equal(basenameOf('/work/alpha/'), 'alpha')
  assert.equal(basenameOf('/work/alpha///'), 'alpha')
})

test('项目名不能为空也不能过长', () => {
  assert.equal(validateProjectName('alpha').ok, true)
  assert.equal(validateProjectName('  ').ok, false)
  assert.equal(validateProjectName('x'.repeat(201)).ok, false)
  assert.equal(validateProjectName('x'.repeat(200)).ok, true)
})

test('目录名能当项目名时直接可用', () => {
  const check = defaultProjectName('/work/alpha')

  assert.equal(check.ok, true)
  assert.equal(check.name, 'alpha')
  assert.equal(check.error, '')
})

test('目录名当不了项目名时给出改名理由', () => {
  const root = defaultProjectName('/')
  assert.equal(root.ok, false)
  assert.equal(root.error, '项目名不能为空')

  const tooLong = defaultProjectName(`/work/${'x'.repeat(201)}`)
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.error, '项目名过长（上限 200 字）')
})

test('协调者会话没了的项目不能直接打开', () => {
  assert.equal(isProjectOpenable({ coordinatorSessionId: 'session-1', coordinatorAlive: true }), true)
  assert.equal(isProjectOpenable({ coordinatorSessionId: 'session-1', coordinatorAlive: false }), false)
  assert.equal(isProjectOpenable({ coordinatorSessionId: '', coordinatorAlive: true }), false)
  assert.equal(isProjectOpenable({ coordinatorAlive: true }), false)
})

test('会话存在性未知时按可打开处理', () => {
  assert.equal(isProjectOpenable({ coordinatorSessionId: 'session-1' }), true)
})

test('项目下的会话列表不含协调者', () => {
  const rows = selectProjectSessionRows({
    sessionIds: ['s-coordinator', 's-worker'],
    sessionRows: {
      's-coordinator': { id: 's-coordinator' },
      's-worker': { id: 's-worker' },
    },
    coordinatorSessionId: 's-coordinator',
  })
  assert.deepEqual(rows.map((row) => row.id), ['s-worker'])
})

test('会话列表还没同步到时先略过该会话', () => {
  const rows = selectProjectSessionRows({
    sessionIds: ['s-known', 's-unknown'],
    sessionRows: { 's-known': { id: 's-known' } },
    coordinatorSessionId: undefined,
  })
  assert.deepEqual(rows.map((row) => row.id), ['s-known'])
})

test('没有会话时列表为空', () => {
  assert.deepEqual(selectProjectSessionRows({ sessionIds: [], sessionRows: {} }), [])
})

test('已归档的会话不再列出——宿主的会话索引按磁盘扫，不过滤就会原地复活', () => {
  const rows = selectProjectSessionRows({
    sessionIds: ['s-live', 's-archived'],
    sessionRows: { 's-live': { id: 's-live' }, 's-archived': { id: 's-archived' } },
    coordinatorSessionId: undefined,
    archivedSessionIds: new Set(['s-archived']),
  })
  assert.deepEqual(rows.map((row) => row.id), ['s-live'])
})

test('官方工作区树的排除集含协调者与全部 worker 会话', () => {
  const projects = [
    { id: 'p1', coordinatorSessionId: 'session-c1' },
    { id: 'p2', coordinatorSessionId: '' },
  ]
  const sessionsByProject = new Map([
    ['p1', ['worker-a', 'worker-b']],
    ['p2', []],
  ])
  // worker 是普通根会话，官方树不会自己滤掉，不排除就会同时出现在两棵树里。
  assert.deepEqual(
    [...collectExcludedSessionIds(projects, sessionsByProject)].sort(),
    ['session-c1', 'worker-a', 'worker-b'],
  )
})

test('没有项目或没有 worker 会话时排除集为空', () => {
  assert.equal(collectExcludedSessionIds([], new Map()).size, 0)
  assert.deepEqual(
    [...collectExcludedSessionIds([{ id: 'p1', coordinatorSessionId: 'c' }], new Map())],
    ['c'],
  )
})

test('插件注册的工作区整行藏掉，用户自己的工作区不藏', () => {
  const hidden = collectHiddenWorkspaceIds([
    { id: 'p1', workspaceId: 'w-plugin' },
    // 复用用户已有的工作区时不记 workspaceId——那不是我们的东西。
    { id: 'p2' },
    { id: 'p3', workspaceId: '' },
  ])
  assert.deepEqual([...hidden], ['w-plugin'])
  assert.equal(collectHiddenWorkspaceIds([]).size, 0)
})

test('当前会话取主区域持有的那条', () => {
  assert.equal(currentSessionIdOf({
    's1': { retainedBy: { sidebar: 1 } },
    's2': { retainedBy: { mainView: 1 } },
  }), 's2')
  assert.equal(currentSessionIdOf({ 's1': { retainedBy: {} } }), undefined)
  assert.equal(currentSessionIdOf(undefined), undefined)
})

test('当前会话是协调者或项目下的 worker 时点亮项目行', () => {
  const project = {
    coordinatorSessionId: 'session-coordinator',
    retiredCoordinatorSessionIds: ['session-retired'],
  }
  const sessions = ['session-worker', 'session-retired']
  assert.equal(isProjectCurrent(project, sessions, 'session-coordinator'), true)
  assert.equal(isProjectCurrent(project, sessions, 'session-worker'), true)
})

test('退役协调者与归档会话打开时项目行不亮', () => {
  const project = {
    coordinatorSessionId: 'session-coordinator',
    retiredCoordinatorSessionIds: ['session-retired'],
  }
  // 宿主把退役协调者与 worker 同列返回；归档会话也仍在会话索引里。
  const sessions = ['session-worker', 'session-retired']
  assert.equal(isProjectCurrent(project, sessions, 'session-retired'), false)
  assert.equal(
    isProjectCurrent(project, sessions, 'session-worker', new Set(['session-worker'])),
    false,
  )
  // 现任协调者被归档后项目树里没有这一行可点，同样不亮。
  assert.equal(
    isProjectCurrent(project, sessions, 'session-coordinator', new Set(['session-coordinator'])),
    false,
  )
})

test('当前会话属于别的项目或主区域为空时项目行不亮', () => {
  const project = { coordinatorSessionId: 'session-coordinator' }
  const sessions = ['session-coordinator', 'session-worker']
  assert.equal(isProjectCurrent(project, sessions, 'session-other'), false)
  assert.equal(isProjectCurrent(project, sessions, undefined), false)
  assert.equal(isProjectCurrent(project, sessions, ''), false)
  // 会话归属还没同步回来：只有协调者那一条能判定。
  assert.equal(isProjectCurrent(project, undefined, 'session-coordinator'), true)
  assert.equal(isProjectCurrent(project, undefined, 'session-worker'), false)
})

test('当前会话被排除时压掉它所属工作区的激活态', () => {
  const workspaces = [
    { workspaceId: 'w1', sessionIds: ['s1'] },
    { workspaceId: 'w2', sessionIds: ['s2', 's3'] },
  ]
  assert.equal(quietWorkspaceOf('s2', new Set(['s2', 's3']), workspaces), 'w2')
})

test('当前会话没被排除时不动任何工作区', () => {
  const workspaces = [{ workspaceId: 'w1', sessionIds: ['s1'] }]
  // 用户在项目目录里手动开的会话留在官方树里，点亮它所属的工作区是对的。
  assert.equal(quietWorkspaceOf('s1', new Set(['s2']), workspaces), undefined)
  // 主区域没有会话时也不该压灰。
  assert.equal(quietWorkspaceOf(undefined, new Set(['s1']), workspaces), undefined)
})

test('排除集里的会话不在任何工作区视图里时不压灰', () => {
  assert.equal(quietWorkspaceOf('s9', new Set(['s9']), [{ workspaceId: 'w1', sessionIds: ['s1'] }]), undefined)
  assert.equal(quietWorkspaceOf('s9', new Set(['s9']), undefined), undefined)
})

test('归档失败只在「会话还在跑」时要求确认', () => {
  const active = Object.assign(new Error('会话正在执行'), {
    name: 'WorkspaceArchiveError',
    rpcError: { code: 'workspace/session-active', details: { activity: [] } },
  })
  assert.equal(isArchiveActiveRefusal(active), true)
  // 其余失败不该问「要不要停」：确认了也一样失败。
  const missing = Object.assign(new Error('没有该会话'), {
    name: 'WorkspaceArchiveError',
    rpcError: { code: 'workspace/session-not-found' },
  })
  assert.equal(isArchiveActiveRefusal(missing), false)
  assert.equal(isArchiveActiveRefusal(new Error('通道断了')), false)
  assert.equal(isArchiveActiveRefusal(undefined), false)
})

test('打开协调者会先挂工作区再打开会话', async () => {
  const calls = []
  const opened = []
  const result = await openCoordinatorSession({
    project: { id: 'p-1', coordinatorSessionId: 'session-1' },
    callRemote: async (method, args) => {
      calls.push([method, args])
      return { attached: true, workspaceId: 'ws-1' }
    },
    openSession: (sessionId) => opened.push(sessionId),
  })
  assert.deepEqual(result, { ok: true, workspaceId: 'ws-1', recreated: false, reconnected: 0 })
  assert.deepEqual(calls, [['attachCoordinator', ['p-1']]])
  assert.deepEqual(opened, ['session-1'])
})

test('工作区被删后重建：结果里带重建标记与归位数量', async () => {
  const result = await openCoordinatorSession({
    project: { id: 'p-1', coordinatorSessionId: 'session-1' },
    callRemote: async () => ({ attached: true, workspaceId: 'ws-2', recreated: true, reconnected: 3 }),
    openSession: () => {},
  })
  assert.deepEqual(result, { ok: true, workspaceId: 'ws-2', recreated: true, reconnected: 3 })
})

test('挂不上工作区时不打开会话并报出原因', async () => {
  const opened = []
  const result = await openCoordinatorSession({
    project: { id: 'p-1', coordinatorSessionId: 'session-1' },
    callRemote: async () => ({ attached: false, reason: '当前宿主没有工作区服务' }),
    openSession: (sessionId) => opened.push(sessionId),
  })
  assert.equal(result.ok, false)
  assert.equal(result.message, '当前宿主没有工作区服务')
  assert.deepEqual(opened, [])
})

test('远程调用抛错时不打开会话并报出原因', async () => {
  const opened = []
  const result = await openCoordinatorSession({
    project: { id: 'p-1', coordinatorSessionId: 'session-1' },
    callRemote: async () => {
      throw new Error('通道断开')
    },
    openSession: (sessionId) => opened.push(sessionId),
  })
  assert.equal(result.ok, false)
  assert.match(result.message, /通道断开/)
  assert.deepEqual(opened, [])
})

test('项目菜单只有一条删除入口，没有工作区也出现', () => {
  const items = buildProjectMenuItems({ id: 'p1' }, menuHandlers())
  const removals = items.filter((item) => item.danger === true)
  assert.equal(removals.length, 1)
  assert.equal(removals[0].id, 'remove')
  assert.equal(removals[0].label, '删除')
  assert.equal(removals[0].icon, 'trash-outline')
  // 移除工作区这个入口已经并进删除，菜单里不再有它
  assert.equal(items.some((item) => item.id === 'remove-workspace'), false)
})

test('项目菜单不再重复「打开协调者会话」——点项目行就是打开', () => {
  const items = buildProjectMenuItems({ id: 'p1' }, menuHandlers())
  assert.equal(items.some((item) => item.id === 'open'), false)
  assert.deepEqual(items.map((item) => item.id), ['rename', 'replace', 'remove'])
})

test('有插件工作区时删除说明讲清工作区移除与会话落未分组', () => {
  const text = describeProjectRemoval({ name: 'demo', workspaceId: 'ws-1' })
  assert.match(text, /demo/)
  assert.match(text, /从 dsh 工作区列表移除/)
  assert.match(text, /文件夹与会话记录都会保留/)
  assert.match(text, /未分组/)
})

test('没有插件工作区时删除说明不提工作区', () => {
  const text = describeProjectRemoval({ name: 'demo' })
  assert.match(text, /删除/)
  assert.match(text, /文件夹与会话记录都会保留/)
  assert.doesNotMatch(text, /工作区/)
})

test('删除成功的提示固定一句回执，工作区摘除失败才带原因', () => {
  assert.equal(describeDeletionNotice({ name: 'demo' }, { workspaceRemoved: true }), '已删除项目「demo」。')
  // 没有工作区可摘（宿主报 skipped）是正常删除，回执不提工作区。
  assert.equal(describeDeletionNotice({ name: 'demo' }, { workspaceRemoved: false, skipped: true }), '已删除项目「demo」。')
  // 项目已不存在（幂等成功）：它的 reason 是「项目不存在」，不能当工作区告警。
  assert.equal(
    describeDeletionNotice({ name: 'demo' }, { notFound: true, reason: '项目不存在。' }),
    '已删除项目「demo」。',
  )
  const failed = describeDeletionNotice({ name: 'demo' }, { workspaceRemoved: false, reason: '宿主不支持删除工作区。' })
  assert.match(failed, /工作区未移除/)
  assert.match(failed, /宿主不支持删除工作区/)
})

test('重复删除按幂等成功收尾，不报成失败', () => {
  assert.equal(classifyDeletionResult({ removed: true, workspaceRemoved: true }), 'removed')
  // 项目已经不在了：目标达成，弹窗要能关掉、列表要刷新。
  assert.equal(classifyDeletionResult({ removed: false, notFound: true, reason: '项目不存在。' }), 'alreadyGone')
  assert.equal(classifyDeletionResult({ removed: false, reason: '出错了。' }), 'failed')
  assert.equal(classifyDeletionResult(undefined), 'failed')
})

test('菜单里的删除入口只发请求，不直接执行', () => {
  const asked = []
  const items = buildProjectMenuItems({ id: 'p1' }, {
    ...menuHandlers(),
    onRemove: (project) => asked.push(project.id),
  })
  items.find((item) => item.id === 'remove').onSelect()
  assert.deepEqual(asked, ['p1'])
})

test('项目通道未就绪的状态行不受列表折叠影响', () => {
  const collapsed = projectSectionLayout({
    remoteStatus: '项目通道未就绪。通道不可用。',
    listExpanded: false,
    projectCount: 2,
  })
  assert.equal(collapsed.status, '项目通道未就绪。通道不可用。')
  assert.equal(collapsed.showList, false)
  assert.equal(collapsed.showEmpty, false)

  // 通道就绪后这行消失，列表照常显示。
  const ready = projectSectionLayout({ remoteStatus: '', listExpanded: true, projectCount: 2 })
  assert.equal(ready.status, '')
  assert.equal(ready.showList, true)
})

test('通道未就绪时不说「还没有项目」，收起时也不显示空态', () => {
  assert.deepEqual(
    projectSectionLayout({ remoteStatus: '', listExpanded: true, projectCount: 0 }),
    { status: '', showList: false, showEmpty: true },
  )
  // 「还没有项目」属于列表内容，列表收起就跟着收起；状态行不在此列。
  assert.equal(projectSectionLayout({ remoteStatus: '', listExpanded: false, projectCount: 0 }).showEmpty, false)
  // 通道坏着时说「还没有项目」是误导：列表位置放状态行，不放空态。
  assert.equal(
    projectSectionLayout({ remoteStatus: '项目通道未就绪。', listExpanded: true, projectCount: 0 }).showEmpty,
    false,
  )
})

test('重命名校验失败时保留输入框并给就地原因', () => {
  assert.deepEqual(planProjectRename('demo', ''), { action: 'keep', error: '项目名不能为空' })
  assert.deepEqual(
    planProjectRename('demo', 'x'.repeat(201)),
    { action: 'keep', error: '项目名过长（上限 200 字）' },
  )
  // 名字没改：直接收起，不打扰宿主。
  assert.deepEqual(planProjectRename('demo', 'demo'), { action: 'close' })
  assert.deepEqual(planProjectRename('demo', 'renamed'), { action: 'commit', name: 'renamed' })
})

/**
 * 菜单项只需要处理函数存在，测试里不关心它做了什么。
 * @returns {object} 菜单处理函数
 */
function menuHandlers() {
  const noop = () => {}
  return {
    onRename: noop,
    onReplace: noop,
    onRemove: noop,
  }
}

test('拖到目标行上半插到它之前，下半插到它之后', () => {
  const ids = ['a', 'b', 'c']
  // 把 c 拖到 a 之前。
  assert.equal(projectDropAnchor(ids, 'c', 'a', 'before'), 'a')
  // 把 a 拖到 b 之后：锚点是 b 的下一项 c。
  assert.equal(projectDropAnchor(ids, 'a', 'b', 'after'), 'c')
  // 落到最后一行下半就是末尾。
  assert.equal(projectDropAnchor(ids, 'a', 'c', 'after'), '')
})

test('顺序不会变的落点返回 null，不发远程调用', () => {
  const ids = ['a', 'b', 'c']
  // a 本来就在 b 之前。
  assert.equal(projectDropAnchor(ids, 'a', 'b', 'before'), null)
  // c 本来就在 b 之后。
  assert.equal(projectDropAnchor(ids, 'c', 'b', 'after'), null)
  // 落在自己身上：上半插到自己之前、下半插到自己之后，都没动。
  assert.equal(projectDropAnchor(ids, 'b', 'b', 'before'), null)
  assert.equal(projectDropAnchor(ids, 'b', 'b', 'after'), null)
  // 最后一行落在自己下半同样是末尾原地。
  assert.equal(projectDropAnchor(ids, 'c', 'c', 'after'), null)
})

test('落点认不出来时不动顺序', () => {
  const ids = ['a', 'b']
  assert.equal(projectDropAnchor(ids, 'missing', 'a', 'before'), null)
  assert.equal(projectDropAnchor(ids, 'a', 'missing', 'before'), null)
  assert.equal(projectDropAnchor(undefined, 'a', 'b', 'before'), null)
})

test('本地乐观重排与服务端 move 同语义', () => {
  const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(
    moveProjectBefore(projects, 'c', 'a').map((project) => project.id),
    ['c', 'a', 'b'],
  )
  assert.deepEqual(
    moveProjectBefore(projects, 'a', '').map((project) => project.id),
    ['b', 'c', 'a'],
  )
  // 锚点不存在时落到末尾；被拖项不在列表里时原样返回。
  assert.deepEqual(
    moveProjectBefore(projects, 'b', 'missing').map((project) => project.id),
    ['a', 'c', 'b'],
  )
  assert.deepEqual(
    moveProjectBefore(projects, 'missing', 'a').map((project) => project.id),
    ['a', 'b', 'c'],
  )
  // 不改动入参。
  assert.deepEqual(projects.map((project) => project.id), ['a', 'b', 'c'])
})
