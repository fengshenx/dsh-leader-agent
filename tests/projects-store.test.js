import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { createProjectStore } from '../src/host/projects/store.js'
import { cleanupTempDirs, makeTempDir } from './helpers/temp-dir.js'

after(cleanupTempDirs)

/**
 * 造一个临时 home 目录。
 * @returns {Promise<string>} 目录路径
 */
async function makeHome() {
  return makeTempDir('dsh-coordinator-projects-')
}

test('项目记录落盘后可读回，字段齐全', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const draft = store.draft({ name: 'alpha', directory: '/work/alpha', coordinatorSessionId: 'session-1' })
  await store.insert(draft)

  const stored = await store.get(draft.id)
  assert.equal(stored.name, 'alpha')
  assert.equal(stored.directory, '/work/alpha')
  assert.equal(stored.coordinatorSessionId, 'session-1')
  assert.equal(typeof stored.createdAt, 'number')
  assert.equal(typeof stored.updatedAt, 'number')
})

test('只接受 name 与 coordinatorSessionId 两个可变字段', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const draft = store.draft({ name: 'alpha', directory: '/work/alpha', coordinatorSessionId: 'session-1' })
  await store.insert(draft)

  const updated = await store.update(draft.id, {
    name: 'beta',
    coordinatorSessionId: 'session-2',
    directory: '/work/other',
    id: 'forged',
  })

  assert.equal(updated.name, 'beta')
  assert.equal(updated.coordinatorSessionId, 'session-2')
  assert.equal(updated.directory, '/work/alpha')
  assert.equal(updated.id, draft.id)
})

test('退役协调者列表可写，落盘后可读回', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const draft = store.draft({ name: 'alpha', directory: '/work/alpha', coordinatorSessionId: 'session-1' })
  await store.insert(draft)

  await store.update(draft.id, { retiredCoordinatorSessionIds: ['session-1'] })
  // 重开一个 store 实例读盘：写在内存里不算数
  const stored = await createProjectStore({ home }).get(draft.id)
  assert.deepEqual(stored.retiredCoordinatorSessionIds, ['session-1'])
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

test('按协调者会话反查项目', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const draft = store.draft({ name: 'alpha', directory: '/work/alpha', coordinatorSessionId: 'session-1' })
  await store.insert(draft)

  const found = await store.getByCoordinator('session-1')
  assert.equal(found.id, draft.id)
  assert.equal(await store.getByCoordinator('session-other'), undefined)
})

test('删项目后反查不到', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const draft = store.draft({ name: 'alpha', directory: '/work/alpha', coordinatorSessionId: 'session-1' })
  await store.insert(draft)

  const removed = await store.remove(draft.id)
  assert.equal(removed.id, draft.id)
  assert.equal(await store.getByCoordinator('session-1'), undefined)
  assert.equal(await store.remove(draft.id), undefined)
})

test('更新时传 undefined 会清掉该字段', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const draft = store.draft({ name: 'alpha', directory: '/work/alpha' })
  await store.insert(draft)
  await store.update(draft.id, { workspaceId: 'ws-1' })
  assert.equal((await store.get(draft.id)).workspaceId, 'ws-1')

  await store.update(draft.id, { workspaceId: undefined })
  assert.equal((await store.get(draft.id)).workspaceId, undefined)
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

  const updated = await store.update(alpha.id, { name: 'alpha', coordinatorSessionId: 'session-9' })
  assert.equal(updated.name, 'alpha')
  assert.equal(updated.coordinatorSessionId, 'session-9')
})

test('只改协调者会话时不查名字，两个同名项目仍可各自改绑', async () => {
  const home = await makeHome()
  const store = createProjectStore({ home })
  const first = await store.insert(store.draft({ name: 'alpha', directory: '/work/a' }))
  const second = await store.insert(store.draft({ name: 'beta', directory: '/work/b' }))

  await store.update(first.id, { coordinatorSessionId: 'session-1' })
  const rebound = await store.update(second.id, { coordinatorSessionId: 'session-2' })

  assert.equal(rebound.name, 'beta')
  assert.equal(rebound.coordinatorSessionId, 'session-2')
})
