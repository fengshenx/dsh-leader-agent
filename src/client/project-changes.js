/**
 * 项目变更广播。
 *
 * 左栏项目区块增删改项目之后，右栏「看板」入口要重新判定可见性：入口只在挂载、
 * 换会话、通道就绪与窗口聚焦时判定，同窗口里注销项目或换 leader 之后不通知，
 * 留下的是一枚点开说「不属于任何项目」的胶囊。
 *
 * 不用 `ready-signal.js`：那是「就绪一次」的信号，重复标记是 no-op，而项目可以
 * 反复增删。
 *
 * @module dsh-leader-agent/client/project-changes
 */

/** @type {Set<() => void>} 变更订阅者 */
const listeners = new Set()

/**
 * 订阅项目变更。
 *
 * @param {() => void} listener - 回调
 * @returns {() => void} 退订函数
 */
export function onProjectsChanged(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 通知项目有变（增删改、换 leader）。
 *
 * 单个订阅者抛错不能带走其余订阅者：订阅者之一在主区域渲染链上，打断循环等于
 * 让别人永久错过这次变更。逐个隔离并大声报错，不静默吞掉。
 *
 * @returns {void}
 */
export function notifyProjectsChanged() {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error('dsh-leader-agent: 项目变更订阅回调抛错', error)
    }
  }
}
