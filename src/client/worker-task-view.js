/**
 * leader 任务气泡。
 *
 * 在 worker 的会话里，leader 用 `message_worker` 投进来的任务渲染成右侧、与用户
 * 自己发的消息同形的气泡：没有身份头与头像——在 worker 的会话里，leader 就是那个
 * “user”，宿主自己的用户消息也不带名字。正文始终按 Markdown 渲染，逐行写的工作面
 * （做什么 / 边界 / 验收）由 `hardBreakMarkdown` 保住换行。气泡下方一行是时间与
 * 复制按钮，与官方消息的底部 chrome 同形。
 *
 * @module dsh-leader-agent/client/worker-task-view
 */

import { createElement, useLayoutEffect, useState } from 'react'
import { ensureWorkerTaskStyles } from './worker-task-styles.js'
import { formatBubbleClock } from './bubble-clock.js'
import { hardBreakMarkdown } from '../shared/message-text.js'
import { Markdown } from './markdown.js'
import { productIcon } from './icons.js'

/**
 * 渲染 leader 任务气泡。
 *
 * @param {object} props - 组件属性
 * @param {{ data?: object }} props.node - 会话节点
 * @returns {object | null} React 元素
 */
export function WorkerTaskView({ node }) {
  const data = node?.data
  const [copied, setCopied] = useState(false)
  // 样式要在首帧绘制前进 DOM，否则气泡先按无样式铺开一帧。
  useLayoutEffect(() => { ensureWorkerTaskStyles() }, [])
  if (data === undefined) return null
  const body = typeof data.text === 'string' ? data.text : ''

  /**
   * 把任务正文复制到剪贴板。
   * @returns {Promise<void>} 复制完成
   */
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body)
    } catch {
      // 剪贴板不可用（非安全上下文或权限被拒）：静默跳过，不打断阅读。
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return createElement(
    'div',
    { className: 'dsh-leader-agent-worker-task' },
    createElement(
      'div',
      {
        className: 'dsh-leader-agent-worker-task__bubble',
        // 与宿主用户气泡同一标记，便于界面侧把这块内容当消息正文处理。
        'data-message-bubble': '',
      },
      createElement(
        'div',
        { className: 'dsh-leader-agent-worker-task__content' },
        createElement(Markdown, { source: hardBreakMarkdown(body) }),
      ),
    ),
    createElement(
      'div',
      { className: 'dsh-leader-agent-worker-task__meta' },
      createElement('span', { className: 'dsh-leader-agent-worker-task__time' }, formatBubbleClock(data.time)),
      createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-leader-agent-worker-task__copy',
          'aria-label': copied ? '已复制' : '复制',
          title: copied ? '已复制' : '复制',
          onClick: () => { void copy() },
        },
        productIcon(copied ? 'check-outline' : 'copy-outline', { size: 14 }),
      ),
    ),
  )
}
