/**
 * `spawn_worker` 工具：把任务派给一个后台 worker。
 *
 * 派工立即返回，worker 在子会话里继续跑；worker 结束时由派工与唤醒器
 * （`src/host/dispatch.js`）构造完成通知并唤醒协调者会话。因此本工具不等待结果，
 * 协调者可以在同一轮里连派多个工。
 *
 * 参数面：`name` 是 worker 的显示名（也是它的会话标题），`initialMessage` 是任务
 * 简报。派工即开跑，没有「先建会话、再单独发第一条消息」的分步。
 *
 * @module dsh-leader-kit/host/tools/spawn-worker
 */

/**
 * 创建 `spawn_worker` 工具定义。
 * @param {object} options - 工具选项
 * @param {{ dispatch: (input: object) => Promise<object> }} options.dispatcher - 派工器
 * @returns {object} dsh 工具定义
 */
export function createSpawnWorkerTool({ dispatcher }) {
  return {
    name: 'spawn_worker',
    description:
      '创建一个 worker 会话并即刻派活。工具立即返回 worker 的子会话 id，不等待结果；worker 结束后会自动唤醒你并附上完成通知与产物摘要。适合并行派多个工。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'worker 显示名，建议角色-任务短名（如 research-sources）。用作它的会话标题，侧栏与项目树里看到的就是这个名字。',
        },
        initialMessage: {
          type: 'string',
          description: '任务简报：要做什么、改哪些文件、验收标准是什么。worker 即刻开跑。',
        },
        force: {
          type: 'string',
          description: '名册到顶（未归档 worker 上限）时的逃逸理由：非空即强制新建，仅当返回的可复用候选都不适合时使用，理由进会话历史可审计。',
        },
      },
      required: ['name', 'initialMessage'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          childId: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['childId', 'status'],
      },
      render(args, value) {
        const result = /** @type {{ childId: string, name?: string, status: string }} */ (value)
        return [
          {
            type: 'text',
            text: `已派工「${result.name ?? result.childId}」，子会话 ${result.childId}。worker 结束后会自动回报，无需轮询。`,
          },
        ]
      },
    },
    async execute(args, exec) {
      const input = /** @type {{ name?: unknown, initialMessage?: unknown, force?: unknown }} */ (args)
      // 入参 schema 在运行时不生效：名字缺了会被静默换成任务正文前几个字，
      // 侧栏标题与调用方以为的对不上。
      if (typeof input.name !== 'string' || input.name.trim() === '') {
        throw new Error('spawn_worker: name 不能为空')
      }
      if (typeof input.initialMessage !== 'string' || input.initialMessage.trim() === '') {
        throw new Error('spawn_worker: initialMessage 不能为空')
      }
      // force 传非字符串会被当成没传，名册到顶时调用方以为已强制新建。
      if (input.force !== undefined && typeof input.force !== 'string') {
        throw new Error('spawn_worker: force 必须是字符串')
      }
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('spawn_worker: 需要调用方 agent 才能派工')
      }
      const record = await dispatcher.dispatch({
        parent,
        initialMessage: input.initialMessage,
        name: input.name.trim(),
        force: typeof input.force === 'string' && input.force.trim() !== '' ? input.force.trim() : undefined,
        signal: exec.signal,
      })
      return { childId: record.childId, name: record.name, status: 'dispatched' }
    },
  }
}
