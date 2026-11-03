import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createLeaderHandover } from '../src/host/leader-handover.js'
import { createNotificationStore } from '../src/host/notification-store.js'
import { createProjectStore } from '../src/host/projects/store.js'
import { createWorkerRegistry } from '../src/host/worker-registry.js'
import { cleanupTempDirs, makeTempDir } from './helpers/temp-dir.js'

after(cleanupTempDirs)

/**
 * 造一个已换过 leader 的项目记录。
 *
 * @param {object} options - 选项
 * @param {string[]} options.retired - 退役 leader id（按换下的先后）
 * @param {string} options.leader - 当前 leader id
 * @returns {Promise<{ home: string, projects: object, projectId: string }>} 项目注册表与 id
 */
async function makeProject({ retired, leader }) {
  const home = await makeTempDir('dsh-leader-kit-handover-')
  const projects = createProjectStore({ home })
  const project = await projects.insert({
    id: `p-${leader}`,
    name: 'alpha',
    directory: '/repo',
    leaderSessionId: leader,
    retiredLeaderSessionIds: retired,
    createdAt: 1,
    updatedAt: 1,
  })
  return { home, projects, projectId: project.id }
}

/** 造一条待投递通知。 */
function pendingNotification(id, parentSessionId) {
  return {
    id,
    childId: `child-${id}`,
    parentSessionId,
    name: '实现工',
    text: '任务「实现工」已结束。',
    createdAt: 1,
    attempts: 0,
  }
}

test('换 leader 后，派工记录与未投递通知一起改投新会话', async () => {
  const { home, projects, projectId } = await makeProject({
    retired: ['leader-1'],
    leader: 'leader-2',
  })
  const workers = createWorkerRegistry({ home })
  await workers.register({ childId: 'child-1', parentSessionId: 'leader-1', name: '实现工' })
  const notifications = createNotificationStore({ home })
  await notifications.enqueue(pendingNotification('note-1', 'leader-1'))
  const calls = []
  const pushes = []
  const dispatcher = {
    reassignParent(fromId, toId) {
      calls.push([fromId, toId])
      return 2
    },
    async redeliverPendingFor(parentSessionId) {
      pushes.push(parentSessionId)
      return 1
    },
  }
  const handover = createLeaderHandover({ projects, workers, notifications, dispatcher })

  await handover({ projectId })

  const worker = await workers.get('child-1')
  assert.equal(worker.parentSessionId, 'leader-2')
  // 「谁派的工」留痕
  assert.deepEqual(worker.reassignedFrom, ['leader-1'])
  assert.deepEqual(
    (await notifications.listPending()).map((item) => item.parentSessionId),
    ['leader-2'],
  )
  // 三处都要改：只改落盘归属的话，回报仍会投给退役会话
  assert.deepEqual(calls, [['leader-1', 'leader-2']])
  // 改投过来的通知要推一次投递：新会话的 agent/created 早于这次迁移
  assert.deepEqual(pushes, ['leader-2'])
})

test('接管按当前落盘记录算：晚到的那次不把工交给已被换下的会话', async () => {
  // 两次并发换人：第一次（1 → 2）的接管在记录已改成 3 之后才执行。
  const { home, projects, projectId } = await makeProject({
    retired: ['leader-1', 'leader-2'],
    leader: 'leader-3',
  })
  const workers = createWorkerRegistry({ home })
  await workers.register({ childId: 'child-1', parentSessionId: 'leader-1', name: '实现工' })
  const notifications = createNotificationStore({ home })
  await notifications.enqueue(pendingNotification('note-1', 'leader-1'))
  const calls = []
  const pushes = []
  const dispatcher = {
    reassignParent: (fromId, toId) => { calls.push([fromId, toId]); return 0 },
    async redeliverPendingFor(parentSessionId) { pushes.push(parentSessionId); return 0 },
  }
  const handover = createLeaderHandover({ projects, workers, notifications, dispatcher })

  await handover({ projectId })

  // 接手方取记录里的当前 leader，而不是调用那次写的值
  assert.equal((await workers.get('child-1')).parentSessionId, 'leader-3')
  assert.deepEqual(calls, [['leader-1', 'leader-3'], ['leader-2', 'leader-3']])
  assert.deepEqual(pushes, ['leader-3'])
})

test('项目已删除或没有退役集时什么都不做', async () => {
  const { home, projects, projectId } = await makeProject({ retired: [], leader: 'leader-1' })
  const workers = createWorkerRegistry({ home })
  const notifications = createNotificationStore({ home })
  const calls = []
  const handover = createLeaderHandover({
    projects,
    workers,
    notifications,
    dispatcher: {
      reassignParent: (fromId, toId) => { calls.push([fromId, toId]); return 0 },
      async redeliverPendingFor(parentSessionId) { calls.push(['push', parentSessionId]); return 0 },
    },
  })

  await handover({ projectId })
  assert.deepEqual(calls, [])
  // 项目不存在（并发删除）同样安静收场
  await handover({ projectId: 'missing' })
  assert.deepEqual(calls, [])
})
