/**
 * `read_worker_session` 工具：读一个 worker 会话最近的回合内容。
 *
 * 完成通知只给「这一轮结束了、产物是什么」；排障要看的是过程——中间调了哪些
 * 工具、哪一步失败。这条路直接读宿主的会话日志（`sessionQuery.readSession()`），
 * 不唤醒 worker、不产生模型调用。降级方案是 `message_worker` 追问，那会多开一轮。
 *
 * @module dsh-leader-agent/host/tools/read-worker
 */

/** 默认回看的回合数。 */
const DEFAULT_TURNS = 2
/** 一次最多回看的回合数：再多也不是「回看」，而是导出整个会话。 */
const MAX_TURNS = 20

/**
 * 创建 `read_worker_session` 工具定义。
 * @param {object} options - 工具选项
 * @param {{ transcript: (input: object) => Promise<object> }} options.dispatcher - 派工器
 * @returns {object} dsh 工具定义
 */
export function createReadWorkerTool({ dispatcher }) {
  return {
    name: 'read_worker_session',
    description:
      '读一个已派出 worker 的会话回合：它的任务正文、说过的正文、调过哪些工具、哪一步失败与原因，以及每轮的终态。只读、不唤醒 worker、不产生模型调用，worker 正在跑也能读（读到的是当前已落盘的部分）。完成通知只给产物摘要，需要回看过程或排查失败时用它。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '目标 worker 的会话 id，来自 spawn_worker 的返回值或完成通知里的子会话。',
        },
        turns: {
          type: 'number',
          description: `可选：回看最近几个回合，默认 ${DEFAULT_TURNS}，上限 ${MAX_TURNS}。工具调用只列名字与失败原因，正文按条截断。`,
        },
      },
      required: ['sessionId'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          name: { type: 'string' },
          totalTurns: { type: 'number' },
          running: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['sessionId', 'name', 'totalTurns', 'running', 'text'],
      },
      render(args, value) {
        const result = /** @type {{ text: string }} */ (value)
        return [{ type: 'text', text: result.text }]
      },
    },
    async execute(args, exec) {
      const input = /** @type {{ sessionId?: unknown, turns?: unknown }} */ (args)
      if (typeof input.sessionId !== 'string' || input.sessionId.trim() === '') {
        throw new Error('read_worker_session: sessionId 不能为空')
      }
      // 入参 schema 在运行时不生效：turns 传成字符串会被 Number() 吞掉，
      // 调用方以为限了量、实际用了默认值。
      let turns = DEFAULT_TURNS
      if (input.turns !== undefined) {
        if (typeof input.turns !== 'number' || !Number.isInteger(input.turns)
          || input.turns < 1 || input.turns > MAX_TURNS) {
          throw new Error(`read_worker_session: turns 必须是 1 到 ${MAX_TURNS} 的整数`)
        }
        turns = input.turns
      }
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('read_worker_session: 需要调用方 agent 才能读 worker 的会话')
      }
      return await dispatcher.transcript({
        parent,
        sessionId: input.sessionId.trim(),
        turns,
      })
    },
  }
}
