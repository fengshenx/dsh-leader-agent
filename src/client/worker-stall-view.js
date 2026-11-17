/**
 * 后台巡查触发行。
 *
 * 一条紧凑提示：谁多久没回报、下一步做什么。点击 worker 名字打开它的会话——
 * 提醒里已经让 leader 先回看，界面上给出同一个入口，人也能一步到现场。
 *
 * 不带运行态标记：这条通知表达的是「巡查已经触发」，不是「worker 还在跑」。
 * 写成运行态会让它一直转圈，读成「继续等」。
 *
 * @module dsh-leader-agent/client/worker-stall-view
 */

import { createElement, useEffect } from 'react'
import { formatBubbleClock } from './bubble-clock.js'
import { productIcon } from './icons.js'
import { ensureWorkerStallStyles } from './worker-stall-styles.js'
import { workerStallBody } from '../shared/worker-stall.js'

/**
 * 渲染后台巡查触发行。
 *
 * @param {object} props - 组件属性
 * @param {{ data?: object }} props.node - 会话节点
 * @param {(id: string) => void} [props.openSession] - 打开 worker 会话
 * @returns {object | null} React 元素
 */
export function WorkerStallView({ node, openSession }) {
  useEffect(() => { ensureWorkerStallStyles() }, [])
  const data = node?.data
  if (data === undefined) return null
  return createElement(
    'div',
    { className: 'dsh-leader-agent-stall-notice' },
    createElement(
      'div',
      { className: 'dsh-leader-agent-stall-notice__head' },
      createElement(
        'span',
        { className: 'dsh-leader-agent-stall-notice__icon' },
        productIcon('refresh-outline', { size: 14 }),
      ),
      createElement('span', { className: 'dsh-leader-agent-stall-notice__badge' }, '后台巡查 · 已触发'),
      createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-leader-agent-stall-notice__name',
          title: `打开 ${data.name} 的会话`,
          onClick: () => openSession?.(data.childSessionId),
        },
        data.name,
      ),
      createElement(
        'span',
        { className: 'dsh-leader-agent-stall-notice__time' },
        formatBubbleClock(data.time),
      ),
    ),
    createElement(
      'div',
      { className: 'dsh-leader-agent-stall-notice__body' },
      workerStallBody(data),
    ),
  )
}
