import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectStore, uniqueProjectName } from '../src/host/projects/store.js'
import { cleanupTempDirs, makeTempDir } from './helpers/temp-dir.js'

after(cleanupTempDirs)

/**
 * 造一个临时 home 目录。
 * @returns {Promise<string>} 目录路径
 */
async function makeHome() {
  return makeTempDir('dsh-leader-kit-projects-')
}

test('项目记录落盘后可读回，字段齐全', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const draft = store.draft({ name: 'alpha', directory: '/work/alpha', leaderSessionId: 'session-1' })
  await store.insert(draft)

  const stored = await store.get(draft.id)
  assert.equal(stored.name, 'alpha')
  assert.equal(stored.directory, '/work/alpha')
  assert.equal(stored.leaderSessionId, 'session-1')
  assert.equal(typeof stored.createdAt, 'number')
  assert.equal(typeof stored.updatedAt, 'number')
})

test('只接受 name 与 leaderSessionId 两个可变字段', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const draft = store.draft({ name: 'alpha', directory: '/work/alpha', leaderSessionId: 'session-1' })
  await store.insert(draft)

  const updated = await store.update(draft.id, {
    name: 'beta',
    leaderSessionId: 'session-2',
    directory: '/work/other',
    id: 'forged',
  })

  assert.equal(updated.name, 'beta')
  assert.equal(updated.leaderSessionId, 'session-2')
  assert.equal(updated.directory, '/work/alpha')
  assert.equal(updated.id, draft.id)
})

test('退役 leader 列表可写，落盘后可读回', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const draft = store.draft({ name: 'alpha', directory: '/work/alpha', leaderSessionId: 'session-1' })
  await store.insert(draft)

  await store.update(draft.id, { retiredLeaderSessionIds: ['session-1'] })
  // 重开一个 store 实例读盘：写在内存里不算数
  const stored = await createProjectStore({ home }).get(draft.id)
  assert.deepEqual(stored.retiredLeaderSessionIds, ['session-1'])
})

test('旧字段名的注册表仍能读出 leader 与退役列表，写回只留新字段', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  await mkdir(join(home, 'dsh-leader-kit'), { recursive: true })
  await writeFile(store.file, `${JSON.stringify({
    version: 1,
    projects: [{
      id: 'project-legacy',
      name: 'alpha',
      directory: '/work/alpha',
      coordinatorSessionId: 'session-legacy',
      retiredCoordinatorSessionIds: ['session-retired'],
      createdAt: 1,
      updatedAt: 1,
    }],
  }, null, 2)}\n`, 'utf8')

  const [listed] = await store.list()
  assert.equal(listed.leaderSessionId, 'session-legacy')
  assert.deepEqual(listed.retiredLeaderSessionIds, ['session-retired'])
  assert.equal(Object.hasOwn(listed, 'coordinatorSessionId'), false)
  assert.equal(Object.hasOwn(listed, 'retiredCoordinatorSessionIds'), false)
  // 身份反查是工具面按 leader 裁剪的入口：旧键读不出来，leader 会丢掉整条动作链。
  assert.equal((await store.getByLeader('session-legacy'))?.id, 'project-legacy')

  // 任何一次写回都只写新字段，旧键不会跟着回到磁盘。
  await store.update('project-legacy', { name: 'beta' })
  const raw = JSON.parse(await readFile(store.file, 'utf8'))
  assert.equal(raw.projects[0].leaderSessionId, 'session-legacy')
  assert.deepEqual(raw.projects[0].retiredLeaderSessionIds, ['session-retired'])
  assert.equal(Object.hasOwn(raw.projects[0], 'coordinatorSessionId'), false)
  assert.equal(Object.hasOwn(raw.projects[0], 'retiredCoordinatorSessionIds'), false)
})

test('新旧字段同时存在时以新字段为准', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  await mkdir(join(home, 'dsh-leader-kit'), { recursive: true })
  await writeFile(store.file, `${JSON.stringify({
    version: 1,
    projects: [{
      id: 'project-both',
      name: 'alpha',
      directory: '/work/alpha',
      leaderSessionId: 'session-new',
      coordinatorSessionId: 'session-old',
      createdAt: 1,
      updatedAt: 1,
    }],
  }, null, 2)}\n`, 'utf8')

  assert.equal((await store.getByLeader('session-new'))?.id, 'project-both')
  assert.equal(await store.getByLeader('session-old'), undefined)
})

