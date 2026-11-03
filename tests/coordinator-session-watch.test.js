import assert from 'node:assert/strict'
import { test } from 'node:test'
import { coordinatorSessionIndex, watchCoordinatorSessions } from '../src/client/coordinator-session-index.js'
import { notifyProjectsChanged } from '../src/client/project-changes.js'
import { mountProjectRemote } from '../src/client/project-remote.js'

const flush = () => new Promise((resolve) => { setTimeout(resolve, 0) })

/**
 * 一条用例一套假件。
 *
 * window 的监听表按 type 存 listener 集合、按 listener 精确移除：单槽 Map 加
 * 忽略 listener 参数的 `removeEventListener(type)` 会把重复订阅与错移除都掩盖
 * 成「清理成功了」。
 *
 * @param {object[]} projects - 项目列表真源；测试里改它模拟宿主侧增删项目
 * @param {{ listError?: Error }} [options] - 让 `projects/list` 抛错，覆盖告警分支
 * @returns {object} 假 ctx、RPC 计数、告警与卸载入口
 */
function setup(projects, { listError } = {}) {
  /** @type {Map<string, Set<Function>>} */
  const windowListeners = new Map()
  globalThis.window = {
    addEventListener(type, listener) {
      const set = windowListeners.get(type) ?? new Set()
      windowListeners.set(type, set)
      set.add(listener)
    },
    removeEventListener(type, listener) {
      windowListeners.get(type)?.delete(listener)
    },
  }
  let listCalls = 0
  const warnings = []
  const disposals = []
  const ctx = {
    get(name) {
      if (name === 'remote') return { $mount: async () => {} }
      if (name === 'remote.projects') {
        return {
          list: async () => {
            listCalls += 1
            if (listError !== undefined) throw listError
            return { ok: true, value: projects }
          },
        }
      }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposals.push(dispose)
      return dispose ?? (() => {})
    },
    logger: { warn(message) { warnings.push(message) } },
  }
  return {
    ctx,
    warnings,
    listCalls: () => listCalls,
    focusListeners: () => windowListeners.get('focus')?.size ?? 0,
    dispose: () => { for (const dispose of disposals) dispose() },
  }
}

test('协调者会话名单：通道就绪后按项目列表填充', async () => {
  const projects = [{ id: 'p-1', coordinatorSessionId: 's-1' }]
  const env = setup(projects)
  coordinatorSessionIndex.update([])
  await mountProjectRemote(env.ctx)
  watchCoordinatorSessions(env.ctx)
  await flush()
  assert.deepEqual([...coordinatorSessionIndex.getSnapshot()], ['s-1'])
  env.dispose()
  assert.equal(env.focusListeners(), 0)
})

test('同窗口新建项目后名单跟着刷新——否则协调者会话退回居中的欢迎页', async () => {
  const projects = [{ id: 'p-1', coordinatorSessionId: 's-1' }]
  const env = setup(projects)
  coordinatorSessionIndex.update([])
  await mountProjectRemote(env.ctx)
  watchCoordinatorSessions(env.ctx)
  await flush()
  assert.deepEqual([...coordinatorSessionIndex.getSnapshot()], ['s-1'])

  projects.push({ id: 'p-2', coordinatorSessionId: 's-2' })
  notifyProjectsChanged()
  await flush()
  assert.deepEqual([...coordinatorSessionIndex.getSnapshot()].sort(), ['s-1', 's-2'])
  env.dispose()
})

test('卸载后三条订阅都退订：通道就绪与项目广播不再触发名单刷新', async () => {
  const projects = [{ id: 'p-1', coordinatorSessionId: 's-1' }]
  const env = setup(projects)
  coordinatorSessionIndex.update([])
  await mountProjectRemote(env.ctx)
  watchCoordinatorSessions(env.ctx)
  await flush()
  const calls = env.listCalls()
  env.dispose()

  notifyProjectsChanged()
  // 远程服务重注册会再发一次通道就绪通知；旧的订阅者不该还在名单上。
  await mountProjectRemote(env.ctx)
  await flush()
  assert.equal(env.listCalls(), calls)
})

test('拉名单失败时只告警：未处理的 rejection 会打穿插件的订阅链', async () => {
  const env = setup([], { listError: new Error('gateway/internal') })
  coordinatorSessionIndex.update([])
  await mountProjectRemote(env.ctx)
  watchCoordinatorSessions(env.ctx)
  await flush()

  assert.equal(env.warnings.length, 1)
  assert.match(env.warnings[0], /读取协调者会话名单失败/)
  assert.match(env.warnings[0], /gateway\/internal/)
  env.dispose()
})
