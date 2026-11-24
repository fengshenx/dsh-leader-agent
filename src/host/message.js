/**
 * 本地构造 dsh 的用户消息。
 *
 * dsh 的 `createUserMessage` 在 `@deepseek-ai/dsh-llm` 里，属于 dsh 内部包。本 bundle
 * 刻意不 peer 依赖任何 dsh 内部包（宿主版本漂移会让带 peer 的 bundle 周期性失效），
 * 因此按 dsh 的消息契约就地构造等价对象：`id` 是随机 UUID，`source` 默认取
 * `{ kind: 'user' }`。
 *
 * @module dsh-leader-agent/host/message
 */

import { randomUUID } from 'node:crypto'

/**
 * 构造一条 dsh 用户消息。
 *
 * `source` 默认是真人输入；worker 回报走自己的 source kind，客户端据此换渲染
 * 形态（见 `shared/worker-report.js`）。
 *
 * `id` 可以由调用方预生成：投递方要在消息进入 worker 之前就把它记在在飞表里，
 * 结算才能按「这一轮消费的到底是哪条消息」判归属。
 *
 * @param {Array<{ type: string, [key: string]: unknown }>} content - 模型可见内容块
 * @param {{ kind: string, [key: string]: unknown }} [source] - 消息来源
 * @param {string} [id] - 预生成的消息 id；缺省随机 UUID
 * @returns {{ id: string, role: 'user', content: unknown[], source: { kind: string } }} 消息
 */
export function createUserMessage(content, source = { kind: 'user' }, id = randomUUID()) {
  return Object.freeze({
    id,
    role: 'user',
    content,
    source,
  })
}