test('update 传函数时按磁盘当前值算字段，并发追加不互相覆盖', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const draft = store.draft({ name: 'alpha', directory: '/work/alpha', leaderSessionId: 'session-1' })
  await store.insert(draft)

  // 两次并发调用各读同一份快照再整体写回的话，后写的那次会把先写的覆盖掉；
  // 函数形态的读-改-写落在同一条串行链里，两次追加都要落盘。
  await Promise.all([
    store.update(draft.id, (current) => ({
      retiredLeaderSessionIds: [...current.retiredLeaderSessionIds ?? [], 'session-1'],
    })),
    store.update(draft.id, (current) => ({
      retiredLeaderSessionIds: [...current.retiredLeaderSessionIds ?? [], 'session-2'],
    })),
  ])

  const stored = await createProjectStore({ home }).get(draft.id)
  assert.deepEqual(stored.retiredLeaderSessionIds, ['session-1', 'session-2'])
  // 函数自身的属性（`name`）不能借白名单漏进记录
  assert.equal(stored.name, 'alpha')
})

test('update 传函数时同样只接受白名单字段', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const draft = store.draft({ name: 'alpha', directory: '/work/alpha', leaderSessionId: 'session-1' })
  await store.insert(draft)

  const updated = await store.update(draft.id, (current) => ({
    leaderSessionId: `${current.leaderSessionId}-2`,
    directory: '/work/other',
    id: 'forged',
  }))
  assert.equal(updated.leaderSessionId, 'session-1-2')
  assert.equal(updated.directory, '/work/alpha')
  assert.equal(updated.id, draft.id)
})

test('改不存在的项目会报错', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  await assert.rejects(() => store.update('missing', { name: 'x' }), /项目不存在/)
})

test('注册表损坏时备份原文件并写回空表', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  await store.insert(store.draft({ name: 'alpha', directory: '/work/alpha' }))
  await writeFile(store.file, '{ 这不是 JSON', 'utf8')

  const projects = await store.list()
  assert.deepEqual(projects, [])

  const raw = await readFile(store.file, 'utf8')
  assert.equal(JSON.parse(raw).projects.length, 0)
})

test('注册表结构非法时按损坏处理', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  await store.insert(store.draft({ name: 'alpha', directory: '/work/alpha' }))
  await writeFile(store.file, JSON.stringify({ version: 1 }), 'utf8')
  assert.deepEqual(await store.list(), [])
})

test('同名项目占满序号空间时明确报错，不返回重名', () => {
  // 序号从 2 数到 999：998 个候选全部被占满后没有可用的新名字。
  const taken = [{ name: 'alpha' }, ...Array.from({ length: 998 }, (_, index) => ({ name: `alpha-${index + 2}` }))]
  assert.equal(uniqueProjectName([{ name: 'alpha' }], 'alpha'), 'alpha-2')
  assert.throws(() => uniqueProjectName(taken, 'alpha'), /同名项目过多/)
})

test('按 leader 会话反查项目', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const draft = store.draft({ name: 'alpha', directory: '/work/alpha', leaderSessionId: 'session-1' })
  await store.insert(draft)

  const found = await store.getByLeader('session-1')
  assert.equal(found.id, draft.id)
  assert.equal(await store.getByLeader('session-other'), undefined)
})

test('删项目后反查不到', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const draft = store.draft({ name: 'alpha', directory: '/work/alpha', leaderSessionId: 'session-1' })
  await store.insert(draft)

  const removed = await store.remove(draft.id)
  assert.equal(removed.id, draft.id)
  assert.equal(await store.getByLeader('session-1'), undefined)
  assert.equal(await store.remove(draft.id), undefined)
})

test('更新时传 undefined 会清掉该字段', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const draft = store.draft({ name: 'alpha', directory: '/work/alpha' })
  await store.insert(draft)
  await store.update(draft.id, { leaderSessionId: 'session-1' })
  assert.equal((await store.get(draft.id)).leaderSessionId, 'session-1')

  await store.update(draft.id, { leaderSessionId: undefined })
  assert.equal((await store.get(draft.id)).leaderSessionId, undefined)
})

test('并发写不丢项目', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  await Promise.all(
    Array.from({ length: 8 }, (_value, index) =>
      store.insert(store.draft({ name: `p${index}`, directory: `/work/p${index}` }))),
  )
  assert.equal((await store.list()).length, 8)
})

test('同名项目落盘时自动加序号', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const first = await store.insert(store.draft({ name: 'repo', directory: '/work/a/repo' }))
  const second = await store.insert(store.draft({ name: 'repo', directory: '/work/b/repo' }))

  assert.equal(first.name, 'repo')
  assert.equal(second.name, 'repo-2')
  assert.deepEqual((await store.list()).map((project) => project.name), ['repo', 'repo-2'])
})

