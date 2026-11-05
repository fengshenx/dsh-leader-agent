/**
 * 会话完成提醒投影。
 *
 * 宿主侧栏的会话行有「完成未读」绿点：会话从执行中转为空闲、且用户没在看它时
 * 点亮，打开后熄灭。该状态是宿主 ui-session 的进程本地投影（不落盘），不在任何
 * 对插件公开的服务上；项目面板要给项目树里的会话行补同款绿点，只能照同一套
 * 语义自行推导。
 *
 * 语义对齐宿主 reconcileStatus 的快照路径（packages/client/ui-session）：
 * - 首见的会话只登记运行态，不标记完成——否则面板一挂载，所有历史已完成的
 *   会话都亮绿点；
 * - 运行态 true→false 的跳变、且它不是主视图会话时标记完成未读；
 * - 主视图会话（`retainedBy.mainView` 计数大于 0，即用户正打开着它）不标记，
 *   已标记的在打开后清除；
 * - 列表 phase 为 ready 后，从快照里消失的会话清掉登记与标记；ready 之前
 *   byId 可能暂时为空，不能误清。
 *
 * 宿主另有一条运行态事件路径会在列表基线未建立（phase 为 pending）时把首见的
 * 空闲会话也算完成未读；本模块只消费列表快照，无从观察基线之前的事件，该分支
 * 不适用。
 *
 * @module dsh-leader-agent/client/session-completion
 */

/**
 * 会话行是否被主视图打开；与宿主 isMain 同判据。
 *
 * @param {object | undefined} row - 会话行
 * @returns {boolean} 是否主视图会话
 */
function isMainView(row) {
  return (row?.retainedBy?.mainView ?? 0) > 0
}

/**
 * 造一个完成提醒投影。
 *
 * @returns {{update: (snapshot: object) => Set<string>}} 投影：`update` 喂入
 *   `sessions.list` 快照，返回完成未读的会话 id 集合（同一实例，调用方只读）
 */
export function createSessionCompletionTracker() {
  /** @type {Map<string, boolean>} 各会话上一次快照的运行态；没有记录表示首见。 */
  const running = new Map()
  /** @type {Set<string>} 完成未读的会话 id。 */
  const unread = new Set()

  return {
    /**
     * 喂入一次会话列表快照并重算完成未读集合。
     *
     * @param {object} snapshot - `sessions.list` 快照（`ids` / `byId` / `phase`）
     * @returns {Set<string>} 完成未读的会话 id 集合
     */
    update(snapshot) {
      const byId = snapshot?.byId ?? {}
      // 迭代 `ids` 与宿主 reconcileStatus 对齐：subagent catalog / retained
      // subagent fallback 行只在 byId 里，不在 ids 里，不建立完成投影。
      for (const id of snapshot?.ids ?? Object.keys(byId)) {
        const row = byId[id]
        if (row === undefined) continue
        const next = row.running === true
        const previous = running.get(id)
        if (previous === undefined) {
          running.set(id, next)
        } else if (previous !== next) {
          running.set(id, next)
          if (next) unread.delete(id)
          else if (!isMainView(row)) unread.add(id)
        }
      }
      // 用户打开着的会话视为已读：绿点的语义是「完成了还没人看」，切走它不构成
      // 一次新的完成跳变，不该重新点亮。与宿主一样按完整 byId 清（不只 ids）。
      for (const [id, row] of Object.entries(byId)) {
        if (isMainView(row)) unread.delete(id)
      }
      if (snapshot?.phase === 'ready') {
        // 迭代中删除已访问项是 Map 允许的；快照可能不带 phase（旧版宿主），
        // 视同 ready 之外的阶段，不做消失清理。
        for (const id of running.keys()) {
          if (!Object.hasOwn(byId, id)) {
            running.delete(id)
            unread.delete(id)
          }
        }
      }
      return unread
    },
  }
}
