/**
 * 换 leader 之后的接管：派工归属与未投递的完成通知一起改投新 leader。
 *
 * 「新会话立刻接手项目」（`LEADER.md`）不只是换项目记录里的一条指针。worker
 * 登记表与通知队列都以**父会话 id** 归属，只改指针的话，原班 worker 谁的父会话都
 * 对不上：退役会话被身份闸挡住，新 leader 被父会话校验挡住——两边的投递都落空，
 * 那批工既交不出去也接不回来。
 *
 * 三处一起改，按「先落盘归属、后内存态」的顺序：
 *
 * - `worker-registry`：记录的 `parentSessionId` 改成接手方，`reassignedFrom` 留痕；
 * - `notification-store`：只改未投递的通知，已投出的是旧会话的历史；
 * - 派工器：等待表、续行计数与在飞记录里的父会话一并改绑（见 `dispatch` 的
 *   `reassignParent`），改投过来的通知再推一次投递——新会话建出来时的
 *   `agent/created` 早于这次迁移，那一刻队列里还没有它的事。
 *
 * 接手方与退役集都取**当前落盘记录**，不取调用方那次写的值：两个客户端并发换人
 * 时，先完成的那次接管可能会在记录已经改成第三个人之后才执行，按自己那次的值改
 * 就会把工交回一个已经被换下的会话。按当前记录算则每次都朝最新值收敛（与索引
 * 对齐同一个道理）。
 *
 * @module dsh-leader-agent/host/leader-handover
 */

/**
 * 创建接管动作。
 *
 * @param {object} options - 依赖
 * @param {{ get: (id: string) => Promise<object | undefined> }} options.projects - 项目注册表（读当前记录）
 * @param {{ reassignParent: (fromId: string, toId: string) => Promise<string[]> }} options.workers - worker 登记表
 * @param {{ reassignParent: (fromId: string, toId: string) => Promise<number> }} options.notifications - 通知落盘队列
 * @param {{ reassignParent: (fromId: string, toId: string) => number,
 *   redeliverPendingFor: (parentSessionId: string) => Promise<number> }} options.dispatcher - 派工器
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {(change: { projectId: string }) => Promise<void>} 接管动作
 */
export function createLeaderHandover({ projects, workers, notifications, dispatcher, logger = () => {} }) {
  return async function handover({ projectId }) {
    const project = await projects.get(projectId)
    if (project === undefined) return
    const target = project.leaderSessionId
    if (typeof target !== 'string' || target === '') return
    const retired = Array.isArray(project.retiredLeaderSessionIds)
      ? project.retiredLeaderSessionIds
      : []
    let moved = 0
    // 遍历**全部**退役 id 而不是只迁本轮换下的那个：改绑幂等，重复调用只会命中
    // 还挂在旧会话上的记录，顺带补上早先一次漏迁留下的孤儿。
    for (const retiredId of retired) {
      if (retiredId === target) continue
      const workerIds = await workers.reassignParent(retiredId, target)
      const notificationCount = await notifications.reassignParent(retiredId, target)
      const inflightCount = dispatcher.reassignParent(retiredId, target)
      moved += workerIds.length + notificationCount + inflightCount
      if (workerIds.length === 0 && notificationCount === 0 && inflightCount === 0) continue
      logger(
        `dsh-leader-agent: 项目 ${projectId} 的 leader 换到 ${target}：`
        + `接管 ${workerIds.length} 条派工记录、${notificationCount} 条待投通知、${inflightCount} 条在飞派工`,
      )
    }
    // 改投过来的通知得有人推一把：新会话建出来时的 `agent/created` 早于这次迁移，
    // 那一刻队列里还没有它的事，不推的话它们会一直躺在盘上。
    if (moved > 0) await dispatcher.redeliverPendingFor(target)
  }
}
