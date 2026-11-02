import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coordinatorSessionIndex, watchCoordinatorSessions } from '../src/client/coordinator-session-index.js'
import { notifyProjectsChanged } from '../src/client/project-changes.js'
import { mountProjectRemote } from '../src/client/project-remote.js'

/** 项目列表的真源；测试里改它模拟宿主侧增删项目。 */
const projects = []
const windowListeners = new Map()

globalThis.window = {
  addEventListener(type, listener) { windowListeners.set(type, listener) },
  removeEventListener(type) { windowListeners.delete(type) },
}

const ctx = {
  get(name) {
    if (name === 'remote') return { $mount: async () => {} }
    if (name === 'remote.projects') return { list: async () => ({ ok: true, value: projects }) }
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  logger: { warn() {} },
}

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0) })

test('协调者会话名单：通道就绪后按项目列表填充', async () => {
  projects.push({ id: 'p-1', coordinatorSessionId: 's-1' })
  await mountProjectRemote(ctx)
  watchCoordinatorSessions(ctx)
  await flush()
  assert.deepEqual([...coordinatorSessionIndex.getSnapshot()], ['s-1'])
})

test('同窗口新建项目后名单跟着刷新——否则协调者会话退回居中的欢迎页', async () => {
  projects.push({ id: 'p-2', coordinatorSessionId: 's-2' })
  notifyProjectsChanged()
  await flush()
  assert.deepEqual([...coordinatorSessionIndex.getSnapshot()].sort(), ['s-1', 's-2'])
})
