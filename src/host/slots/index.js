/**
 * 角色槽位在提示词中的注入点。
 *
 * 注入走**运行时上下文**通道（`systemPrompt.context`），不走系统提示词的 section
 * 通道。两者的生效时机不同：
 *
 * - `systemPrompt.section()` 注册的段进的是**系统提示词消息**。那条消息是会话级
 *   固定的——只在请求序列重启时重新投影（`packages/core/agent-loop/src/agent.ts:407-425`）。
 *   槽位配置改了、工具也没变，消息不会重写；会话建立前注册的段更是永远读不到。
 * - 运行时上下文每轮组装时重新求值 provider（`packages/core/system-prompt/src/index.ts:582-602`），
 *   快照有变化才作为一条 user 消息追加。「槽位配置变更在下一轮 turn 生效」因此是
 *   结构性的，不需要额外的刷新机制。
 *
 * 上下文必须**注册成 provider**，不能只在组装事件里临时 push：`refreshContext`
 * 会按注册表重新求值上下文，注册表里没有的临时项在抑制运行时的场景下会被丢弃
 * （`packages/core/system-prompt/src/index.ts:591`）。声明 `required` 则让它在
 * 可选运行时被关掉的情况下仍然保留。
 *
 * @module dsh-leader-kit/host/slots
 */

import { renderRoleContext } from './role-context.js'

/** 注入项的上下文名。 */
export const ROLE_CONTEXT_NAME = 'dsh-leader-kit:role-slot'

/**
 * 注入项在运行时上下文里的位置。紧跟工作目录（100）之后：两者同属「我是谁、
 * 我在哪」这一类事实，排在沙箱与审批策略之前。
 */
export const ROLE_CONTEXT_ORDER = 105

/**
 * 注册角色槽位注入。
 *
 * @param {object} options - 选项
 * @param {object} options.ctx - Cordis 上下文
 * @param {Map<string, string>} options.slotIndex - 会话 id 到槽位名的反查索引
 * @param {((sessionId: string) => string | undefined)} options.resolveDirectory - 取会话所属项目目录
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {void}
 */
export function applyRoleContext({ ctx, slotIndex, resolveDirectory, logger = () => {} }) {
  ctx.effect(() => ctx.systemPrompt.context({
    name: ROLE_CONTEXT_NAME,
    order: ROLE_CONTEXT_ORDER,
    // 槽位正文是项目里可编辑的 Markdown，可能含 `{{`——插值会把它当变量引用
    // 而报错。上下文一律按字面量处理。
    interpolate: false,
    // 运行时会关掉可选上下文；声明必需，保证槽位不被关掉。
    required: true,
    text: (context) => {
      const sessionId = context.agent?.id
      if (typeof sessionId !== 'string') return ''
      try {
        return renderRoleContext({
          sessionId,
          slotIndex,
          // 目录优先取项目目录——手册属于项目，不属于会话。协调者会话的项目目录
          // 由项目注册表反查得到；worker 的会话头 cwd 就是项目目录（派工时强制）。
          // 都不命中时回落会话自己的目录。
          resolveDirectory: (id) => resolveDirectory(id)
            ?? context.agent?.session?.header?.cwd,
        })
      } catch (error) {
        // 求值失败会让整个 turn 崩掉。槽位是增量信息，取不到就当没有这个槽位。
        logger(`dsh-leader-kit: 渲染角色槽位失败：${error instanceof Error ? error.message : String(error)}`)
        return ''
      }
    },
  }), 'dsh-leader-kit 角色槽位注入')
}
