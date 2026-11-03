/**
 * leader 手册在提示词中的注入点。
 *
 * 与角色槽位（`slots/`）对称：槽位由卡片绑定决定，leader 手册由**身份**决定——
 * 项目的 leader 会话天然就是这个项目的 leader，不需要任何绑定。手册放在项目目录
 * 根的 `LEADER.md`，每轮 turn 重新读取。
 *
 * 注入走运行时上下文（`systemPrompt.context`）而非 section，理由见 `slots/index.js`
 * 的头注释：section 进的是会话级固定的系统提示词消息，文件改了不会重写；运行时
 * 上下文每轮重新求值，「改动在下一轮 turn 生效」因此是结构性的。
 *
 * @module dsh-leader-kit/host/leader-context
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** leader 手册文件名，位于项目目录下。 */
export const LEADER_CONTEXT_FILE = 'LEADER.md'

/** 注入项的上下文名。 */
export const LEADER_CONTEXT_NAME = 'dsh-leader-kit:leader'

/**
 * 注入项在运行时上下文里的位置。
 *
 * 排在角色槽位（105）之前：leader 手册说的是「谁在指挥这个项目」，属于身份事实，
 * 先于「我这次承担哪个角色」。
 */
export const LEADER_CONTEXT_ORDER = 104

/**
 * 读项目目录下的 leader 手册。
 *
 * 返回空串，不让整个插件报错，也不注入一段空壳标题——手册是增量信息，不是必需品。
 * 但两种空要分开：文件缺失（ENOENT）是常态，静默；其他读失败（EISDIR、EACCES、
 * 磁盘 I/O）要留日志，否则用户改了手册却看不到生效时无从排查。
 *
 * @param {string | undefined} directory - 项目目录绝对路径
 * @param {(message: string) => void} [logger] - 日志输出
 * @returns {string} 手册正文；没有时为空串
 */
export function loadLeaderManual(directory, logger = () => {}) {
  if (typeof directory !== 'string' || directory === '') return ''
  const file = join(directory, LEADER_CONTEXT_FILE)
  let content
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger(`dsh-leader-kit: 读取 leader 手册失败（${file}）：${error instanceof Error ? error.message : String(error)}`)
    }
    return ''
  }
  return content.trim()
}

/**
 * 渲染 leader 的手册上下文。
 *
 * @param {object} options - 选项
 * @param {string | undefined} options.sessionId - 会话 id
 * @param {(sessionId: string) => string | undefined} options.resolveDirectory - 取会话所属项目目录；
 *   只有该项目的 leader 会话才有值，普通会话与 worker 返回 undefined
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {string} 上下文文本；不是 leader、目录不可得或手册为空时为空串
 */
export function renderLeaderContext({ sessionId, resolveDirectory, logger = () => {} }) {
  if (typeof sessionId !== 'string' || sessionId === '') return ''
  const directory = resolveDirectory(sessionId)
  const body = loadLeaderManual(directory, logger)
  if (body === '') return ''
  return [
    '## leader 手册',
    '',
    `你是项目 ${directory} 的 leader。以下是该项目在 \`${LEADER_CONTEXT_FILE}\` 中为 leader 写下的工作方法。`,
    '',
    body,
  ].join('\n')
}

/**
 * 注册 leader 手册注入。
 *
 * @param {object} options - 选项
 * @param {object} options.ctx - Cordis 上下文
 * @param {(sessionId: string) => string | undefined} options.resolveDirectory - 取 leader 会话的项目目录
 * @param {(message: string) => void} [options.logger] - 日志输出
 * @returns {void}
 */
export function applyLeaderContext({ ctx, resolveDirectory, logger = () => {} }) {
  ctx.effect(() => ctx.systemPrompt.context({
    name: LEADER_CONTEXT_NAME,
    order: LEADER_CONTEXT_ORDER,
    // 手册是项目里可编辑的 Markdown，可能含 `{{`——按字面量处理，不做插值。
    interpolate: false,
    required: true,
    text: (context) => {
      const sessionId = context.agent?.id
      if (typeof sessionId !== 'string') return ''
      try {
        return renderLeaderContext({ sessionId, resolveDirectory, logger })
      } catch (error) {
        // 求值失败会让整个 turn 崩掉。手册是增量信息，取不到就当没有。
        logger(`dsh-leader-kit: 渲染 leader 手册失败：${error instanceof Error ? error.message : String(error)}`)
        return ''
      }
    },
  }), 'dsh-leader-kit leader 手册注入')
}
