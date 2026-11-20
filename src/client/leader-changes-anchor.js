/**
 * leader 改动文件卡片隐藏的挂载点。
 *
 * 不渲染内容，只借 `shell.overlay` 的 React 生命周期订阅会话快照与 leader 名单；
 * 判定变化时在主面板容器上加/摘标记（判定与样式在 `leader-changes.js`）。宿主
 * 重渲染换掉主面板节点时用 MutationObserver 补回，与标签栏同一节流口径。
 *
 * @module dsh-leader-agent/client/leader-changes-anchor
 */

import { useEffect, useState } from 'react'
import {
  applyHideState,
  ensureLeaderChangesStyles,
  HIDE_ATTR,
  isLeaderSession,
} from './leader-changes.js'
import { leaderSessionIndex } from './leader-session-index.js'
import { findColumn, findMainSlot } from './main-panel.js'
import { currentSessionIdOf } from './project-panel-logic.js'

/**
 * 隐藏标记的挂载点。
 *
 * @param {object} props - 槽位注入的运行时能力
 * @param {() => object | undefined} props.getSessions - 取宿主的会话快照服务
 * @returns {null} 不渲染内容
 */
export function LeaderChangesAnchor({ getSessions }) {
  const sessions = getSessions?.()
  const [snapshot, setSnapshot] = useState(() => sessions?.list?.getSnapshot?.() ?? {
    phase: 'pending',
    ids: [],
    byId: {},
  })
  const [leaderIds, setLeaderIds] = useState(() => leaderSessionIndex.getSnapshot())

  useEffect(() => {
    if (typeof sessions?.list?.subscribe !== 'function') return undefined
    const sync = () => setSnapshot(sessions.list.getSnapshot())
    sync()
    return sessions.list.subscribe(sync)
  }, [sessions])

  // 订阅即刻回调一次当前名单，接通时不会停在空集上。
  useEffect(() => leaderSessionIndex.subscribe(setLeaderIds), [])

  const currentSessionId = currentSessionIdOf(snapshot.byId)
  const hide = isLeaderSession(leaderIds, currentSessionId)

  useEffect(() => {
    ensureLeaderChangesStyles()
    let column = null
    let scheduled = false
    let timer = null
    let alive = true

    const apply = () => {
      if (!alive) return
      const slot = findMainSlot()
      if (slot === null) return
      const next = findColumn(slot)
      if (next !== column) {
        column?.removeAttribute(HIDE_ATTR)
        column = next
      }
      applyHideState(column, hide)
    }
    apply()

    // 宿主换掉主面板节点后标记会丢；只有隐藏状态成立时才值得持续观察。
    const observer = hide && typeof document !== 'undefined' && document.body !== null
      ? new MutationObserver(() => {
        if (scheduled) return
        scheduled = true
        timer = setTimeout(() => {
          scheduled = false
          apply()
        }, 16)
      })
      : null
    observer?.observe(document.body, { childList: true, subtree: true })

    return () => {
      alive = false
      observer?.disconnect()
      if (timer !== null) clearTimeout(timer)
      column?.removeAttribute(HIDE_ATTR)
    }
  }, [hide])

  return null
}
