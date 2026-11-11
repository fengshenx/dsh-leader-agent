/**
 * worker 回报气泡。
 *
 * 只负责把节点状态翻成气泡属性：身份是 worker，正文是最后一次回报（没有就退回
 * 整条通知正文），点击名字打开 worker 的子会话。布局与折叠在
 * `agent-bubble-view.js`；leader 任务走右侧用户气泡，不共用这套形态。
 *
 * @module dsh-leader-agent/client/worker-report-view
 */

import { createElement } from 'react'
import { AgentBubble } from './agent-bubble-view.js'
import { workerReportBody, workerReportFormat } from '../shared/worker-report.js'

/**
 * 渲染 worker 回报气泡。
 *
 * @param {object} props - 组件属性
 * @param {{ data?: object }} props.node - 会话节点
 * @param {(id: string) => void} [props.openSession] - 打开子会话
 * @returns {object | null} React 元素
 */
export function WorkerReportView({ node, openSession }) {
  const data = node?.data
  if (data === undefined) return null
  return createElement(AgentBubble, {
    name: data.name,
    avatarSeed: data.name,
    openTitle: `打开 ${data.name} 的子会话`,
    onOpenName: () => openSession?.(data.childSessionId),
    // 旧回报缺 report，回退整条通知正文；失败原因与逐行协议字段走纯文本，
    // 判据见 workerReportFormat。
    body: workerReportBody(data),
    format: workerReportFormat(data),
    time: data.time,
  })
}
