/**
 * `spawn_worker` 工具：建一个后台 worker 会话，但**不开工**。
 *
 * 分成两步是为了让绑定先落盘：建会话时可以把卡片槽位直接绑到它身上，协调者
 * 随后用 `message_worker` 投递的第一条消息，请求组装时就已经带着角色槽位与
 * 卡片事实。若在这里直接投递任务，角色与卡片上下文只能晚一次模型请求才出现。
 *
 * 建会话本身不产生模型调用；worker 结束一轮后仍由派工与唤醒器
 * （`src/host/dispatch.js`）构造完成通知并唤醒协调者会话。
 *
 * @module dsh-leader-kit/host/tools/spawn-worker
 */

import { isValidSlotName } from '../slots/slot-templates.js'

/**
 * 把继承到的权限写成给协调者看的一行（多行时按行拼）。
 *
 * worker 的输入来自项目文件、issue 与 PR 正文这类外部内容；继承到完全权限、
 * 无审批时，prompt injection 直接等于任意代码执行。派工这一刻必须让用户看见，
 * 才有机会否决。
 *
 * @param {object | undefined} permission - `inheritPermission()` 的返回值
 * @returns {string | undefined} 文案；组合里没有权限旋钮时 undefined
 */
function describePermission(permission) {
  if (permission === undefined) return undefined
  const sandbox = permission.sandbox ?? '未知沙箱模式'
  const approval = permission.approval ?? '未知审批策略'
  const lines = []
  if (permission.preset === 'auto') {
    lines.push('权限：自动审查（auto）——无沙箱，每次工具调用先经自动审查。')
  } else if (sandbox === 'danger-full-access' && approval === 'never') {
    lines.push('权限：完全访问、无审批——它能读写工作区外的文件并执行任意命令，不会向你请求确认。')
  } else {
    lines.push(`权限：沙箱 ${sandbox}、审批 ${approval}。`)
  }
  if (permission.skipped.length > 0) {
    lines.push(`权限未完整继承：${permission.skipped.map((item) => `${item.knob}（${item.reason}）`).join('、')}。`)
  }
  return lines.join('\n')
}


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
      '创建一个 worker 会话并返回子会话 id，但 worker 不会立刻开工：用 message_worker 投递第一条消息时才开始跑。可选把卡片的某个槽位绑到它身上（cardId + slot），绑好后第一条消息的请求就带着角色槽位与卡片事实。适合并行派多个工。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'worker 显示名，建议角色-任务短名（如 research-sources）。用作它的会话标题，侧栏与项目树里看到的就是这个名字。',
        },
        cardId: {
          type: 'string',
          description: '可选：要绑定的卡片 id，必须是本项目（调用方所属项目）的卡片且状态为 active；必须与 slot 一起给。绑好后 worker 每轮都能看到该卡的事实（规格、链接、revision）。',
        },
        slot: {
          type: 'string',
          description: '可选：卡片上的槽位名，与项目 SLOTS.md 的 `## <槽位名>` 一致（小写 ASCII 机器标识）。必须与 cardId 一起给。',
        },
        force: {
          type: 'string',
          description: '名册到顶（未归档 worker 上限）时的逃逸理由：非空即强制新建，仅当返回的可复用候选都不适合时使用，理由进会话历史可审计。',
        },
      },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          childId: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string' },
          permission: {
            type: 'object',
            properties: {
              sandbox: { type: 'string' },
              approval: { type: 'string' },
              preset: { type: 'string' },
              skipped: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    knob: { type: 'string' },
                    reason: { type: 'string' },
                  },
                  required: ['knob', 'reason'],
                },
              },
            },
            required: ['skipped'],
          },
        },
        required: ['childId', 'status'],
      },
      render(args, value) {
        const result = /** @type {{ childId: string, name?: string, status: string, permission?: object }} */ (value)
        const permission = describePermission(result.permission)
        return [
          {
            type: 'text',
            text: [
              `已建 worker「${result.name ?? result.childId}」（子会话 ${result.childId}），尚未开工。用 message_worker 投递任务正文；worker 开工时自动获得挂卡事实、之后卡片变化会同步过来，不用在消息里抄 spec。`,
              ...permission === undefined ? [] : [permission],
            ].join('\n'),
          },
        ]
      },
    },
    async execute(args, exec) {
      const input = /** @type {{ name?: unknown, cardId?: unknown, slot?: unknown, force?: unknown, initialMessage?: unknown }} */ (args)
      // 入参 schema 在运行时不生效：名字缺了会被静默换成任务正文前几个字，
      // 侧栏标题与调用方以为的对不上。
      if (typeof input.name !== 'string' || input.name.trim() === '') {
        throw new Error('spawn_worker: name 不能为空')
      }
      // 旧调用还带着任务正文：收下会让人以为已经开工，实际 worker 在等消息。
      if (input.initialMessage !== undefined) {
        throw new Error('spawn_worker: initialMessage 已移除——worker 建好后用 message_worker 投递任务正文')
      }
      if (input.cardId !== undefined && (typeof input.cardId !== 'string' || input.cardId.trim() === '')) {
        throw new Error('spawn_worker: cardId 必须是非空字符串')
      }
      if (input.slot !== undefined && (typeof input.slot !== 'string' || input.slot.trim() === '')) {
        throw new Error('spawn_worker: slot 必须是非空字符串')
      }
      // 只给一半会让调用方以为绑上了，实际什么都没写。
      if ((input.cardId === undefined) !== (input.slot === undefined)) {
        throw new Error('spawn_worker: cardId 与 slot 必须成对传入（要绑卡就两者都给，不绑就都不给）')
      }
      if (input.slot !== undefined && !isValidSlotName(input.slot.trim())) {
        throw new Error(`spawn_worker: 槽位名 ${JSON.stringify(input.slot)} 不合法（只允许小写 ASCII 字母、数字、下划线、连字符，最长 32 字符）`)
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
        name: input.name.trim(),
        ...input.cardId === undefined ? {} : { cardId: input.cardId.trim() },
        ...input.slot === undefined ? {} : { slot: input.slot.trim() },
        force: typeof input.force === 'string' && input.force.trim() !== '' ? input.force.trim() : undefined,
        signal: exec.signal,
      })
      return {
        childId: record.childId,
        name: record.name,
        status: 'spawned',
        ...record.permission === undefined ? {} : { permission: record.permission },
      }
    },
  }
}
