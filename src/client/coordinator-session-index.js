/**
 * 协调者会话索引与名单刷新。
 *
 * 索引是「哪些会话属于某个项目」的唯一名单：主区域入口用它决定是否把会话顶进
 * active 形态，填充则独立于项目面板——侧栏收起时面板会卸载，名单不能跟着空。
 *
 * 与视图注册分开成两个模块：这里不碰 React，名单刷新可以单独单测；`coordinator-view.js`
 * 只负责视图目标与主区域入口。
 *
 * @module dsh-leader-kit/client/coordinator-session-index
 */

import {
  collectCoordinatorSessionIds,
  createCoordinatorSessionIndex,
} from './coordinator-view-logic.js'
import { callProjectRemote, onProjectRemoteReady } from './project-remote.js'
import { onProjectsChanged } from './project-changes.js'

/** 协调者会话 id 索引。 */
export const coordinatorSessionIndex = createCoordinatorSessionIndex()

/**
 * 把项目里的协调者会话写进索引。
 *
 * 通道就绪后补拉，窗口重新获得焦点时再拉一次（项目可能在另一个窗口里被增删）。
 * 同窗口里新建项目或换协调者也要跟着刷：用户建完项目立刻点开，名单里没有新
 * 会话，输入框会停在居中的欢迎页。
 *
 * @param {object} ctx - 客户端 Cordis 上下文
 * @returns {void}
 */
export function watchCoordinatorSessions(ctx) {
  const refresh = async () => {
    try {
      const projects = await callProjectRemote(ctx, 'list', [])
      coordinatorSessionIndex.update(collectCoordinatorSessionIds(projects))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`dsh-leader-kit: 读取协调者会话名单失败：${message}`)
    }
  }
  // 三条订阅都要退订：remote 服务重新注册会让 fiber 重建，漏一条就永久累积，
  // 每次通道就绪多打一次 `projects/list`，闭包还攥着已销毁的 ctx。
  const stopReady = onProjectRemoteReady(() => { void refresh() })
  const onFocus = () => { void refresh() }
  window.addEventListener('focus', onFocus)
  const stopChanges = onProjectsChanged(() => { void refresh() })
  ctx.effect(() => () => {
    stopReady()
    stopChanges()
    window.removeEventListener('focus', onFocus)
  })
}
