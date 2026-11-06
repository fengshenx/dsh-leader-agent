/**
 * leader 任务气泡。
 *
 * 在 worker 的会话里，leader 用 `message_worker` 投进来的任务渲染成左侧气泡：身份
 * 是 leader（头像按发起会话的 id 恒定，同一个 leader 每次派活都是同一张脸），正文
 * 是任务原文，点击名字打开 leader 会话。布局与折叠在 `agent-bubble-view.js`，与
 * worker 回报气泡共用。
 *
 * @module dsh-leader-agent/client/worker-task-view
 */

import { createElement } from 'react'
import { AgentBubble } from './agent-bubble-view.js'
import { bubbleFormat } from '../shared/message-text.js'

/** 气泡上的说话方名字。leader 的会话标题没随消息落盘，这里用角色名。 */
const LEADER_NAME = 'Leader'

/**
 * 渲染 leader 任务气泡。
 *
 * @param {object} props - 组件属性
 * @param {{ data?: object }} props.node - 会话节点
 * @param {(id: string) => void} [props.openSession] - 打开会话
 * @returns {object | null} React 元素
 */
export function WorkerTaskView({ node, openSession }) {
  const data = node?.data
  if (data === undefined) return null
  return createElement(AgentBubble, {
    name: LEADER_NAME,
    // 用发起会话的 id 而不是名字做种子：多个 leader（项目切换、接续）各是各的脸，
    // 按名字做种子会让所有 leader 共用一张。
    avatarSeed: data.parentSessionId,
    openTitle: '打开发起任务的 leader 会话',
    onOpenName: () => openSession?.(data.parentSessionId),
    body: data.text,
    // 任务原文是 leader 写的正文：单行、含空行或块级标记才走 Markdown，逐行纯文本
    // （比如「做什么 / 边界 / 验收」各占一行）保持原样，不被软换行折成一段。
    format: bubbleFormat(data.text),
    time: data.time,
  })
}
