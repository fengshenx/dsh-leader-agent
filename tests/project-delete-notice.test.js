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
 * 三段各自单测时形状可能对不上：service 报 `skipped`、remote 原样透传、客户端
 * 按 `reason` 判失败。这个文件把它们串起来跑，防的就是「远端返回的每种形状在
 * 文案里落成哪一支」这类跨段错误。
 *
 * @param {object} [options] - 选项
 * @param {boolean} [options.withRegistry] - 宿主是否有工作区服务
 * @param {boolean} [options.deletable] - 工作区服务是否支持删除
 * @returns {Promise<object>} 链路、临时目录与假件
 */
async function makeChain({ withRegistry = true, deletable = true } = {}) {
  const home = await makeTempDir('dsh-leader-kit-delete-notice-')
  const directory = await makeTempDir('dsh-leader-kit-delete-notice-work-')
  const workspaces = []
  const registry = {
    list: () => workspaces,
    create: async (path, title) => {
      const created = {
        id: `ws-${workspaces.length + 1}`,
        path,
        title,
        sessionIds: [],
        attachSession: async () => {},
      }
      workspaces.push(created)
      return created
    },
  }
  if (deletable) {
    registry.delete = async (id) => {
      const index = workspaces.findIndex((item) => item.id === id)
      if (index === -1) return false
      workspaces.splice(index, 1)
      return true
    }
  }
  const provided = new Map()
  const ctx = {
    provide(key, value) {
      provided.set(key, value)
      return () => provided.delete(key)
    },
    get: (key) => (key === 'workspaceRegistry' && withRegistry ? registry : undefined),
  }
  const store = createProjectStore({ home })
  const service = createProjectService({
    store,
    ctx,
    isWorkerSession: () => false,
    createCoordinatorSession: async (target, sessionId) => sessionId,
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

test('插件注册了工作区：删除成功后不留提示', async () => {
  const { remote, directory } = await makeChain()
  const project = await remote.create(directory, 'alpha')

  const result = await remote.deleteProject(project.id)

  assert.deepEqual(result, { removed: true, workspaceRemoved: true })
  // 项目行消失就是回执；常驻一句「已删除项目…」只会挂在侧栏里。
  assert.equal(describeDeletionNotice(project, result), '')
})

test('复用的用户工作区不碰：删除成功不留提示', async () => {
  const { remote, registry, workspaces, directory } = await makeChain()
  const userWorkspace = {
    id: 'ws-user',
    path: await realpath(directory),
    title: '我自己的工作区',
    sessionIds: [],
    attachSession: async () => {},
  }
  workspaces.push(userWorkspace)
  const project = await remote.create(directory, 'alpha')

  const result = await remote.deleteProject(project.id)

  assert.deepEqual(result, { removed: true, workspaceRemoved: false, skipped: true })
  assert.equal(registry.list().length, 1)
  // 正常删除被说成「工作区未移除：该项目没有由插件注册的工作区」就是这条链路的旧 bug。
  assert.equal(describeDeletionNotice(project, result), '')
})

test('记录里的工作区已悬空：按「没有可移的」静默成功', async () => {
  const { remote, store, directory } = await makeChain()
  const project = await remote.create(directory, 'alpha')
  // 模拟宿主里工作区被别的途径删掉、项目记录没跟上。
  await store.update(project.id, { workspaceId: 'ws-gone' })

  const result = await remote.deleteProject(project.id)

  assert.deepEqual(result, { removed: true, workspaceRemoved: false, skipped: true })
  assert.equal(describeDeletionNotice(project, result), '')
})

test('宿主没有工作区服务：按「没有可移的」静默成功', async () => {
  const { remote, directory } = await makeChain({ withRegistry: false })
  const project = await remote.create(directory, 'alpha')

  const result = await remote.deleteProject(project.id)

  assert.deepEqual(result, { removed: true, workspaceRemoved: false, skipped: true })
  assert.equal(describeDeletionNotice(project, result), '')
})

test('宿主工作区服务不支持删除：真失败要报出来，项目照样删', async () => {
  const { remote, registry, directory } = await makeChain({ deletable: false })
  const project = await remote.create(directory, 'alpha')

  const result = await remote.deleteProject(project.id)

  assert.deepEqual(result, {
    removed: true,
    workspaceRemoved: false,
    reason: '当前宿主的工作区服务不支持删除。',
  })
  // 工作区留在宿主里，用户只能去官方面板手动删——提示必须说清。
  assert.equal(registry.list().length, 1)
  const notice = describeDeletionNotice(project, result)
  assert.match(notice, /工作区未移除：当前宿主的工作区服务不支持删除。/)
})

test('删不存在的项目：不算删掉，也不该报成工作区问题', async () => {
  const { remote } = await makeChain()

  const result = await remote.deleteProject('missing')

  assert.deepEqual(result, {
    removed: false,
    workspaceRemoved: false,
    notFound: true,
    reason: '项目不存在。',
  })
  // `reason` 在这里是「项目不存在」而不是工作区摘除失败，不能落成工作区告警。
  assert.equal(describeDeletionNotice({ name: 'alpha' }, result), '')
})
