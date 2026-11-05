/**
 * `message_worker` 工具：给已派出的 worker 发后续消息。
 *
 * 投递走 `src/host/worker-sessions.js`：worker 的会话还在内存里就直接 `steer`
 * 投进它的当前轮次（下一步注入，空闲即开工）；进程重启后会话不在内存，先
 * `agents.resume` 冷恢复再从持久化日志接着跑，带完整上下文。结束后的完成通知与
 * 第一轮同源同格式（`src/host/dispatch.js`）。
 *
 * 参数面：`sessionId` 寻址目标 worker，`message` 是消息正文，可选 `rename` 与投递
 * 同次改名。不复用宿主全局的 `send_message` 工具：它只认宿主 subagent 体系的子
 * 会话，我们的 worker 是普通根会话，调它拿不到目标。
 *
 * @module dsh-leader-agent/host/tools/message-worker
 */

/**
 * 创建 `message_worker` 工具定义。
 * @param {object} options - 工具选项
 * @param {{ message: (input: object) => Promise<{ code: string, name: string }> }} options.dispatcher - 派工器
 * @returns {object} dsh 工具定义
 */
export function createMessageWorkerTool({ dispatcher }) {
  return {
    name: 'message_worker',
    description:
      '给一个已派出的 worker 发后续消息：追问结果、补充要求或返工指示。worker 正在跑时消息会在它的下一步注入当前轮次，空闲时立刻开工；它结束后会自动唤醒你并附上完成通知与产物摘要。可顺手改名。目标 worker 挂着未完成的卡时只能同卡续跑（带 cardId）；要让它接新任务，先把那张卡标 done 或归档（槽位会自动释放）。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '目标 worker 的会话 id，来自 spawn_worker 的返回值或完成通知里的子会话。',
        },
        message: {
          type: 'string',
          description: '发给 worker 的消息正文，自包含、说清要它接着做什么。',
        },
        rename: {
          type: 'string',
          description: '可选：顺手给 worker 改名（如 research-sources → write-summary），体现它的新角色，与投递同次完成。',
        },
        cardId: {
          type: 'string',
          description: '可选：本次任务所属卡 id。目标 worker 挂着未完成的卡时必填且必须等于它挂的卡——同卡续跑的显式声明；卡已完成或未挂卡时可省略。',
        },
      },
      required: ['sessionId', 'message'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['sessionId', 'status'],
      },
      render(args, value) {
        const result = /** @type {{ sessionId: string, name?: string, status: string }} */ (value)
        if (result.status === 'merged') {
          return [
            {
              type: 'text',
              text: `worker「${result.name ?? result.sessionId}」在跑或刚开工：消息已投进它的当前轮次，下一步生效，随本轮执行一并回报。`,
            },
          ]
        }
        return [
          {
            type: 'text',
            text: `已把消息发给 worker「${result.name ?? result.sessionId}」（子会话 ${result.sessionId}），它开始执行后会自动回报。`,
          },
        ]
      },
    },
    async execute(args, exec) {
      const input = /** @type {{ sessionId?: unknown, message?: unknown, rename?: unknown, cardId?: unknown }} */ (args)
      if (typeof input.sessionId !== 'string' || input.sessionId.trim() === '') {
        throw new Error('message_worker: sessionId 不能为空')
      }
      if (typeof input.message !== 'string' || input.message.trim() === '') {
        throw new Error('message_worker: message 不能为空')
      }
      // 入参 schema 在运行时不生效：rename 传非字符串会被当成没传，调用方以为改了名。
      if (input.rename !== undefined && typeof input.rename !== 'string') {
        throw new Error('message_worker: rename 必须是字符串')
      }
      // cardId 同理：传错了会被当没声明，门禁拒绝时调用方还以为是别的原因。
      if (input.cardId !== undefined && typeof input.cardId !== 'string') {
        throw new Error('message_worker: cardId 必须是字符串')
      }
      const rename = typeof input.rename === 'string' && input.rename.trim() !== ''
        ? input.rename.trim()
        : undefined
      const cardId = typeof input.cardId === 'string' && input.cardId.trim() !== ''
        ? input.cardId.trim()
        : undefined
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('message_worker: 需要调用方 agent 才能给 worker 发消息')
      }
      const sessionId = input.sessionId.trim()
      const result = await dispatcher.message({
        parent,
        sessionId,
        message: input.message,
        name: rename,
        cardId,
        signal: exec.signal,
      })
      return { sessionId, name: result.name, status: result.code }
    },
  }
}
