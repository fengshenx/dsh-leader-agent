import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { realpath } from 'node:fs/promises'
import { createProjectStore } from '../src/host/projects/store.js'
import { createProjectService } from '../src/host/projects/service.js'
import { createProjectRemote } from '../src/host/projects/remote.js'
import { describeDeletionNotice } from '../src/client/project-panel-logic.js'
import { cleanupTempDirs, makeTempDir } from './helpers/temp-dir.js'

after(cleanupTempDirs)

/**
 * 装配真实的「数据层 → 远程通道 → 提示文案」链路。
 *
 * 三段各自单测时形状可能对不上：service 报 `notFound`、remote 原样透传、客户端
 * 按 `notFound` 收尾。这个文件把它们串起来跑，防的就是「远端返回的每种形状在
 * 文案里落成哪一支」这类跨段错误。
 *
 * @returns {Promise<object>} 链路、临时目录与假件
 */
async function makeChain() {
  const home = await makeTempDir('dsh-leader-agent-delete-notice-')
  const directory = await makeTempDir('dsh-leader-agent-delete-notice-work-')
  const workspaces = [{
    id: 'ws-user',
    path: await realpath(directory),
    title: '我自己的工作区',
    sessionIds: [],
    detachSession: async () => {},
  }]
  const registry = {
    list: () => workspaces,
    delete: async () => {
      throw new Error('删除项目不该碰工作区')
    },
  }
  const provided = new Map()
  const ctx = {
    provide(key, value) {
      provided.set(key, value)
      return () => provided.delete(key)
    },
    get: (key) => (key === 'workspaceRegistry' ? registry : undefined),
  }
  const store = createProjectStore({ home })
  const service = createProjectService({
    store,
    ctx,
    isWorkerSession: () => false,
    createLeaderSession: async (target, sessionId) => sessionId,
    sessionExists: async () => true,
  })
  const remote = createProjectRemote({
    service,
    cards: { detachSession: async () => ({ cards: [], slots: 0, worker: false }) },
    workers: { remove: async () => true },
    ctx,
  })
  return { remote, store, registry, workspaces, directory }
}

test('删除项目只删记录：不碰 dsh 工作区', async () => {
  const { remote, registry, workspaces, directory } = await makeChain()
  const project = await remote.create(directory, 'alpha')

  const result = await remote.deleteProject(project.id)

  assert.deepEqual(result, { removed: true })
  // 工作区原样留着；删除项目根本没有调用工作区服务。
  assert.equal(registry.list().length, 1)
  assert.equal(workspaces[0].id, 'ws-user')
  assert.equal(describeDeletionNotice(project, result), '已删除项目「alpha」。')
})

test('旧记录里带着 workspaceId 也不影响删除：工作区仍然不动', async () => {
  const { remote, store, registry, directory } = await makeChain()
  // 旧版本把「插件自建的工作区」记在项目记录里；升级后这个字段只作为存量数据
  // 保留，删除项目不再读它。
  const draft = store.draft({ name: 'alpha', directory })
  await store.insert({ ...draft, workspaceId: 'ws-legacy' })

  const result = await remote.deleteProject(draft.id)

  assert.deepEqual(result, { removed: true })
  assert.equal(registry.list().length, 1)
})

test('删不存在的项目：明确返回未删除，客户端按幂等成功收尾', async () => {
  const { remote } = await makeChain()

  const result = await remote.deleteProject('missing')

  assert.deepEqual(result, {
    removed: false,
    notFound: true,
    reason: '项目不存在。',
  })
  assert.equal(describeDeletionNotice({ name: 'alpha' }, result), '已删除项目「alpha」。')
})
