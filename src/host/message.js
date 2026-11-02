/**
 * 本地构造 dsh 的用户消息。
 *
 * dsh 的 `createUserMessage` 在 `@deepseek-ai/dsh-llm` 里，属于 dsh 内部包。本 bundle
 * 刻意不 peer 依赖任何 dsh 内部包（宿主版本漂移会让带 peer 的 bundle 周期性失效），
 * 因此按 dsh 的消息契约就地构造等价对象：`id` 是随机 UUID，`source` 默认取
 * `{ kind: 'user' }`。
 *
 * @module dsh-leader-kit/host/message
 */

import { randomUUID } from 'node:crypto'

/**
 * 协调者投递任务消息的 source kind。
 *
 * 读侧（`worker-transcript`）靠它把任务正文与宿主注入的上下文区分开：两者都是
 * `user/message`，只有 `source.kind` 不同。
 */
export const WORKER_TASK_SOURCE_KIND = 'dsh-leader-kit/worker-task'

/**
 * 构造一条 dsh 用户消息。
 *
 * `source` 默认是真人输入；worker 回报走自己的 source kind，客户端据此换渲染
 * 形态（见 `shared/worker-report.js`）。
 *
 * @param {Array<{ type: string, [key: string]: unknown }>} content - 模型可见内容块
 * @param {{ kind: string, [key: string]: unknown }} [source] - 消息来源
 * @returns {{ id: string, role: 'user', content: unknown[], source: { kind: string } }} 消息
 */
export function createUserMessage(content, source = { kind: 'user' }) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content,
    source,
  })
}

/**
 * 把内容块数组折成纯文本，供通知正文与 worker 回报共用。
 * @param {Array<{ type?: string, text?: string }>} blocks - 内容块数组
 * @param {string} [separator] - 块间分隔符。通知正文用默认的 `\n`；
 *   `buildWorkerReport` 生成的 `report` 会随通知落盘、交给 Markdown 渲染，多块传
 *   `\n\n`（单个 `\n` 是软换行，多个块会被折成一段）
 * @returns {string} 拼接后的文本
 */
export function blocksToText(blocks, separator = '\n') {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(separator)
    .trim()
}