test('序号跳过已被占用的名字', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  await store.insert(store.draft({ name: 'repo', directory: '/work/a' }))
  await store.insert(store.draft({ name: 'repo-2', directory: '/work/b' }))
  const third = await store.insert(store.draft({ name: 'repo', directory: '/work/c' }))

  assert.equal(third.name, 'repo-3')
})

test('并发建同名项目也只有一个拿到原名', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  await Promise.all(
    Array.from({ length: 3 }, (_value, index) =>
      store.insert(store.draft({ name: 'repo', directory: `/work/${index}/repo` }))),
  )
  const names = (await store.list()).map((project) => project.name).sort()

  assert.deepEqual(names, ['repo', 'repo-2', 'repo-3'])
})

test('改名撞上已有项目名时报错，不偷偷加序号', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const alpha = await store.insert(store.draft({ name: 'alpha', directory: '/work/a' }))
  await store.insert(store.draft({ name: 'repo', directory: '/work/b' }))

  await assert.rejects(() => store.update(alpha.id, { name: 'repo' }), /已被占用/)
  assert.equal((await store.get(alpha.id)).name, 'alpha')
})

test('把项目改成它自己当前的名字不算撞名', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const alpha = await store.insert(store.draft({ name: 'alpha', directory: '/work/a' }))

  const updated = await store.update(alpha.id, { name: 'alpha', leaderSessionId: 'session-9' })
  assert.equal(updated.name, 'alpha')
  assert.equal(updated.leaderSessionId, 'session-9')
})

test('只改 leader 会话时不查名字，两个同名项目仍可各自改绑', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const first = await store.insert(store.draft({ name: 'alpha', directory: '/work/a' }))
  const second = await store.insert(store.draft({ name: 'beta', directory: '/work/b' }))

  await store.update(first.id, { leaderSessionId: 'session-1' })
  const rebound = await store.update(second.id, { leaderSessionId: 'session-2' })

  assert.equal(rebound.name, 'beta')
  assert.equal(rebound.leaderSessionId, 'session-2')
})

/**
 * 建三个项目并按 alpha、beta、gamma 的顺序返回。
 * @param {object} store - 项目存储
 * @returns {Promise<object[]>} 三条记录
 */
async function seedThree(store) {
  return [
    await store.insert(store.draft({ name: 'alpha', directory: '/work/a' })),
    await store.insert(store.draft({ name: 'beta', directory: '/work/b' })),
    await store.insert(store.draft({ name: 'gamma', directory: '/work/c' })),
  ]
}

test('项目按落盘顺序列出，顺序由 move 决定而不是建项时间', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const [alpha, beta, gamma] = await seedThree(store)

  await store.move(gamma.id, alpha.id)
  const names = (await store.list()).map((project) => project.name)
  assert.deepEqual(names, ['gamma', 'alpha', 'beta'])

  // 重开一个 store 读盘：顺序必须真的落盘，不是内存里的数组。
  const stored = (await createProjectStore({ home }).list()).map((project) => project.name)
  assert.deepEqual(stored, ['gamma', 'alpha', 'beta'])
  assert.deepEqual((await store.list()).map((project) => project.id), [gamma.id, alpha.id, beta.id])
})

test('move 传空串把项目移到末尾', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const [alpha, beta, gamma] = await seedThree(store)

  const result = await store.move(alpha.id, '')
  assert.equal(result.moved, true)
  assert.deepEqual(result.projectIds, [beta.id, gamma.id, alpha.id])
  assert.deepEqual((await store.list()).map((project) => project.name), ['beta', 'gamma', 'alpha'])
})

test('落点与当前位置相同不写盘，按未移动返回', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const [alpha, beta, gamma] = await seedThree(store)

  // beta 本来就在 gamma 之前。
  const noop = await store.move(beta.id, gamma.id)
  assert.equal(noop.moved, false)
  // 移到自己之前同样等于没动。
  const self = await store.move(beta.id, beta.id)
  assert.equal(self.moved, false)
  assert.deepEqual((await store.list()).map((project) => project.name), ['alpha', 'beta', 'gamma'])
  assert.deepEqual(noop.projectIds, [alpha.id, beta.id, gamma.id])
})

test('move 的锚点已不存在时落到末尾', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const [alpha, beta, gamma] = await seedThree(store)

  const result = await store.move(alpha.id, 'missing')
  assert.equal(result.moved, true)
  assert.deepEqual(result.projectIds, [beta.id, gamma.id, alpha.id])
})

test('move 不存在的项目会报错', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  await assert.rejects(() => store.move('missing', ''), /项目不存在/)
})
